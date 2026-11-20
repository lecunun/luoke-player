import { Player } from "./player.js";
import * as store from "./store.js";
import { initCatalog, setActive, toggleSidebar, restoreSidebar, nextChapterId, prevChapterId, chapterLabel } from "./catalog.js";
import { renderReader, showReader } from "./reader.js";
import { initMapView, toggleMapView, addScenes } from "./mapview.js";
import { initTimeline, toggleTimeline, showTimeline } from "./timeline.js";
import { checkUpdates, loadExtras } from "./updater.js";

const $ = (s) => document.querySelector(s);
const status = $("#status");
const THEMES = ["wood", "night", "midnight", "forest"];

const player = new Player($("#app"), {
  onFinish: () => showEnd(),
});
window.__player = player;

let currentId = Number(localStorage.getItem("lr.last") || 1088);
let autoNextTimer = null;

function setStatus(t) {
  status.textContent = t;
}

/* ---------- 主题 ---------- */
function applyTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem("lr.theme", name);
}
applyTheme(localStorage.getItem("lr.theme") || "wood");

$("#btn-theme").addEventListener("click", () => {
  const cur = document.body.dataset.theme;
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  setStatus("主题：" + { wood: "木质", night: "夜色", midnight: "子夜", forest: "林间" }[next]);
});

/* ---------- 地图库 ---------- */
initMapView(async (m) => {
  // 从地图库点进来时，别让"开始"卡片盖在地图上
  $("#start-overlay").classList.add("hidden");
  player.suspendBgm(false);
  await player.showMap(m.id, m.ver);
  const tag = m.multi ? `第 ${m.ver} 版` : "";
  setStatus(
    `地图 · ${m.name}（${m.id}${m.ver > 1 ? "." + m.ver : ""}）${tag ? " · " + tag : ""}` +
      `${m.bgm ? " · " + m.bgm : ""}${m.count ? ` · 在 ${m.count} 章剧情里出现` : ""}`,
  );
  setActive(null);
});
$("#btn-mapview").addEventListener("click", () => {
  showTimeline(false);
  if (readerOn) requestReaderMode(false);
  const open = toggleMapView();
  if (open) player.suspendBgm(true);
  else player.suspendBgm(false);
});

/* ---------- 剧情时间轴 ---------- */
$("#btn-timeline").addEventListener("click", () => {
  const open = toggleTimeline();
  if (open) toggleMapView(false);
});

/* ---------- 背景音乐 ---------- */
function syncBgmBtn() {
  const b = $("#btn-bgm");
  b.textContent = "音乐 " + (player.bgmOn ? "开" : "关");
  b.classList.toggle("on", player.bgmOn);
}
syncBgmBtn();
$("#btn-bgm").addEventListener("click", () => {
  player.setBgmEnabled(!player.bgmOn);
  syncBgmBtn();
  setStatus(player.bgmOn ? "背景音乐已开启" : "背景音乐已关闭");
});

/* ---------- 过场动画内容缩放（只作用于视频类过场，见 player.playWindow 的 kind） ---------- */
const zoomEl = $("#anim-zoom");
const zoomPctEl = $("#zoom-pct");

function applyZoom(pct) {
  const v = Math.min(250, Math.max(100, Math.round(Number(pct) || 100)));
  document.documentElement.style.setProperty("--zoom", String(v / 100));
  localStorage.setItem("lr.zoom", String(v));
  zoomEl.value = String(v);
  zoomPctEl.textContent = v + "%";
}
applyZoom(localStorage.getItem("lr.zoom") || 100);
zoomEl.addEventListener("input", () => applyZoom(zoomEl.value));

function syncReaderNav() {
  const p = prevChapterId(currentId);
  const n = nextChapterId(currentId);
  $("#rd-prev").textContent = p ? `‹ 上一章 ${chapterLabel(p)}` : "‹ 已是第一章";
  $("#rd-next").textContent = n ? `下一章 ${chapterLabel(n)} ›` : "已是最后一章 ›";
  $("#rd-prev").disabled = !p;
  $("#rd-next").disabled = !n;
}

let readerOn = false;
let readerBusy = false;

/* 切换模式一律重载本章：
 * 进阅读模式先 stop() 掐断游戏协程，免得对话框/过场动画在后台继续等；
 * 回游戏模式重新 load，从头播。以前只切显隐，残留的 waiting 和 window-layer
 * 会让界面停在「半截」状态，看起来就是卡住。 */
