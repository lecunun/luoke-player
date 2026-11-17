// 左侧目录：篇章 → 故事 两级（故事行挂官方梗概），支持正序/倒序、搜索、折叠

let all = [];      // 章节（剧情脚本 + 任务剧本），给 上一章/下一章/标题 用
let taskChapters = new Set();  // 任务类故事占用的章节：保留可点开，但不进 上一章/下一章 的顺序
let tree = { groups: [], orphan: [] };
const ACT_THEME = "ACT";
let order = localStorage.getItem("lr.order") || "desc"; // 默认倒序：最新在前
let keyword = "";
let currentId = null;
let handlers = {};
let folded = new Set(JSON.parse(localStorage.getItem("lr.folded") || "[]"));

export async function initCatalog(h) {
  handlers = h || {};
  const list = document.querySelector("#cat-list");
  try {
    const [a, b] = await Promise.all([
      fetch("data/chapters.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/catalog_tree.json", { cache: "no-cache" }).then((r) => r.json()),
    ]);
    all = a;
    tree = b;
    // 默认全部收起（含日期块）。老用户存过 lr.folded，也要按新默认走一次，用版本号迁移
    if (localStorage.getItem("lr.foldv") !== "3") {
      folded = new Set(allKeys());
      localStorage.setItem("lr.folded", JSON.stringify([...folded]));
      localStorage.setItem("lr.foldv", "3");
    }
    taskChapters = new Set(
      tree.groups.flatMap((g) => g.stories.filter((s) => s.kind === "task").flatMap((s) => s.chapters)),
    );
  } catch (e) {
    list.innerHTML = `<div style="padding:18px;color:#9a8464">目录加载失败：${e.message}</div>`;
    return;
  }

  const tl = tree.timeline || [];
  const storyCount =
    tree.groups.reduce((n, g) => n + g.stories.filter((s) => s.kind !== "task").length, 0) +
    tl.filter((e) => e.kind !== "task").length;
  document.querySelector("#cat-count").textContent = `${storyCount} 个故事`;
  document.querySelector("#btn-order").textContent = order === "desc" ? "倒序" : "正序";
  document.querySelector("#btn-order").classList.toggle("on", order === "desc");

  document.querySelector("#cat-search").addEventListener("input", (e) => {
    keyword = e.target.value.trim().toLowerCase();
    render();
  });
  const foldBtn = document.querySelector("#btn-fold");
  foldBtn.addEventListener("click", () => {
    const all = allKeys();
    const shut = all.length > 0 && all.every((k) => folded.has(k));
    folded = shut ? new Set() : new Set(all);
    localStorage.setItem("lr.folded", JSON.stringify([...folded]));
    syncFoldBtn();
    render();
  });
  syncFoldBtn();
  document.querySelector("#btn-order").addEventListener("click", () => {
    order = order === "desc" ? "asc" : "desc";
    localStorage.setItem("lr.order", order);
    const b = document.querySelector("#btn-order");
    b.textContent = order === "desc" ? "倒序" : "正序";
    b.classList.toggle("on", order === "desc");
    render();
  });

  render();
}

// 章节 id → 名字，用于搜索和标题
const labelOf = (id) => (all.find((c) => c.id === id) || {}).label || "";

// 收起/展开按钮的状态：全收起时提示"展开"，否则提示"收起"
function syncFoldBtn() {
  const btn = document.querySelector("#btn-fold");
  if (!btn) return;
  const all = allKeys();
  const shut = all.length > 0 && all.every((k) => folded.has(k));
  btn.textContent = shut ? "展开" : "收起";
  btn.title = shut ? "全部展开栏目" : "全部收起栏目";
  btn.classList.toggle("on", !shut);
}

// 所有可折叠单元：篇章（themeId）+ 日期块（date:YYYY-MM-DD）
function allKeys() {
  const keys = tree.groups.map((g) => g.themeId);
  for (const e of tree.timeline || []) keys.push("date:" + e.date);
  return keys;
}

function matchEntry(e) {
  if (!keyword) return true;
  const hay = `${e.name} ${e.date || ""} ${e.id} ${(e.chapters || []).map((c) => `${c} ${labelOf(c)}`).join(" ")}`;
  return hay.toLowerCase().includes(keyword);
}

