// 在线检查官方任务表（conf/Angel.config），把新上架的章节补进本地目录。
//
// 为什么只处理"新"的：官方老数据里有一堆脏活（主题错挂、任务桶、缺正文、
// 2010–2012 的剧本只存在 Flash .ats 里），这些仍然靠离线构建处理；而 2026 年
// 之后的更新是一条干净的线：Story id 连续（1088→1089→1090）、themeID 规范、
// 剧本 scripts/<id>.xml 直接可读。这里只认这条线，够用且不会把老数据搞乱。
//
// 补进来的条目会写进 IndexedDB，刷新后还在；下次重新构建数据时它们会被覆盖掉
// （因为那时已经进了 chapters.json，不重复）。

import { wrap } from "./store.js";
import { mergeStories, knownIds } from "./catalog.js";
import { addStories as addTimelineStories } from "./timeline.js";

const CONF_URL = "https://res.17roco.qq.com/conf/Angel.config";
const SCRIPT_URL = (id) => `https://res.17roco.qq.com/res/task2/scripts/${id}.xml`;
const THUMB_URL = (file) => `https://res.17roco.qq.com/res/task2/panelBG/${file}`;
const DB_NAME = "luoke-story-meta";
const TABLE = "kv";
const KEY = "extras";

/* ---------------- 持久化 ---------------- */

