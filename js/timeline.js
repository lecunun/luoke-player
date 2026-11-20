// 剧情时间轴：官方档案里带海报的故事（重要剧情）按章节倒序铺开
// 一级：篇章名（日期小章节也在这一级），越往上越新
// 二级：篇章内部的海报横向排列，顺序与目录一致
// 点海报 → 右侧详情（大图 / 故事名 / 官方梗概 / 回顾）
//
// 海报有两个来源：
//   1) res/task2/panelBG/<id>.jpg —— 档案列表里的缩略图，多数剧情有
//   2) res/task2/story/h<id>.swf —— 点开故事后的大海报卡（420×450，内嵌 JPEG）
// 只有大卡、没有缩略图的剧情（枫雪镇圣剑那几篇等），运行时从 SWF 里把 JPEG 抽出来显示，
// 不落盘、不改仓库里的资源约定。

import * as store from "./store.js";

const ACT_THEME = "ACT";
const DETAIL_OPEN_KEY = "lr.tl.detailOpen";
const SCROLL_KEY = "lr.tl.scroll";

let tree = { groups: [], timeline: [] };
let covers = {};
let cardIds = new Set();
let handlers = {};
let rows = [];
let keyword = "";
let activeId = null;
let lastPick = null;
let detailOpen = localStorage.getItem(DETAIL_OPEN_KEY) !== "0";

const $ = (s) => document.querySelector(s);
const cardCache = new Map();   // id -> Promise<objectURL>
let detailToken = 0;
let cardObserver = null;
let scrollTimer = null;

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
}

// 一个故事的海报来源：优先缩略图，其次档案里的大卡
function posterSource(s) {
  const id = String(s.id);
  if (covers[id]) return { type: "jpg", url: store.direct(`res/task2/panelBG/${covers[id]}`) };
  if (cardIds.has(id) && s.kind !== "task") return { type: "card", id };
  return null;
}

function hasPoster(s) {
  return !!posterSource(s);
}

export async function initTimeline(h = {}) {
  handlers = h || {};
  covers = h.covers || {};
  try {
    const [t, c] = await Promise.all([
      fetch("data/catalog_tree.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/story_cards.json", { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : { ids: [] }))
        .catch(() => ({ ids: [] })),
    ]);
    tree = t;
    // 只认逐张看过、确认是整幅海报的卡（verified）；其余卡片是卷轴/界面框/场景拼贴，
    // 抽出来不是海报，宁可不放。no_image 是无位图的那两张。
    cardIds = new Set((c.verified || []).map(String));
    if (h.extras) applyExtras(h.extras);
  } catch (e) {
    tree = { groups: [], timeline: [] };
    $("#tl-rows").innerHTML = `<div class="tl-empty">时间轴加载失败：${esc(e.message)}</div>`;
  }
  build();
  bind();
  render();
  // 进入播放器的首页就是时间轴
  showTimeline(true);
}

// 在线收录进来的故事与缩略图（updater.js）：并进 groups / covers 后再重建行
function applyExtras(extra) {
  if (!extra) return false;
  let changed = false;
  for (const [id, file] of Object.entries(extra.covers || {})) {
    if (file && covers[id] !== file) {
      covers[id] = file;
      changed = true;
    }
  }
  for (const s of extra.stories || []) {
    if (s.kind === "task") continue;
    const tid = String(s.themeId ?? "");
    tree.groups = tree.groups || [];
    let g = tree.groups.find((x) => String(x.themeId) === tid);
    if (!g) {
      const seq = tree.groups.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1;
      g = { themeId: tid, theme: s.theme || "", date: s.date || "", stories: [], seq };
      tree.groups.push(g);
    }
    if (g.stories.some((x) => String(x.id) === String(s.id))) continue;
    g.stories.push({
      id: s.id,
      name: s.name,
      outline: s.outline || "",
      date: s.date || "",
      kind: "story",
      chapters: (s.chapters || []).map(Number),
      status: (s.chapters || []).length ? "full" : "gone",
    });
    changed = true;
  }
  return changed;
}

/** 在线收录后补海报：covers 是 { 故事id: panelBG 文件名 } */
export function addStories(payload) {
  if (!applyExtras(payload)) return false;
  build();
  render();
  return true;
}