function matchStory(s) {
  if (!keyword) return true;
  const hay = `${s.name} ${s.kind === "task" ? "任务" : ""} ${s.outline || ""} ${s.id} ${s.chapters.map((c) => `${c} ${labelOf(c)}`).join(" ")}`;
  return hay.toLowerCase().includes(keyword);
}

function storyRow(s, { withDate = false } = {}) {
  const gone = !s.chapters.length;
  const isTask = s.kind === "task";
  const row = document.createElement("button");
  row.className = "story-row" + (gone ? " gone" : "") + (withDate ? " tl-entry" : "");
  row.dataset.story = s.id;
  row.dataset.chapters = (s.chapters || []).join(",");
  const first = s.chapters[0];
  row.innerHTML =
    `<span class="sline">` +
    (withDate && s.date ? `<span class="sdate">${esc(s.date)}</span>` : "") +
    `<span class="sname">${esc(s.name)}</span>` +
    (isTask || gone
      ? `<span class="scount${isTask ? " task" : ""}">${isTask ? "任务" : "缺正文"}</span>`
      : "") +
    `</span>` +
    (s.outline ? `<span class="sout">${esc(s.outline)}</span>` : "");
  row.title = gone
    ? `${s.name}：官方已下架这一节的剧本，只保留官方提示卡`
    : `${s.name}（${s.chapters.length} 章）· 点开从第 ${first} 章开始`;
  row.addEventListener("click", () => {
    if (gone) {
      handlers.onInfo?.(
        isTask
          ? `「${s.name}」是任务档案条目，收录时没找到对应脚本`
          : `「${s.name}」的剧本已下架，只剩官方提示卡`,
      );
      return;
    }
    setActive(first);
    handlers.onPickChapter?.(first);
  });
  return row;
}