function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TABLE)) req.result.createObjectStore(TABLE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const g = db.transaction(TABLE, "readonly").objectStore(TABLE).get(key);
      g.onsuccess = () => res(g.result ?? null);
      g.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

async function dbSet(key, val) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(TABLE, "readwrite");
      tx.objectStore(TABLE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** 启动时读回上次在线收录的条目；目录模块拿它做合并 */
export async function loadExtras() {
  const e = await dbGet(KEY);
  if (!e || (!e.stories?.length && !e.chapters?.length)) return null;
  return e;
}

/* ---------------- 解压与解析 ---------------- */

// 头部长度不固定（dump_angel.py 里是 0–32 字节逐个试），只挑像 zlib 头的偏移试，
// 免得对着 1.4MB 乱解 33 次
function zlibHeader(b, off) {
  if (b[off] !== 0x78) return false;
  const f = b[off + 1];
  return f === 0x01 || f === 0x5e || f === 0x9c || f === 0xda;
}

async function inflateConf(buf) {
  const u8 = new Uint8Array(buf); // ArrayBuffer 不能直接下标取值，先包一层
  for (let off = 0; off < 33; off++) {
    if (!zlibHeader(u8, off)) continue;
    try {
      const stream = new Blob([u8.subarray(off)]).stream().pipeThrough(new DecompressionStream("deflate"));
      const out = await new Response(stream).arrayBuffer();
      if (out.byteLength > 100000) return new TextDecoder("utf-8").decode(out);
    } catch {
      /* 这个偏移不是 zlib 起点，换下一个 */
    }
  }
  throw new Error("官方配置解压失败（格式变了？）");
}

function attrs(text) {
  const o = {};
  for (const m of text.matchAll(/([A-Za-z_][\w:-]*)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

function between(text, open, close) {
  const i = text.indexOf(open);
  if (i < 0) return "";
  const j = text.indexOf(close, i);
  return j < 0 ? text.slice(i) : text.slice(i, j);
}

function tidy(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// newUntilTime="11/19/2026" → "2026-11-19"
function parseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function parseConf(text) {
  const themes = new Map();
  for (const m of between(text, "<ThemeList>", "</ThemeList>").matchAll(/<Theme\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.id) themes.set(a.id, tidy(a.name));
  }
  const tasks = new Map();
  for (const m of between(text, "<TaskList>", "</TaskList>").matchAll(/<Task\b([^>]*?)>/g)) {
    const a = attrs(m[1]);
    if (a.id) tasks.set(a.id, tidy(a.name));
  }
  const stories = [];
  for (const m of between(text, "<StoryList>", "</StoryList>").matchAll(/<Story\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (!a.id) continue;
    stories.push({
      id: a.id,
      name: tidy(a.name),
      themeId: a.themeID || "",
      subs: (a.subIDs || "").split(",").map((x) => x.trim()).filter(Boolean),
      type: a.type || "",
      outline: tidy(a.outline),
      date: parseDate(a.newUntilTime),
      isNew: a.isNew === "true",
    });
  }
  return { stories, themes, tasks };
}

/* ---------------- 探测剧本与海报 ---------------- */

// 档案列表的缩略图：res/task2/panelBG/<id>.jpg。有它时间轴才会显示这张海报
async function probeThumb(id) {
  const file = `${id}.jpg`;
  try {
    const r = await fetch(wrap(THUMB_URL(file)), { cache: "no-store" });
    const type = r.headers.get("content-type") || "";
    const len = Number(r.headers.get("content-length") || 0);
    if (r.ok && type.startsWith("image/") && (len === 0 || len > 2000)) return file;
  } catch {
    /* 没有就当没海报 */
  }
  return "";
}

async function probeScript(id) {
  const r = await fetch(wrap(SCRIPT_URL(id)), { cache: "no-store" });
  if (!r.ok) return { ok: false, why: `${r.status}` };
  const xml = await r.text();
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.tagName !== "Story") return { ok: false, why: "不是剧本 XML" };
  const tasks = [...root.getElementsByTagName("Task")].map((t) => ({
    id: t.getAttribute("id") || "",
    label: t.getAttribute("label") || "",
  }));
  const dialogs = [...root.getElementsByTagName("Dialog")];
  const lines = dialogs.filter((d) => (d.textContent || "").trim()).length;
  const chars = dialogs.reduce((n, d) => n + (d.textContent || "").trim().length, 0);
  return {
    ok: true,
    label: root.getAttribute("label") || "",
    tasks,
    lines,
    chars,
    size: Number(r.headers.get("content-length") || 0) || xml.length,
  };
}

/* ---------------- 已知基线 ---------------- */

// data/known_stories.json 是构建时从官方 StoryList 抄下来的全量 id。
// 有了它，"新"就等于"官方表里有、基线里没有"，不会把当年刻意剔掉的条目
// （比如 1341 儿童节的来源）或老数据里的漏网条目（7044）每次重新报一遍。
let baselineIds = null;
async function loadBaseline() {
  if (baselineIds) return baselineIds;
  try {
    const raw = await fetch("data/known_stories.json", { cache: "no-cache" }).then((r) => r.json());
    const list = Array.isArray(raw) ? raw : raw.ids || [];
    baselineIds = new Set(list.map(String));
  } catch {
    baselineIds = new Set();
  }
  return baselineIds;
}

/* ---------------- 主流程 ---------------- */

/**
 * 拉官方任务表，跟本地目录比对，把没见过的章节补进来。
 * @returns {Promise<{checked:number, total:number, added:number, items:Array, themes:Array}>}
 */
export async function checkUpdates() {
  const res = await fetch(wrap(CONF_URL), { cache: "no-store" });
  if (!res.ok) throw new Error(`拿不到官方任务表（HTTP ${res.status}）`);
  const text = await inflateConf(await res.arrayBuffer());
  const conf = parseConf(text);
  if (!conf.stories.length) throw new Error("官方任务表里没解析出故事条目");

  const extras = (await dbGet(KEY)) || { stories: [], chapters: [], seen: [] };
  const local = knownIds();
  const baseline = await loadBaseline();
  const seen = new Set([
    ...(extras.seen || []),
    ...local.storyIds,
    ...local.chapterIds,
    ...baseline,
  ]);

  // 20000 以上是任务档案（id 就是任务号），不是章节；顺带跳过已知的
  const fresh = conf.stories.filter((s) => Number(s.id) < 20000 && !seen.has(String(s.id)));

  const items = [];
  const chapters = [];
  const stories = [];
  const covers = {}; // 新海报：{ 故事id: panelBG 文件名 }
  for (const s of fresh) {
    const theme = conf.themes.get(s.themeId) || "";
    const p = await probeScript(s.id);
    const label = p.ok ? p.label || s.name : s.name;
    // 只有能播的才去探海报：时间轴上点了要能进去，缺正文的条目放上去只会点出提示
    const thumb = p.ok ? await probeThumb(s.id) : "";
    if (p.ok && thumb) covers[s.id] = thumb;
    if (p.ok) {
      chapters.push({
        id: Number(s.id),
        label,
        taskId: p.tasks[0]?.id || s.subs[0] || "",
        tasks: p.tasks,
        lines: p.lines,
        chars: p.chars,
        size: p.size,
      });
    }
    stories.push({
      id: s.id,
      name: s.name,
      outline: s.outline,
      date: s.date,
      themeId: s.themeId,
      theme,
      chapters: p.ok ? [Number(s.id)] : [],
    });
    items.push({
      id: Number(s.id),
      name: s.name,
      label,
      theme,
      themeId: s.themeId,
      date: s.date,
      lines: p.lines || 0,
      playable: p.ok,
      poster: !!thumb,
      why: p.ok ? "" : `剧本取不到（${p.why}）`,
    });
  }

  // 记下这一轮见到的所有 id，避免官方下架/我们主动删除的条目每次都当"新章节"报出来
  const allIds = conf.stories.filter((s) => Number(s.id) < 20000).map((s) => String(s.id));
  await dbSet(KEY, {
    stories: [...(extras.stories || []), ...stories],
    chapters: [...(extras.chapters || []), ...chapters],
    covers: { ...(extras.covers || {}), ...covers },
    seen: [...new Set([...(extras.seen || []), ...allIds])],
    savedAt: Date.now(),
  });

  let added = 0;
  const themes = [];
  if (stories.length) {
    const r = mergeStories({ stories, chapters });
    // 时间轴那套数据是独立加载的，这里同步补进去（含缩略图映射）
    addTimelineStories({ stories, covers });
    added = r.addSt;
    for (const t of r.touched) {
      const nm = conf.themes.get(t) || "";
      if (!themes.includes(nm)) themes.push(nm);
    }
  }

  return {
    checked: fresh.length,
    total: conf.stories.filter((s) => Number(s.id) < 20000).length,
    added,
    items,
    themes,
  };
}