function syncReaderBtn() {
  const b = $("#btn-reader");
  if (!b) return;
  b.textContent = readerOn ? "游戏模式" : "阅读模式";
  b.classList.toggle("on", readerOn);
  b.title = readerOn ? "切回游戏模式（本章从头播）" : "切到阅读模式（整章文本）";
}

let readerWant = null;

// 切换请求排队：忙碌时只记最后一次目标状态，处理完再补上，
// 不会因为连点或者正在载入被静默丢掉（那就是「点了没反应」）
function requestReaderMode(on) {
  readerWant = on;
  pumpReaderMode();
}

async function pumpReaderMode() {
  if (readerBusy) return;
  if (readerWant === null || readerWant === readerOn) {
    readerWant = null;
    return;
  }
  readerBusy = true;
  const target = readerWant;
  readerWant = null;
  try {
    await applyReaderMode(target);
  } finally {
    readerBusy = false;
    if (readerWant !== null && readerWant !== readerOn) pumpReaderMode();
  }
}

async function applyReaderMode(on) {
  readerOn = on;
  syncReaderBtn();
  // 不管切哪边，先把时间轴和地图收起来，避免覆盖层压在目标模式上面
  showTimeline(false);
  if (on) {
    toggleMapView(false);
    player.stop();
    showReader(true);
    $("#stage").style.visibility = "hidden";
    player.suspendBgm(true);
    await load(currentId, { start: false, renderReader: false });
    if (!readerOn || !player.story) return;
    await renderReader(player.story, { playerName: player.playerName, autoPlay: false });
    if (!readerOn) return;
    $("#reader").scrollTop = 0;
    syncReaderNav();
  } else {
    showReader(false);
    $("#stage").style.visibility = "visible";
    $("#start-overlay").classList.add("hidden"); // 已经选过模式，别再用开始卡挡住游戏
    player.suspendBgm(false);
    load(currentId);
  }
}

$("#btn-reader").addEventListener("click", () => requestReaderMode(!readerOn));
syncReaderBtn();
// 阅读模式顶部的“返回剧情”与顶栏的“游戏模式”重复，已移除；退出走顶栏按钮
$("#rd-prev").addEventListener("click", () => {
  const id = prevChapterId(currentId);
  if (id) load(id);
  else setStatus("已经是第一章了");
});
$("#rd-next").addEventListener("click", () => {
  const id = nextChapterId(currentId);
  if (id) load(id);
  else setStatus("已经是最后一章了");
});

/* ---------- 玩家名字 ---------- */
const nameInput = $("#player-name");
nameInput.value = localStorage.getItem("lr.name") || "小洛克";
nameInput.addEventListener("input", () => player.setPlayerName(nameInput.value));

/* ---------- 倍速 ---------- */
const SPEEDS = [1, 1.25, 1.5];
let speedIdx = Math.max(0, SPEEDS.indexOf(Number(localStorage.getItem("lr.speed") || 1)));
function syncSpeedBtn() {
  $("#btn-speed").textContent = SPEEDS[speedIdx].toFixed(2).replace(/0$/, "") + "×";
  $("#btn-speed").classList.toggle("on", SPEEDS[speedIdx] !== 1);
}
syncSpeedBtn();
player.setSpeed(SPEEDS[speedIdx]);
$("#btn-speed").addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  player.setSpeed(SPEEDS[speedIdx]);
  // 阅读模式里手动播的那一段也要跟着换挡
  if (window.__readerAnim) store.setTimeScale(SPEEDS[speedIdx]);
  syncSpeedBtn();
  setStatus(`动画速度 ${SPEEDS[speedIdx]}×（即时生效）`);
});

/* ---------- 打字机 ---------- */
function syncTwBtn() {
  const b = $("#btn-typewriter");
  b.textContent = "打字机 " + (player.typewriter ? "开" : "关");
  b.classList.toggle("on", player.typewriter);
}
syncTwBtn();
$("#btn-typewriter").addEventListener("click", () => {
  player.setTypewriter(!player.typewriter);
  syncTwBtn();
});

/* ---------- 侧栏 ---------- */
$("#btn-toggle-side").addEventListener("click", () => toggleSidebar());
restoreSidebar();