function render() {
  const list = document.querySelector("#cat-list");
  const frag = document.createDocumentFragment();
  // 搜索命中篇章名时，整篇的故事都留下（否则会显示成"0 个故事"的空壳）
  const filteredGroups = tree.groups
    .map((g) => ({
      ...g,
      stories: keyword && g.theme.toLowerCase().includes(keyword) ? g.stories : g.stories.filter(matchStory),
    }))
    .filter((g) => g.stories.length || (keyword && g.theme.toLowerCase().includes(keyword)));
  const tl = (tree.timeline || []).filter(matchEntry);

  // 篇章 + 时间轴条目排在同一条时间线上：按日期升/降序，
  // 没有日期的（《》）永远沉到最后。同一天里篇章在前、条目在后。
  // 同一天的条目并成一个日期块，免得 136 条挤成一屏
  const byDate = new Map();
  for (const e of tl) {
    const d = e.date || "";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  }
  const units = [
    ...filteredGroups.map((g) => ({ type: "g", date: g.date || "", g, seq: g.seq ?? 9999 })),
    ...[...byDate.entries()].map(([date, entries]) => ({
      type: "d",
      date,
      entries,
      seq: entries.reduce((m, e) => Math.min(m, e.seq ?? 9999), 9999),
    })),
  ];
  // 顺序由后端的 seq 决定（它已经按日期排过、又按定稿做过整段搬运），
  // 前端不再按日期重排，否则整段搬过的顺序会被打回去。
  // 《》与《活动/日常》不参与排序：不管正序倒序，永远排在最后
  const pinned = units.filter((u) => u.type === "g" && (u.g.themeId === "" || u.g.themeId === ACT_THEME));
  const sortable = units.filter((u) => !(u.type === "g" && (u.g.themeId === "" || u.g.themeId === ACT_THEME)));
  sortable.sort((a, b) => a.seq - b.seq || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (order === "desc") sortable.reverse();
  const seq = [...sortable, ...pinned];

  for (const u of seq) {
    if (u.type === "d") {
      const box = document.createElement("div");
      box.className = "tgroup tl";
      const key = "date:" + u.date;
      const openD = !!keyword || !folded.has(key);
      // 只写真实存在的类型：整块都是任务时不再显示「0 个故事」，看着像空壳
      const metaD = `${u.entries.length} 条`;
      const head = document.createElement("button");
      head.className = "theme-head date-head" + (openD ? "" : " collapsed");
      head.innerHTML =
        `<span class="tname">${esc(u.date || "未定时间")}</span>` +
        `<span class="tmeta">${metaD}</span>` +
        `<span class="caret">${openD ? "▾" : "▸"}</span>`;
      head.addEventListener("click", () => {
        if (folded.has(key)) folded.delete(key);
        else folded.add(key);
        localStorage.setItem("lr.folded", JSON.stringify([...folded]));
        render();
      });
      box.appendChild(head);
      if (openD) {
        const wrap = document.createElement("div");
        wrap.className = "tstories";
        for (const e of u.entries) wrap.appendChild(storyRow(e, { withDate: false }));
        box.appendChild(wrap);
      }
      frag.appendChild(box);
      continue;
    }
    const g = u.g;
    const box = document.createElement("div");
    box.className = "tgroup" + (g.mini ? " mini" : "");
    const open = !!keyword || !folded.has(g.themeId);
    const nStory = g.stories.filter((x) => x.kind !== "task").length;
    const noSort = g.themeId === "" || g.themeId === ACT_THEME;

    const head = document.createElement("button");
    head.className = "theme-head" + (g.mini ? " mini-head" : "") + (open ? "" : " collapsed");
    head.innerHTML =
      `<span class="tname">${g.theme ? "《" + esc(g.theme) + "》" : "《》"}</span>` +
      `<span class="tmeta">${nStory} 个故事${noSort ? `<span class="tnosort">不排序</span>` : ""}</span>` +
      `<span class="caret">${open ? "▾" : "▸"}</span>`;
    head.addEventListener("click", () => {
      if (folded.has(g.themeId)) folded.delete(g.themeId);
      else folded.add(g.themeId);
      localStorage.setItem("lr.folded", JSON.stringify([...folded]));
      render();
    });
    box.appendChild(head);

    if (open) {
      const wrap = document.createElement("div");
      wrap.className = "tstories";
      for (const st of g.stories) wrap.appendChild(storyRow(st));
      box.appendChild(wrap);
    }
    frag.appendChild(box);
  }

  list.innerHTML = "";
  if (!seq.length) {
    list.innerHTML = `<div style="padding:18px;color:#9a8464">没有匹配的故事</div>`;
    return;
  }
  list.appendChild(frag);
  markActive();
  syncFoldBtn();
}

/* 当前章节落在哪个故事里，就把那条故事点亮 */
function markActive() {
  document.querySelectorAll(".story-row").forEach((el) => {
    const ids = (el.dataset.chapters || "").split(",");
    el.classList.toggle("active", ids.includes(String(currentId)));
  });
}

export function nextChapterId(id) {
  const ids = all.filter((c) => !taskChapters.has(c.id)).map((c) => c.id).sort((a, b) => a - b);
  const i = ids.indexOf(Number(id));
  if (i < 0) return null;
  return i + 1 < ids.length ? ids[i + 1] : null;
}

export function prevChapterId(id) {
  const ids = all.filter((c) => !taskChapters.has(c.id)).map((c) => c.id).sort((a, b) => a - b);
  const i = ids.indexOf(Number(id));
  if (i <= 0) return null;
  return ids[i - 1];
}

export function chapterLabel(id) {
  const c = all.find((x) => x.id === Number(id));
  return c ? c.label : "";
}

export function chapterCount() {
  return all.length;
}

export function setActive(id) {
  currentId = id;
  // 所属篇章要是折着的，先展开再点亮
  const g = tree.groups.find((x) => x.stories.some((s) => s.chapters.includes(Number(id))));
  if (g && folded.has(g.themeId)) {
    folded.delete(g.themeId);
    localStorage.setItem("lr.folded", JSON.stringify([...folded]));
    render();
  } else {
    markActive();
  }
  const el = [...document.querySelectorAll(".story-row")].find((e) =>
    (e.dataset.chapters || "").split(",").includes(String(id)),
  );
  el?.scrollIntoView({ block: "nearest" });
}

export function toggleSidebar(force) {
  const s = document.querySelector("#sidebar");
  const hide = force ?? !s.classList.contains("hidden");
  s.classList.toggle("hidden", hide);
  localStorage.setItem("lr.sideHidden", hide ? "1" : "0");
  return !hide;
}

export function restoreSidebar() {
  if (localStorage.getItem("lr.sideHidden") === "1") {
    document.querySelector("#sidebar").classList.add("hidden");
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
}
