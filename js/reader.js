// 阅读模式：把一章的对话铺成小说式文本，动画只留可点播放的过场
import * as store from "./store.js";
import { watchAnim } from "./animwatch.js";

let playing = null;
let renderSeq = 0; // 并发渲染保护：只让最后一次调用落地
const VIDEO_MIN_FRAMES = 20;

function animPath(node) {
  return store.windowFromSrc(node.src);
}

export async function renderReader(story, deps = {}) {
  const body = document.querySelector("#reader-body");
  const title = document.querySelector("#reader-title");
  const seq = ++renderSeq;
  body.innerHTML = "";
  if (!story) return;

  title.textContent = `第 ${story.id} 章 · ${story.label}`;

  // 阅读模式只保留视频类过场（漫画/对话框类要逐帧点，不适合阅读流）。
  // data/anim_review.json 是 2714 段人工复核的结果：
  //   keep  —— 明确要保留的
  //   skip  —— 明确要剔除的
  // 新章节里两张表都没有的，才交给自动判据（store.animInfo）。
  let keepSet = new Set();
  let skipSet = new Set();
  try {
    const j = await (await fetch("data/anim_review.json")).json();
    keepSet = new Set(j.keep || []);
    skipSet = new Set(j.skip || []);
  } catch {}

  const wins = story.order.filter((k) => story.nodes.get(k)?.type === "asWindow");
  const keepUrls = new Set();
  await Promise.all(
    wins.map(async (k) => {
      const node = story.nodes.get(k);
      const id = store.animKeyFromSrc(node.src);
      if (!id) return;
      if (skipSet.has(id)) return;
      if (keepSet.has(id)) {
        keepUrls.add(animPath(node));
        return;
      }
      if ((await store.animKind(animPath(node))) === "video") keepUrls.add(animPath(node));
    }),
  );
  const nm = deps.playerName || "小洛克";
  const frag = document.createDocumentFragment();
  let animIdx = 0;

  for (const key of story.order) {
    const node = story.nodes.get(key);
    if (!node) continue;

    if (node.type === "asWindow") {
      const relPath = animPath(node);
      if (!relPath) continue;
      if (!keepUrls.has(relPath)) continue;
      const wrap = document.createElement("div");
      wrap.className = "rd-anim";
      const btn = document.createElement("button");
      btn.textContent = `▶ 播放过场动画 ${++animIdx}`;
      const holder = document.createElement("div");
      holder.className = "rd-anim-holder";
      btn.addEventListener("click", () => playAnim(holder, relPath, btn));
      wrap.appendChild(btn);
      wrap.appendChild(holder);
      frag.appendChild(wrap);
      continue;
    }

    for (const page of node.pages) {
      for (const d of page.dialogs) {
        const p = document.createElement("p");
        p.className = "rd-line";
        const name = document.createElement("b");
        name.textContent = (d.name || "") + "：";
        p.appendChild(name);
        p.appendChild(document.createTextNode(String(d.text).replace(/\{name\}/g, nm)));
        frag.appendChild(p);
      }
      for (const b of page.buttons) {
        const p = document.createElement("p");
        p.className = "rd-choice";
        p.textContent = "▸ " + b.label;
        frag.appendChild(p);
      }
    }
  }
  if (seq !== renderSeq) return; // 期间又发起了一次渲染，丢弃这次
  body.appendChild(frag);
  document.querySelector("#reader").scrollTop = 0;
}

async function playAnim(holder, rel, btn) {
  if (playing) {
    try { playing.remove(); } catch {}
    playing = null;
    store.setTimeScale(1);
  }
  holder.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "载入中…";
  try {
    const ruffle = await store.ensureRuffle();
    const p = ruffle.createPlayer();
    p.style.cssText = "width:100%;height:100%";
    // 老故事的过场是 500×375 的小舞台，画面不满页；必须透明背景，
    // 否则 letterbox 的留白会是一片白（和播放器里的窗口层保持一致）
    p.config = { ...(p.config || {}), autoplay: "on", unmuteOverlay: "hidden", letterbox: "on", wmode: "transparent", backgroundColor: null, splashScreen: false };
    holder.appendChild(p);
    const info = await store.animInfo(rel);
    // 这些过场 SWF 全都引用 com.QQ.angel.* 类库，不合并类库 AS3 校验不过，
    // 只会停在第一帧 —— 以前这里直接拿原文件，等于静态图。
    const merged = await store.fetchSwfWithLib(rel);
    await p.load(store.blobUrl(merged));
    // 阅读模式里的过场同样是视频类，跟着倍速设置走（运行时时间缩放，无重载）
    store.setTimeScale(window.__player?.speed || 1);
    playing = p;
    window.__readerAnim = p; // 让顶部的倍速按钮能作用于阅读模式里的这段
    btn.textContent = "↻ 重新播放";
    btn.disabled = false;
    btn.onclick = () => playAnim(holder, rel, btn);
    // 视频播完自动收起，回到阅读流
    watchAnim(p, () => {
      try { p.remove(); } catch {}
      store.setTimeScale(1);
      holder.innerHTML = "";
      playing = null;
      window.__readerAnim = null;
      btn.textContent = "▶ 重新播放";
    }, { maxMs: 60000, durMs: info?.durMs || 0 });
  } catch (e) {
    btn.textContent = "动画加载失败";
    btn.disabled = false;
    console.warn(e);
  }
}

export function showReader(on) {
  document.querySelector("#reader").classList.toggle("hidden", !on);
  document.querySelector("#app").classList.toggle("dimmed", on);
}