/* ---------- 载入 ---------- */
// 老故事（55–218）的剧本是离线还原的 data/ats/<id>.xml，先拿到清单再放行 load，
// 否则 path.story 会去 CDN 找 scripts/<id>.xml（那里只有 404）。
const atsReady = fetch("data/ats/index.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => store.setLocalChapters(list.map((x) => x.id)))
  .catch(() => {});

let loadSeq = 0;
let loadChain = Promise.resolve();

async function load(id, { start = true, taskId = null, renderReader: renderRdr = true } = {}) {
  await atsReady;
  const seq = ++loadSeq;
  clearTimeout(autoNextTimer);
  $("#chapter-end").classList.add("hidden");
  // 从目录 / 时间轴 / 下一章进来的都算"已经选好要看了"：
  // 收起开始卡、地图库、时间轴，并把舞台恢复可见。
  // 否则从地图库点目录时，地图库盖在上面、#stage 还是 hidden，剧情在背后播却看不见
  $("#start-overlay").classList.add("hidden");
  if (!readerOn) {
    toggleMapView(false);
    showTimeline(false);
    $("#stage").style.visibility = "visible";
  }
  setStatus("载入剧本…");
  currentId = Number(id);
  localStorage.setItem("lr.last", id);
  try {
    // 并发切章时把 player.load 串起来：后发的载入一定在后执行，
    // 否则两个 fetch 交错会让旧章把新章顶掉
    const story = await (loadChain = loadChain.catch(() => {}).then(() => player.load(id)));
    if (seq !== loadSeq) return; // 已被更新的载入顶掉，别再改 UI、也别启动旧章
    setActive(id);
    const lines = [...story.nodes.values()].reduce(
      (a, n) => a + n.pages.reduce((b, p) => b + p.dialogs.length, 0),
      0,
    );
    const win = story.order.filter((k) => story.nodes.get(k).type === "asWindow").length;
    const tn = (story.tasks || []).length;
    setStatus(
      `《${story.label}》 对话 ${lines} 句 · 动画 ${win} 段` + (tn > 1 ? ` · ${tn} 个小任务` : ""),
    );
    if (start && !readerOn) {
      // 不 await：start() 要等整章对话走完，等它会把调用方（切模式按钮）锁死
      const p = taskId ? player.runTask(taskId) : player.start();
      Promise.resolve(p).catch((e) => {
        console.error(e);
        setStatus("播放失败：" + e.message);
      });
    }
    if (readerOn && renderRdr) {
      renderReader(story, { playerName: player.playerName }).then(() => {
        // 换章后回到阅读区顶部，不要停在上一章读到的位置
        $("#reader").scrollTop = 0;
        syncReaderNav();
      });
    }
    return story;
  } catch (e) {
    console.error(e);
    setStatus("载入失败：" + e.message);
  }
}

/* ---------- 结束与自动下一章 ---------- */
function showEnd() {
  const next = nextChapterId(currentId);
  const box = $("#chapter-end");
  const tip = $("#end-next");
  box.classList.remove("hidden");
  if (!next) {
    tip.textContent = "已经是最后一章了";
    $("#btn-next").style.display = "none";
    return;
  }
  $("#btn-next").style.display = "";
  let sec = 3;
  tip.textContent = `${sec} 秒后自动载入下一章（${next}）…`;
  const tick = setInterval(() => {
    sec--;
    if (sec > 0) tip.textContent = `${sec} 秒后自动载入下一章（${next}）…`;
    else clearInterval(tick);
  }, 1000);
  autoNextTimer = setTimeout(() => load(next), 3000);
}

$("#btn-next").addEventListener("click", () => {
  clearTimeout(autoNextTimer);
  const next = nextChapterId(currentId);
  if (next) load(next);
});
$("#btn-stay").addEventListener("click", () => {
  clearTimeout(autoNextTimer);
  $("#chapter-end").classList.add("hidden");
  setStatus("已停留在本章");
});

/* ---------- 目录交互 ---------- */
(async () => {
  let covers = [];
  // 上次在线收录到的地图（含 BGM/名字）先并进场景表，否则新地图打开没声音没人名
  let extras = null;
  try { extras = await loadExtras(); } catch {}
  try {
    const [scBase, cv] = await Promise.all([
      fetch("data/scenes.json").then((r) => r.json()),
      fetch("data/covers.json").then((r) => r.json()),
    ]);
    const sc = { ...scBase, ...(extras?.scenes || {}) };
    player.setSceneNames(sc);
    if (extras?.scenes) addScenes(extras.scenes, extras.sceneUsage);
    covers = cv;
  } catch (e) {
    console.warn("场景名/封面索引加载失败", e.message);
  }
  initCatalog({
    covers,
    // 上次在线收录的章节（IndexedDB）在目录初始化时并进去
    loadExtras,
    // 从目录点走时把时间轴收起来，别让覆盖层挡着新载入的剧情
    onPickChapter: (id) => {
      showTimeline(false);
      load(id);
    },
    onPickTask: (id, taskId) => {
      showTimeline(false);
      load(id, { taskId });
    },
    onInfo: (msg) => setStatus(msg),
  });
  // 时间轴也是自己 fetch 的仓库旧表，extras 在开头已经读过了
  // 时间轴是首页：只收官方带海报的故事，点「回顾」等于在目录里点开对应的一条
  initTimeline({
    covers,
    extras,
    onPickChapter: (id, story) => {
      $("#start-overlay").classList.add("hidden");
      setStatus(`回顾《${story?.name || chapterLabel(id)}》`);
      load(id);
    },
  });
})();

/* ---------- 检查新章节（在线读官方任务表，见 updater.js） ---------- */
const upPanel = $("#update-panel");
const upList = $("#up-list");
const upSummary = $("#up-summary");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);