function build() {
  const list = [];
  for (const g of tree.groups || []) {
    const stories = (g.stories || []).filter(hasPoster);
    if (!stories.length) continue;
    list.push({
      kind: "theme",
      key: g.themeId,
      name: g.theme || "",
      date: g.date || "",
      seq: g.seq ?? 9999,
      pinned: g.themeId === "" || g.themeId === ACT_THEME,
      stories,
    });
  }
  // 日期小章节里的海报也属于重要剧情，按日期单列成行
  const byDate = new Map();
  for (const e of tree.timeline || []) {
    if (!hasPoster(e)) continue;
    const d = e.date || "";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  }
  for (const [d, entries] of byDate) {
    list.push({
      kind: "date",
      key: "date:" + d,
      name: d || "未定时间",
      date: d,
      seq: Math.min(...entries.map((e) => e.seq ?? 9999)),
      pinned: false,
      stories: entries,
    });
  }
  // 与目录的倒序一致：先按 seq 升序，再整体翻过来；《》与《活动/日常》压到底
  const sortable = list.filter((r) => !r.pinned).sort((a, b) => a.seq - b.seq);
  sortable.reverse();
  const pinned = list.filter((r) => r.pinned).sort((a, b) => a.seq - b.seq);
  rows = [...sortable, ...pinned];
}

function totalCards() {
  return rows.reduce((n, r) => n + r.stories.length, 0);
}

function match(s, row, kw) {
  const hay = `${s.name || ""} ${s.outline || ""} ${row.name || ""} ${s.date || ""} ${s.id}`;
  return hay.toLowerCase().includes(kw);
}

