// 地图库：浏览游戏里的全部场景（含入口已关闭的），点开就能看，并播该地图的背景音乐。
// 数据来自官方 conf/Angel.config 的 scene_conf（694 个场景 ID）与剧本扫描出的出现章节索引。
//
// 同一个 ID 可能有多个版本（官方配置里同 id 有多条 SceneDes，靠 sceneVer 区分；
// 商店街、王国城堡这些改过版的，旧版资源仍在 res/scene/<id>/，新版在 res/scene/<id>.<N>/）。
// 所以卡片是按 ID 归并的，下面挂一排版本按钮：点主卡进最新版，点某个版本进那一版。
import * as store from "./store.js";

let all = []; // {id, name, bgm, versions:[{ver,name,bgm,chapters}], count, multi}
let keyword = "";
let onlyStory = false;
let onPick = null;

let rawScenes = {};
let rawUsage = {};

// 从 scenes.json 的原始结构算出卡片数组（多版本归并成一张卡）
function rebuildAll() {
  all = Object.entries(rawScenes).map(([id, v]) => {
    const use = rawUsage[id] || {};
    const versions = (v.versions || [{ ver: 1, name: v.name, bgm: v.bgm }]).map((x) => ({
      ...x,
      chapters: use[String(x.ver)] || [],
    }));
    const chapters = [...new Set(versions.flatMap((x) => x.chapters))];
    return {
      id,
      name: v.name || `场景 ${id}`,
      bgm: v.bgm || '',
      amb: v.amb || '',
      maxVer: v.maxVer || 1,
      versions,
      multi: versions.length > 1,
      chapters,
      count: chapters.length,
    };
  });
  all.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  const multiCount = all.filter((m) => m.multi).length;
  const el = document.querySelector('#map-count');
  if (el) {
    el.textContent =
      `${all.length} 张地图 · ${all.filter((m) => m.count).length} 张在剧情里出现` +
      (multiCount ? ` · ${multiCount} 张有多个版本` : '');
  }
}

export async function initMapView(pick, extraScenes) {
  onPick = pick;
  const grid = document.querySelector('#map-grid');
  try {
    const [scenes, usage] = await Promise.all([
      fetch('data/scenes.json').then((r) => r.json()),
      fetch('data/scene_usage.json').then((r) => r.json()).catch(() => ({})),
    ]);
    // 在线收录的新地图（updater.js 存进 IndexedDB）在这里并进来
    rawScenes = { ...scenes, ...(extraScenes || {}) };
    rawUsage = usage;
    rebuildAll();
  } catch (e) {
    grid.innerHTML = `<div class="mv-empty">地图数据加载失败：${e.message}</div>`;
    return;
  }

  document.querySelector('#map-search').addEventListener('input', (e) => {
    keyword = e.target.value.trim().toLowerCase();
    render();
  });
  document.querySelector('#map-only-story').addEventListener('change', (e) => {
    onlyStory = e.target.checked;
    render();
  });
  document.querySelector('#map-close').addEventListener('click', () => toggleMapView(false));

  render();
}

/** 在线收录到新地图后补进来（updater.js 用） */
export function addScenes(map, usage) {
  if (!map || !Object.keys(map).length) return 0;
  for (const [id, u] of Object.entries(usage || {})) rawUsage[id] = { ...(rawUsage[id] || {}), ...u };
  let n = 0;
  for (const [id, v] of Object.entries(map)) {
    if (rawScenes[id]) continue;
    rawScenes[id] = v;
    n++;
  }
  if (n) {
    rebuildAll();
    render();
  }
  return n;
}

function pick(m, ver) {
  const v = ver ?? m.maxVer;
  const hit = m.versions.find((x) => x.ver === v) || m.versions[m.versions.length - 1];
  toggleMapView(false);
  onPick?.({
    id: m.id,
    ver: v,
    name: hit?.name || m.name,
    bgm: hit?.bgm || m.bgm,
    multi: m.multi,
    count: hit?.chapters?.length || 0,
  });
}

function render() {
  const grid = document.querySelector("#map-grid");
  let arr = all;
  if (onlyStory) arr = arr.filter((m) => m.count > 0);
  if (keyword) {
    arr = arr.filter(
      (m) =>
        m.name.toLowerCase().includes(keyword) ||
        m.id.includes(keyword) ||
        String(m.bgm).toLowerCase().includes(keyword) ||
        m.versions.some((v) => v.name.toLowerCase().includes(keyword)),
    );
  }
  const frag = document.createDocumentFragment();
  for (const m of arr) {
    const card = document.createElement("div");
    card.className = "mv-card" + (m.count ? "" : " mv-plain");
    const vers = m.multi
      ? `<div class="mv-vers">${m.versions
          .map(
            (v) =>
              `<button class="mv-ver" data-ver="${v.ver}" title="${esc(v.name)}${
                v.chapters.length ? ` · ${v.chapters.length} 章` : " · 未在剧情出现"
              }"><b>v${v.ver}</b>${esc(shortVerName(v.name, m.name, v.ver === m.maxVer))}</button>`,
          )
          .join("")}</div>`
      : "";
    card.innerHTML = `
      <button class="mv-main" title="${esc(m.versions.map((v) => `v${v.ver} ${v.name}`).join("\n"))}">
        <span class="mv-name">${esc(m.name)}${m.multi ? `<em class="mv-tag">${m.versions.length} 版</em>` : ""}</span>
        <span class="mv-meta"><i>${m.id}</i>${m.count ? `· ${m.count} 章` : "· 未在剧情出现"}</span>
      </button>
      ${vers}`;
    card.querySelector(".mv-main").addEventListener("click", () => pick(m));
    for (const b of card.querySelectorAll(".mv-ver")) {
      b.addEventListener("click", () => pick(m, Number(b.dataset.ver)));
    }
    frag.appendChild(card);
  }
  grid.innerHTML = "";
  if (!arr.length) {
    grid.innerHTML = `<div class="mv-empty">没有匹配的地图</div>`;
    return;
  }
  grid.appendChild(frag);
}

// 版本按钮只留能区分的那部分：
//   「2013年4月的商店街」→「2013年4月」；「农贸集市」→「农贸集市」；与最新版同名 →「现版」
function shortVerName(name, base, isLatest) {
  const s = String(name || "");
  if (s === base) return isLatest ? "现版" : "同名版";
  const m = /^(\d{4})年(\d{1,2})月/.exec(s);
  if (m) return `${m[1]}年${Number(m[2])}月`;
  if (base && s.endsWith(base)) {
    const head = s.slice(0, -base.length).replace(/的$/, "").trim();
    if (head) return head;
  }
  return s;
}

export function toggleMapView(on) {
  const box = document.querySelector("#mapview");
  const show = on ?? box.classList.contains("hidden");
  box.classList.toggle("hidden", !show);
  document.querySelector("#stage").style.visibility = show ? "hidden" : "visible";
  return show;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
}