function closeUpdate() {
  upPanel.classList.add("hidden");
}

function renderUpdate(r) {
  upList.innerHTML = "";
  if (!r.items.length) {
    upSummary.innerHTML =
      `已是最新。官方任务表里有 <em>${r.total}</em> 条故事，本地目录全都收录了。` +
      `<br><span style="opacity:.75">（检测时间 ${new Date().toLocaleString()}，数据存在浏览器里，刷新不会丢）</span>`;
    upPanel.classList.remove("hidden");
    return;
  }
  const themes = [...new Set(r.items.map((i) => (i.theme ? `《${i.theme}》` : "《》（无归属主题）")))];
  upSummary.innerHTML =
    `官方任务表里有 <em>${r.total}</em> 条故事，发现 <em>${r.items.length}</em> 条本地还没有的，` +
    `已加入目录：<em>${themes.map(esc).join("、")}</em>。` +
    `<br><span style="opacity:.75">倒序排在最上面，也可以直接点下面任意一条开始看。</span>` +
    (r.sceneCount
      ? `<br>顺带收录了 ${r.sceneCount} 张还没见过的新地图（BGM 和地图名一起补上了）：<em>${Object.values(
          r.scenes,
        )
          .map((v) => esc(v.name) + (v.bgm ? `（${esc(v.bgm)}）` : ""))
          .join("、")}</em>`
      : "");

  for (const it of r.items) {
    const div = document.createElement("div");
    div.className = "up-row";
    const meta =
      `主题 <em>${it.theme ? "《" + esc(it.theme) + "》" : "《》（无归属）"}</em>` +
      (it.date ? ` · 官方日期 <em>${esc(it.date)}</em>` : "") +
      (it.playable
        ? ` · <span class="up-good">可播，正文 ${it.lines} 句</span>` +
          (it.poster
            ? ` · <span class="up-good">海报已进时间轴</span>`
            : ` · <span class="up-bad">没有缩略图，未进时间轴</span>`)
        : ` · <span class="up-bad">缺正文（${esc(it.why)}）</span>`);
    div.innerHTML =
      `<div class="up-title">第 <b>${it.id}</b> 章 · ${esc(it.name)}</div>` +
      `<div class="up-meta">${meta}</div>`;
    if (it.playable) {
      div.style.cursor = "pointer";
      div.title = "点这里直接播放这一章";
      div.addEventListener("click", () => {
        closeUpdate();
        load(it.id);
      });
    }
    upList.appendChild(div);
  }
  upPanel.classList.remove("hidden");
}