function render() {
  const wrap = $("#tl-rows");
  const kw = keyword.toLowerCase();
  let rowCount = 0;
  let cardCount = 0;
  const frag = document.createDocumentFragment();

  if (cardObserver) cardObserver.disconnect();

  for (const r of rows) {
    const items = kw ? r.stories.filter((s) => match(s, r, kw)) : r.stories;
    if (!items.length) continue;
    rowCount++;

    const row = document.createElement("section");
    row.className = "tl-row" + (r.kind === "date" ? " date" : "");

    const head = document.createElement("div");
    head.className = "tl-row-head";
    const title = r.kind === "date" ? esc(r.name) : `《${esc(r.name)}》`;
    head.innerHTML =
      `<div class="tn">${title}</div>` +
      `<div class="tm">${items.length} 张海报${r.pinned ? `<span class="tnosort">不排序</span>` : ""}</div>`;

    const strip = document.createElement("div");
    strip.className = "tl-strip";
    for (const s of items) {
      strip.appendChild(card(s, r));
      cardCount++;
    }
    // 竖滚轮在横向海报条上时改横向滚动，省得来回拖滚动条
    strip.addEventListener(
      "wheel",
      (e) => {
        if (!strip.scrollWidth || strip.scrollWidth <= strip.clientWidth) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );

    row.append(head, strip);
    frag.appendChild(row);
  }

  wrap.innerHTML = "";
  if (!rowCount) {
    wrap.innerHTML = `<div class="tl-empty">没有匹配的海报</div>`;
  } else {
    wrap.appendChild(frag);
  }
  $("#tl-count").textContent = kw
    ? `${rowCount} 个篇章 · ${cardCount} 条重要剧情`
    : `${rows.length} 个篇章 · ${totalCards()} 条重要剧情`;
  if (lastPick) markActive();
}

function card(s, r) {
  const b = document.createElement("button");
  b.className = "tl-card" + (String(activeId) === String(s.id) ? " active" : "");
  b.dataset.id = s.id;
  const src = posterSource(s);
  const inner = src?.type === "jpg" ? `<img loading="lazy" decoding="async" src="${src.url}" alt="">` : "";
  b.innerHTML = `<span class="ph">${inner}</span>` + `<span class="cn">${esc(s.name)}</span>`;
  b.title = `${s.name}${s.date ? " · " + s.date : ""}`;
  const img = b.querySelector("img");
  if (img) {
    img.addEventListener("error", () => {
      b.classList.add("broken");
      img.remove();
    });
  }
  if (src?.type === "card") {
    b.classList.add("pending");
    b.dataset.card = s.id;
    cardObserver?.observe(b); // 卡片进视野才去拉 SWF 抽图
  }
  b.addEventListener("click", () => openDetail(s, r));
  return b;
}

// 大卡（story/h<id>.swf）→ JPEG：先解压 CWS，再按 tag 找 DefineBitsJPEG2/3/4
async function swfPoster(id) {
  const url = store.wrap(`https://res.17roco.qq.com/res/task2/story/h${id}.swf`);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  const jpg = await jpegFromSwf(buf);
  if (!jpg || jpg.length < 200) throw new Error("没有找到内嵌 JPEG");
  return URL.createObjectURL(new Blob([jpg], { type: "image/jpeg" }));
}

async function jpegFromSwf(buf) {
  const sig = String.fromCharCode(buf[0], buf[1], buf[2]);
  let body;
  if (sig === "CWS") {
    if (typeof DecompressionStream === "undefined") throw new Error("浏览器不支持解压");
    const stream = new Blob([buf.subarray(8)]).stream().pipeThrough(new DecompressionStream("deflate"));
    body = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (sig === "FWS") {
    body = buf.subarray(8);
  } else {
    throw new Error("不支持的 SWF 压缩");
  }
  // 头：RECT(nbits) + 帧率(2) + 帧数(2)
  const nbits = body[0] >> 3;
  let p = Math.ceil((5 + 4 * nbits) / 8) + 4;
  const u32 = (i) => body[i] | (body[i + 1] << 8) | (body[i + 2] << 16) | (body[i + 3] << 24);
  while (p + 2 <= body.length) {
    const cl = body[p] | (body[p + 1] << 8);
    p += 2;
    const code = cl >> 6;
    let len = cl & 0x3f;
    if (len === 0x3f) {
      if (p + 4 > body.length) break;
      len = u32(p) >>> 0;
      p += 4;
    }
    if (p + len > body.length) break;
    if (code === 6) {
      // DefineBits：CharacterID + JPEG（老卡，没有独立的 JPEGTables）
      return body.slice(p + 2, p + len);
    }
    if (code === 21) {
      // DefineBitsJPEG2：CharacterID + JPEG
      return body.slice(p + 2, p + len);
    }
    if (code === 35) {
      // DefineBitsJPEG3：CharacterID + AlphaDataOffset + JPEG + 透明通道
      const alpha = u32(p + 2) >>> 0;
      return body.slice(p + 6, p + 6 + alpha);
    }
    if (code === 90) {
      // DefineBitsJPEG4：多了 2 字节 DeblockParam
      const alpha = u32(p + 2) >>> 0;
      return body.slice(p + 8, p + 8 + alpha);
    }
    if (code === 0) break;
    p += len;
  }
  return null;
}

function cardImage(id) {
  const key = String(id);
  if (!cardCache.has(key)) {
    const p = swfPoster(key).catch((e) => {
      cardCache.delete(key);
      throw e;
    });
    cardCache.set(key, p);
  }
  return cardCache.get(key);
}

async function hydrate(el) {
  const id = el.dataset.card;
  if (!id) return;
  try {
    const url = await cardImage(id);
    if (!el.isConnected) return;
    const ph = el.querySelector(".ph");
    if (!ph || ph.querySelector("img")) return;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.alt = "";
    ph.appendChild(img);
    el.classList.remove("pending");
    // 详情正停在这一条上时，顺手把大图接上
    if (lastPick && String(lastPick.id) === String(id)) applyDetailImage(lastPick);
  } catch {
    el.classList.remove("pending");
    el.classList.add("broken");
  }
}

function markActive() {
  document.querySelectorAll(".tl-card.active").forEach((el) => el.classList.remove("active"));
  if (!lastPick) return;
  const el = document.querySelector(`.tl-card[data-id="${lastPick.id}"]`);
  if (el) el.classList.add("active");
}

function applyDetailImage(s) {
  const img = $("#tl-detail-img");
  const box = img.parentElement;
  const token = ++detailToken;
  const src = posterSource(s);
  img.classList.add("hidden");
  box.classList.remove("loading", "noimg");
  if (!src) {
    img.removeAttribute("src");
    box.classList.add("noimg");
    return;
  }
  if (src.type === "jpg") {
    img.src = src.url;
    img.classList.remove("hidden");
    return;
  }
  box.classList.add("loading");
  cardImage(src.id)
    .then((url) => {
      if (token !== detailToken) return;
      img.src = url;
      img.classList.remove("hidden");
    })
    .catch(() => {
      if (token === detailToken) box.classList.add("noimg");
    })
    .finally(() => {
      if (token === detailToken) box.classList.remove("loading");
    });
}

function openDetail(s, r) {
  lastPick = s;
  activeId = s.id;
  markActive();

  applyDetailImage(s);
  $("#tl-detail-img").alt = s.name || "";

  const where = r.kind === "date" ? r.name : `《${r.name}》`;
  $("#tl-detail-theme").textContent = where + (s.date ? ` · ${s.date}` : "");
  $("#tl-detail-name").textContent = s.name || "";
  $("#tl-detail-outline").textContent = (s.outline || "").trim() || "官方没有留下这一篇的梗概。";

  const go = $("#tl-detail-go");
  const has = (s.chapters || []).length > 0;
  go.disabled = !has;
  go.textContent = has ? "回顾" : "缺正文";
  go.title = has ? `从第 ${s.chapters[0]} 章开始重看` : "这一篇的剧本已下架，只剩官方海报";

  setDetail(true);
  $("#tl-detail").scrollTop = 0;
}

function setDetail(on) {
  detailOpen = on;
  localStorage.setItem(DETAIL_OPEN_KEY, on ? "1" : "0");
  $("#tl-detail").classList.toggle("hidden", !on);
  $("#tl-detail-tab").classList.toggle("hidden", on || !lastPick);
  $("#tl-main").classList.toggle("no-detail", !on);
}

function bind() {
  // 记住上次看到的位置，切走再回来（包括刷新）都回到原处
  $("#tl-rows").addEventListener(
    "scroll",
    () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if ($("#timeline").classList.contains("hidden")) return;
        localStorage.setItem(SCROLL_KEY, String($("#tl-rows").scrollTop | 0));
      }, 120);
    },
    { passive: true },
  );

  cardObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cardObserver.unobserve(e.target);
        hydrate(e.target);
      }
    },
    { root: $("#tl-rows"), rootMargin: "600px 0px" },
  );

  $("#tl-search").addEventListener("input", (e) => {
    keyword = e.target.value.trim();
    render();
  });
  $("#tl-close").addEventListener("click", () => showTimeline(false));
  $("#tl-detail-hide").addEventListener("click", () => setDetail(false));
  $("#tl-detail-tab").addEventListener("click", () => setDetail(true));
  $("#tl-detail-img").addEventListener("error", () => $("#tl-detail-img").classList.add("hidden"));

  $("#tl-detail-go").addEventListener("click", () => {
    const s = lastPick;
    if (!s) return;
    const id = (s.chapters || [])[0];
    if (!id) return;
    handlers.onPickChapter?.(id, s);
    showTimeline(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#timeline").classList.contains("hidden")) return;
    if (detailOpen) setDetail(false);
    else showTimeline(false);
  });

  setDetail(detailOpen && !!lastPick);
}

export function showTimeline(on) {
  const box = $("#timeline");
  const want = on == null ? box.classList.contains("hidden") : !!on;
  // 先存再隐藏：display:none 之后 scrollTop 会归零，晚一步就存成 0 了
  if (!want) {
    clearTimeout(scrollTimer);
    localStorage.setItem(SCROLL_KEY, String($("#tl-rows").scrollTop | 0));
  }
  box.classList.toggle("hidden", !want);
  const btn = $("#btn-timeline");
  if (btn) btn.classList.toggle("on", want);
  if (want) {
    if (lastPick) setDetail(detailOpen);
    const y = Math.max(0, Number(localStorage.getItem(SCROLL_KEY) || 0));
    requestAnimationFrame(() => {
      $("#tl-rows").scrollTop = y;
    });
  }
  return want;
}

export function toggleTimeline() {
  return showTimeline();
}

export function isTimelineOn() {
  return !$("#timeline").classList.contains("hidden");
}