let checking = false;
async function runUpdateCheck() {
  if (checking) return;
  checking = true;
  const btn = $("#btn-update");
  const again = $("#up-again");
  btn.disabled = again.disabled = true;
  const old = btn.textContent;
  btn.textContent = "检查中…";
  upList.innerHTML = "";
  upSummary.textContent = "正在读取官方任务表（conf/Angel.config，约 1.4MB）…";
  upPanel.classList.remove("hidden");
  setStatus("检查新章节…");
  try {
    const r = await checkUpdates();
    // 新地图：立刻作用到播放器（BGM/名字）和地图库，不用刷新
    if (r.sceneCount) {
      player.setSceneNames({ ...(player.sceneNames || {}), ...r.scenes });
      addScenes(r.scenes, r.sceneUsage);
    }
    renderUpdate(r);
    setStatus(
      r.added
        ? `新增 ${r.added} 个章节：${r.items.map((i) => i.name).join("、")}`
        : `已是最新（官方 ${r.total} 条故事）`,
    );
  } catch (e) {
    console.error(e);
    upList.innerHTML = "";
    upSummary.innerHTML =
      `<span class="up-bad">检查失败：${esc(e.message)}</span>` +
      `<br><span style="opacity:.75">这个功能要联网读官方任务表。如果只是想看已收录的剧情，直接关掉这个窗口即可。</span>`;
    setStatus("检查失败：" + e.message);
  } finally {
    checking = false;
    btn.disabled = again.disabled = false;
    btn.textContent = old;
  }
}

$("#btn-update").addEventListener("click", runUpdateCheck);
$("#up-again").addEventListener("click", runUpdateCheck);
$("#up-close").addEventListener("click", closeUpdate);
upPanel.addEventListener("click", (e) => {
  if (e.target === upPanel) closeUpdate();
});

/* ---------- 开始 ---------- */
$("#btn-start").addEventListener("click", async () => {
  $("#start-overlay").classList.add("hidden");
  load(currentId);
});

$("#btn-clear").addEventListener("click", async () => {
  const st = await store.cacheStats();
  const mb = (st.bytes / 1048576).toFixed(1);
  if (st.count) {
    const ok = confirm(
      `清空缓存会删掉浏览器里已缓存的 ${st.count} 个资源（约 ${mb} MB），` +
        `其中包括你用「下载本章」保存下来的章节。\n\n` +
        `清空后第一次打开会重新从官方 CDN 下载；剧情进度、阅读位置不受影响。继续？`,
    );
    if (!ok) return setStatus("已取消清空");
  }
  await store.cacheClear();
  setStatus(st.count ? `缓存已清空（${st.count} 个资源，约 ${mb} MB）` : "缓存本来就是空的");
});

setStatus("点击「开始」进入第 " + currentId + " 章");
setActive(currentId);

/* ---------- 诊断浮层（?diag=1）---------- */
if (new URLSearchParams(location.search).get("diag") === "1") {
  const box = document.createElement("div");
  box.id = "diag";
  box.style.cssText =
    "position:fixed;right:8px;bottom:8px;width:520px;max-height:44vh;overflow:auto;z-index:9999;" +
    "background:#000c;color:#9fe8b0;font:11px/1.5 Consolas,monospace;padding:8px 10px;border-radius:6px;white-space:pre-wrap";
  document.body.appendChild(box);
  const lines = [];
  const push = (tag, args) => {
    const t = [...args].map((a) => (a && a.message) || String(a)).join(" ");
    if (!/wbscrash|setModal/.test(t)) lines.push(tag + " " + t.slice(0, 300));
  };
  const oe = console.error, ow = console.warn, ol = console.log;
  console.error = (...a) => { push("ERR", a); oe.apply(console, a); };
  console.warn = (...a) => { push("WRN", a); ow.apply(console, a); };
  // Ruffle 把 AVM2 错误当普通 log 打出来，带 %cERROR%c 前缀
  console.log = (...a) => {
    const t = a.map((x) => String(x)).join(" ");
    if (t.includes("ERROR")) push("AVM", [t.replace(/%c/g, "").replace(/color:[^;]*;?/g, "").slice(0, 280)]);
    ol.apply(console, a);
  };
  setInterval(() => {
    box.textContent = lines.slice(-18).join("\n");
  }, 400);
}

/* ---------- 直达链接 ----------
 * ?map=394        直接看某张地图（可分享、便于核对）
 * ?chapter=1088   直接开某一章
 */
const qs = new URLSearchParams(location.search);
const mapParam = qs.get("map");
const chapterParam = qs.get("chapter");
if (mapParam || chapterParam) {
  setTimeout(async () => {
    $("#start-overlay").classList.add("hidden");
    if (chapterParam) {
      await load(chapterParam);
    } else {
      const [mpId, mpVer] = String(mapParam).split(".");
      await player.showMap(mpId, Number(mpVer) || 1);
      const nm = player.sceneNameOf(mpId, player.curSceneVer);
      setStatus(`地图 · ${nm || mapParam}（${mapParam}）`);
    }
  }, 900);
}
