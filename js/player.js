// 播放器引擎：把剧本节点图跑成可交互的对话流
import { parseStory } from "./parser.js";
import * as store from "./store.js";
import { watchAnim } from "./animwatch.js";

const TYPE_SPEED = 18;
// 本地一份 Ruffle 0.7.1（vendor/ruffle/），CDN 只在本地缺失时兜底：
// 之前每次启动都要从 jsdelivr 拉 460KB + 28MB wasm，网络一抖就「Ruffle 加载失败」。
const RUFFLE_LOCAL = "vendor/ruffle/ruffle.js";
const RUFFLE_CDN = "https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle/ruffle.js";

const FOCUS_X = 0.46; // 角色组里人物聚集处的相对位置（按 1088 章实测）
const FOCUS_Y = 0.66;

// 从 SWF 头解析舞台尺寸（CWS 用 DecompressionStream 解压）
async function swfSize(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const sig = String.fromCharCode(head[0], head[1], head[2]);
    let body;
    if (sig === "CWS" && typeof DecompressionStream !== "undefined") {
      const raw = blob.slice(8).stream().pipeThrough(new DecompressionStream("deflate"));
      body = new Uint8Array(await new Response(raw).arrayBuffer());
    } else if (sig === "FWS") {
      body = new Uint8Array(await blob.slice(8).arrayBuffer());
    } else {
      return [0, 0];
    }
    const nbits = body[0] >> 3;
    const nbytes = Math.ceil((5 + nbits * 4) / 8);
    let bits = "";
    for (let i = 0; i < nbytes; i++) bits += body[i].toString(2).padStart(8, "0");
    const v = [];
    let pos = 5;
    for (let k = 0; k < 4; k++) {
      v.push(parseInt(bits.slice(pos, pos + nbits), 2));
      pos += nbits;
    }
    return [(v[1] - v[0]) / 20, (v[3] - v[2]) / 20];
  } catch {
    return [0, 0];
  }
}


// 过场动画的「播完」判定在 animwatch.js（captureStream 取真实画面）。
// 各触发路径统一走 playWindow 里的 close()，保证只关一次。

export class Player {
  constructor(el, opts = {}) {
    this.el = el;
    this.onFinish = opts.onFinish || null; // 结束回调（自动下一章）
    this.story = null;
    this.ruffle = null;
    this.gen = 0;
    this.waiting = null;
    this.stageTimer = null;
    this.curScene = null;
    this.curSceneVer = 1;
    this.curSceneKey = null;
    this.avatarNpc = null;
    this.bgmFile = null;
    this.visited = new Set();
    this.typewriter = localStorage.getItem("lr.tw") !== "0";
    this.playerName = localStorage.getItem("lr.name") || "小洛克";
    this.bgmOn = localStorage.getItem("lr.bgm") === "1"; // 默认关
    this.bgmFile = null;
    this.bgmPlayer = null;
    this.sceneNames = {};
    this.speed = Number(localStorage.getItem("lr.speed") || 1);
    this.closedAt = 0; // 上一次过场动画自动结束的时刻，用于挡住紧随其后的重复推进
    this.bindUI();
  }

  bindUI() {
    this.box = this.el.querySelector("#dialog-box");
    this.speakerEl = this.el.querySelector("#speaker");
    this.textEl = this.el.querySelector("#text");
    this.choiceEl = this.el.querySelector("#choices");
    this.hintEl = this.el.querySelector("#hint");
    this.sceneLayer = this.el.querySelector("#scene-layer");
    this.viewLayer = this.el.querySelector("#view-layer");
    this.windowLayer = this.el.querySelector("#window-layer");
    this.avatarEl = this.el.querySelector("#npc-avatar");

    this.box.addEventListener("click", (e) => {
      if (e.target.closest("#choices")) return;
      // 选项还在时，任何落在对话框上的点击都不算「继续」，
      // 否则按钮被清掉后同一发点击会接着把下一句台词顶掉
      if (this.choiceEl.childElementCount) return;
      this.advance();
    });
    document.addEventListener("keydown", (e) => {
      if ((e.code === "Space" || e.code === "Enter") && !e.target.closest("input")) {
        e.preventDefault();
        this.advance();
      }
    });
  }

  async ensureRuffle() {
    if (this.ruffle) return this.ruffle;
    this.ruffle = await store.ensureRuffle();
    return this.ruffle;
  }

  async load(storyId, { keepGen = false } = {}) {
    if (!keepGen) this.gen++;
    // 先放掉还挂着的那一步，避免切章后旧协程永远悬着
    const pending = this.waiting;
    this.waiting = null;
    this._prevKey = null; // 换章后重置自指保护
    try { pending?.(); } catch {}
    store.setTimeScale(1);
    this.story = null;
    this.el.classList.add("loading");
    this.sceneLayer.innerHTML = "";
    this.viewLayer.innerHTML = "";
    this.curView = null;
    this.windowLayer.innerHTML = "";
    this.windowLayer.classList.remove("active");
    this.avatarEl.innerHTML = "";
    this.avatarEl.classList.add("hidden");
    this.curScene = null;
    this.curSceneKey = null;
    this.curSceneVer = 1;
    this.avatarNpc = null;
    this.bgmFile = null;
    this.visited = new Set();
    this.waiting = null;
    clearInterval(this.stageTimer);
    this.stageTimer = null;

    const text = await store.fetchText(store.path.story(storyId));
    const story = parseStory(text);
    this.story = story;
    this.el.classList.toggle("no-scene", !story.scenes.length);
    this.el.classList.remove("loading");
    this.el.querySelector("#chapter-title").textContent = `第 ${story.id} 章 · ${story.label}`;
    return story;
  }

  async start(key = null) {
    const gen = this.gen;
    const firstNpc = this.story.npcs[0];
    if (firstNpc?.sceneID) await this.setScene(firstNpc.sceneID, firstNpc.sceneVer);
    // 切场景期间可能已经被 stop()/换章顶掉，别再把旧章跑起来
    if (gen !== this.gen) return;
    await this.run(key || this.story.start);
  }

  async runTask(taskId) {
    const gen = this.gen;
    const key = this.story?.taskStart?.get(taskId);
    if (!key) return this.start();
    if (gen !== this.gen) return;
    await this.run(key);
  }

  // 场景上的角色层：<View src="679900.swf"> 叠在背景之上，这就是原版的「人物站在地图里」
  async setView(npc, frame = 0) {
    const src = npc?.view || "";
    const key = src ? `${npc.npcID}/${src}#${frame || 0}` : "";
    if (this.curView === key) return;
    this.curView = key;
    this.viewLayer.innerHTML = "";
    if (!src) return;
    const gen = this.gen;
    try {
      const ruffle = await this.ensureRuffle();
      if (gen !== this.gen) return;
      const p = ruffle.createPlayer();
      p.style.cssText = "width:100%;height:100%;background:transparent";
      // 角色层必须透明，否则 Ruffle 的灰色画布会盖住场景（实测：只有 wmode 生效）
      try {
        p.config = { ...(p.config || {}), autoplay: "on", unmuteOverlay: "hidden", wmode: "transparent", backgroundColor: null, letterbox: "off", splashScreen: false };
      } catch {}
      this.viewLayer.appendChild(p);
      // 合并类库后再加载，否则 AS3 动画不会执行（只有静态第一帧）
      const merged = await store.fetchSwfWithLib(`res/npc/${npc.npcID}/${src}`, { frame });
      if (gen !== this.gen) {
        try { p.remove(); } catch {}
        return;
      }
      try {
        await p.load(store.blobUrl(merged));
      } catch (e) {
        // 个别角色 SWF 的类定义在目标帧之后，裁帧后会坏；退回原来的整段合并版
        if (!frame) throw e;
        console.warn("按帧加载角色失败，回退整段", src, frame, e.message);
        const base = await store.fetchSwfWithLib(`res/npc/${npc.npcID}/${src}`);
        if (gen !== this.gen) return;
        await p.load(store.blobUrl(base));
      }
    } catch (e) {
      console.warn("角色层加载失败", src, e.message);
    }
  }

  setSceneNames(map) {
    this.sceneNames = map || {};
  }

  // 场景版本：data/scenes.json 里每个 id 带 versions[]（官方配置里同 id 的历史快照）。
  // 剧本的 ver：缺省 1，0 表示"最新版"。资源上第 1 版在 res/scene/<id>/，第 N 版在 res/scene/<id>.<N>/。
  sceneVerOf(id, ver) {
    const v = this.sceneNames?.[String(id)];
    if (!v || typeof v === "string") return 1;
    const max = v.maxVer || (v.versions?.length ? v.versions[v.versions.length - 1].ver : 1);
    let n = ver == null ? 1 : Number(ver);
    if (!n) n = max;
    return Math.min(Math.max(1, n), max || 1);
  }

  sceneVerList(id) {
    const v = this.sceneNames?.[String(id)];
    if (!v || typeof v === "string") return [];
    return v.versions || [];
  }

  sceneNameOf(id, ver) {
    const v = this.sceneNames?.[String(id)];
    if (!v) return "";
    if (typeof v === "string") return v;
    if (ver == null) return v.name || "";
    const hit = (v.versions || []).find((x) => x.ver === ver);
    return (hit && hit.name) || v.name || "";
  }

  // 背景音乐：取自官方 conf/Angel.config 的 scene_conf，字段 bgMusic="主曲|环境音"。
  // 音乐 SWF 只有一帧，交给 Ruffle 会立刻停在第一帧没声音，
  // 所以从 SWF 里抽出裸 MP3，用 <audio loop> 播（见 store.fetchMusicAudio）。
  async setBgm(sceneId, ver) {
    if (!this.bgmOn) return;
    const v = this.sceneNames?.[String(sceneId)];
    const hit = ver == null ? null : (v?.versions || []).find((x) => x.ver === ver);
    const file = hit ? hit.bgm : v && typeof v === "object" ? v.bgm : "";
    if (!file || this.bgmFile === file) return;
    this.bgmFile = file;

    try {
      const blob = await store.fetchMusicAudio(file);
      if (this.bgmFile !== file) return; // 期间又切了场景
      if (!this.bgmAudio) {
        this.bgmAudio = new Audio();
        this.bgmAudio.loop = true;
        this.bgmAudio.preload = "auto";
        this.bgmAudio.volume = 0.7;
      }
      const url = URL.createObjectURL(blob);
      try { this.bgmAudio.pause(); } catch {}
      const old = this.bgmAudio.src;
      this.bgmAudio.src = url;
      if (old && old.startsWith("blob:")) URL.revokeObjectURL(old);
      await this.bgmAudio.play();
    } catch (e) {
      console.warn("背景音乐失败", file, e.message);
    }
  }

  setBgmEnabled(on) {
    this.bgmOn = on;
    localStorage.setItem("lr.bgm", on ? "1" : "0");
    if (!on) {
      try { this.bgmAudio?.pause(); } catch {}
      this.bgmFile = null;
    } else if (this.curScene) {
      this.bgmFile = null;
      this.setBgm(this.curScene, this.curSceneVer);
    }
  }

  // 阅读模式等场景临时静音，不改变用户的持久设置
  suspendBgm(yes) {
    try {
      if (yes) this.bgmAudio?.pause();
      else if (this.bgmOn) this.bgmAudio?.play().catch(() => {});
    } catch {}
  }

  // 只看地图：中断剧情协程、清掉对话框和角色层，只保留场景与背景音乐
  async showMap(sceneId, ver) {
    this.gen++;
    this.waiting = null;
    clearInterval(this.stageTimer);
    this.stageTimer = null;
    this.box.classList.add("hidden");
    this.windowLayer.classList.remove("active");
    this.windowLayer.innerHTML = "";
    this.avatarEl.classList.add("hidden");
    this.avatarEl.innerHTML = "";
    this.viewLayer.innerHTML = "";
    this.curView = null;
    this.curScene = null;
    this.curSceneKey = null;
    this.bgmFile = null;

    await this.setScene(sceneId, ver);

    const nm = this.sceneNameOf(sceneId, this.curSceneVer);
    const t = this.el.querySelector("#chapter-title");
    if (t) t.textContent = `地图 · ${nm || sceneId}`;
  }

  async setScene(sceneId, ver) {
    const gen = this.gen;
    const v = this.sceneVerOf(sceneId, ver);
    const el = this.el.querySelector("#scene-name");
    if (el) {
      const nm = this.sceneNameOf(sceneId, v);
      el.textContent = nm ? `${nm}` : "";
      el.classList.toggle("hidden", !nm);
    }
    // 同一个 id 的两个版本是两张不同的地图（商店街 2013.4 / 现版、植物园 3 版），
    // 所以判重要带上版本，不能只看 id
    const key = `${sceneId}.${v}`;
    if (this.curSceneKey === key) return;
    this.curSceneKey = key;
    this.curScene = sceneId;
    this.curSceneVer = v;
    this.sceneLayer.innerHTML = "";
    // 地图 SWF 要下载 + 合并类库，差不多 1 秒；这期间给个提示，别让舞台空着（Ruffle 启动图已关）
    const loadingEl = document.createElement("div");
    loadingEl.className = "scene-loading";
    loadingEl.textContent = "地图载入中…";
    this.sceneLayer.appendChild(loadingEl);
    // 换地图时先把上一张地图的角色层清掉：新的 View 没加载成功时，
    // 宁可空着，也不要一直挂着上一张地图的 NPC（看起来就是「换图后 NPC 还是同一个」）
    this.viewLayer.innerHTML = "";
    this.curView = null;
    this.setBgm(sceneId, v);

    // 底图兜底：直接抽 SWF 里那张 960×560 的 JPEG 当背景，叠在 Ruffle 层下面。
    // 正常场景 Ruffle 会把自己的背景画在上面盖住它；构造失败、背景没挂上的场景就靠它。
    store
      .sceneBackdrop(sceneId, v)
      .then((url) => {
        if (!url || gen !== this.gen) return;
        const img = new Image();
        img.className = "scene-bg";
        img.src = url;
        this.sceneLayer.insertBefore(img, this.sceneLayer.firstChild);
      })
      .catch(() => {});

    try {
      const ruffle = await this.ensureRuffle();
      if (gen !== this.gen) return;
      const p = ruffle.createPlayer();
      p.style.width = "100%";
      p.style.height = "100%";
      try {
        p.config = { ...(p.config || {}), autoplay: "on", unmuteOverlay: "hidden", wmode: "transparent", backgroundColor: null, letterbox: "off", splashScreen: false };
      } catch {}
      this.sceneLayer.appendChild(p);
      // 部分场景（暗黑岭、暗黑实验室这类）的 BGImage/SceneXXX 类继承自
      // AngelClientLibs 的 AbstractSceneLogic，不合并类库就只剩零星动画、没有大背景。
      const swf = await store.fetchSwfWithLib(store.path.scene(sceneId, v));
      if (gen !== this.gen) {
        try { p.remove(); } catch {}
        return;
      }
      await p.load(store.blobUrl(swf));
      loadingEl.remove();
    } catch (e) {
      console.warn("场景加载失败", key, e.message);
      if (loadingEl.isConnected) loadingEl.textContent = "地图载入失败";
    }
  }


  async setAvatar(npcId) {
    if (this.avatarNpc === npcId) return;
    this.avatarNpc = npcId;
    this.avatarEl.innerHTML = "";
    if (!npcId || npcId === "0") {
      this.avatarEl.classList.add("hidden");
      return;
    }
    this.avatarEl.classList.remove("hidden");
    const img = new Image();
    img.alt = "";
    img.src = store.direct(store.path.npcPreview(npcId));
    img.onerror = () => {
      this.avatarEl.classList.add("hidden");
    };
    this.avatarEl.appendChild(img);
  }

  async playWindow(node) {
    const gen = this.gen;
    this.box.classList.add("hidden");
    this.windowLayer.innerHTML = "";
    this.windowLayer.classList.add("active");
    const nameEl = this.el.querySelector("#scene-name");
    if (nameEl) nameEl.classList.add("hidden");

    // 认不出来的 src（老任务里的 nameRegister 这类插件窗口）不要瞎拼相对路径
    const url = store.windowFromSrc(node.src) || (/^[\w.-]+$/.test(String(node.src || "")) ? "" : node.src + ".swf");
    // 视频类（有逐帧动画）播完自动继续；漫画类（纯静态页）必须手动翻
    const info = await store.animInfo(url);
    // 人工复核优先（和阅读模式一致）：keep 当视频、skip 当漫画
    const kind = await store.animKindFor(node.src, url);
    // 只有视频类过场吃"缩放"；漫画是整页图，放大会裁掉画面
    this.windowLayer.classList.toggle("zoom-video", kind === "video");
    let p = null;

    // 过场加载期间不再铺占位层（用户 2026-11-17 要求去掉"过场动画载入中"那块背景提示），
    // 窗口层保持纯黑，等 Ruffle 画出第一帧。

    /* 关闭只允许发生一次。
     * 以前 fscommand、静止检测、点「继续」三条路各自直接调 advance()，
     * 而动画自己的 fscommand 常常不止发一次（片尾 + 循环起点），
     * 第二发会在下一句台词刚挂上 waiting 时把它推掉 —— 表现就是「多跳一步」。
     * 现在三条路都走 close()，done 一置位后续全部无效。 */
    let done = false;
    let stopWatch = null;
    let settle = null;
    const closed = new Promise((resolve) => {
      settle = resolve;
    });
    const close = (why) => {
      if (done) return;
      done = true;
      if (why !== "user") this.closedAt = performance.now(); // 自动结束后给重复推进留免疫期
      this.windowKind = null;
      try { stopWatch?.(); } catch {}
      try { if (p) p.onFSCommand = null; } catch {}
      this.waiting = null;
      settle?.();
    };

    // 加载期间也要能点掉（大文件不至于卡住）
    this.waiting = () => close("user");

    try {
      const ruffle = await this.ensureRuffle();
      if (gen !== this.gen) return;
      p = ruffle.createPlayer();
      try {
        p.config = { ...(p.config || {}), autoplay: "on", unmuteOverlay: "hidden", wmode: "transparent", backgroundColor: null, letterbox: "on", splashScreen: false };
      } catch {}
      try {
        p.onFSCommand = (cmd, args) => {
          console.log("[fscommand]", cmd, args);
          close("fs");
        };
      } catch {}
      this.windowLayer.appendChild(p);
      // 占位层故意放在播放器下面（z-index 0）：Ruffle 的首帧画出来之前画布是透明的，
      // 占位就露着；一旦画出内容，画布把它盖住。这样不用猜「第一帧什么时候到」。
      // 倍速是运行时时间缩放，SWF 字节一律按原速拼
      const merged = await store.fetchSwfWithLib(url);
      if (gen !== this.gen || done) {
        try { p.remove(); } catch {}
        return;
      }
      await p.load(store.blobUrl(merged));
      if (gen !== this.gen || done) {
        try { p.remove(); } catch {}
        return;
      }
      // 只有视频类需要倍速，漫画翻页与时间无关
      if (kind === "video") {
        this.windowKind = kind;
        store.setTimeScale(this.speed);
      }
    } catch (e) {
      console.warn("动画加载失败", url, e.message);
      this.windowLayer.innerHTML = `<div class="asset-error">动画加载失败：${url}</div>`;
    }

    if (p && kind === "video" && !done) {
      try {
        // 兜底超时按实际片长算，别让静止检测把长片误判成播完
        stopWatch = watchAnim(p, () => close("end"), {
          maxMs: Math.max(20000, info.durMs + 12000),
          durMs: info.durMs,
        });
      } catch {}
    }

    const bar = document.createElement("div");
    bar.className = "window-bar";
    bar.innerHTML = `<span>${kind === "video" ? "过场动画" : "漫画"}</span><button id="win-next">继续 ▸</button>`;
    this.windowLayer.appendChild(bar);
    bar.querySelector("#win-next").addEventListener("click", () => close("user"));

    await closed;
    if (gen !== this.gen) return;
    store.setTimeScale(1);
    this.windowLayer.classList.remove("active", "zoom-video");
    this.windowLayer.innerHTML = "";
    if (nameEl && this.curScene) nameEl.classList.remove("hidden");
    this.box.classList.remove("hidden");
  }

  async run(keyOrLabel, fromKey = null) {
    const gen = this.gen;
    if (!keyOrLabel) return this.finish();
    const key = this.story?.nodes.has(keyOrLabel)
      ? keyOrLabel
      : this.story?.resolve(fromKey, keyOrLabel);
    const node = key ? this.story.nodes.get(key) : null;
    // 兜底：同一个节点连着进两次，说明 Goto/Button 指回了自己（老剧本里
    // 多段任务共用 label="submit" 就会这样）。这时继续跑就是无限循环，直接收尾。
    if (key && key === this._prevKey) {
      console.warn("剧情节点自指，已中断：", key);
      return this.finish();
    }
    this._prevKey = key || null;
    if (!node) return this.finish();

    if (node.npc?.sceneID) await this.setScene(node.npc.sceneID, node.npc.sceneVer);
    if (gen !== this.gen) return;
    await this.setView(node.npc, node.state || 1);
    if (gen !== this.gen) return;

    if (node.type === "asWindow") {
      await this.playWindow(node);
      if (gen !== this.gen) return;
      const nxt = this.story.resolve(node.key, node.defaultGoto) || node.next;
      return this.run(nxt);
    }
    await this.playDialog(node);
  }

  async playDialog(node) {
    const gen = this.gen;
    const pages = node.pages.length ? node.pages : [{ dialogs: [], buttons: [] }];
    for (const page of pages) {
      for (const d of page.dialogs) {
        await this.say(d.name, d.text, d.npcID);
        if (gen !== this.gen) return;
      }
      if (page.buttons.length) {
        const target = await this.choose(page.buttons);
        if (gen !== this.gen) return;
        return this.run(target, node.key);
      }
    }
    return this.run(node.next);
  }

  async say(name, text, npcId) {
    text = String(text).replace(/\{name\}/g, this.playerName || "小洛克");
    this.setAvatar(npcId); // 不阻塞台词
    this.speakerEl.textContent = name || "";
    this.speakerEl.classList.toggle("empty", !name);
    this.choiceEl.innerHTML = "";
    this.hintEl.textContent = "点击继续";
    this.box.classList.remove("hidden");

    await new Promise((resolve) => {
      if (!this.typewriter) {
        this.textEl.textContent = text;
        this.waiting = () => {
          this.waiting = null;
          resolve();
        };
        return;
      }
      let i = 0;
      let typing = true;
      this.textEl.textContent = "";
      clearInterval(this.stageTimer);
      this.stageTimer = setInterval(() => {
        this.textEl.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(this.stageTimer);
          this.stageTimer = null;
          typing = false;
        }
      }, TYPE_SPEED);

      this.waiting = () => {
        if (typing) {
          clearInterval(this.stageTimer);
          this.stageTimer = null;
          typing = false;
          this.textEl.textContent = text;
          return;
        }
        this.waiting = null;
        resolve();
      };
    });
  }

  choose(buttons) {
    this.hintEl.textContent = "";
    this.choiceEl.innerHTML = "";
    return new Promise((resolve) => {
      for (const b of buttons) {
        const el = document.createElement("button");
        el.className = "choice";
        el.textContent = b.label;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation(); // 别让这一发点击继续冒泡到对话框的 advance()
          this.choiceEl.innerHTML = "";
          resolve(b.goto);
        });
        this.choiceEl.appendChild(el);
      }
    });
  }

  advance() {
    // 动画刚自动结束时，SWF 的 fscommand 往往还会再补一发；这里给 260ms 免疫期，
    // 否则那一发会把刚出现的下一句台词直接顶掉。
    if (performance.now() - this.closedAt < 260) return;
    if (this.choiceEl.childElementCount) return; // 正在选项上，别推
    if (this.waiting) this.waiting();
  }

  /** 中断当前剧情推进（切阅读模式用），不销毁场景层 */
  stop() {
    this.gen++;
    const pending = this.waiting;
    this.waiting = null;
    try { pending?.(); } catch {}
    this.closedAt = 0;
    clearInterval(this.stageTimer);
    this.stageTimer = null;
    this.windowLayer.classList.remove("active");
    this.windowLayer.innerHTML = "";
    this.box.classList.add("hidden");
    this.choiceEl.innerHTML = "";
    store.setTimeScale(1);
    this.el.querySelector("#scene-name")?.classList.remove("hidden");
  }

  setZoom(z) {
    document.documentElement.style.setProperty("--zoom", String(z));
    localStorage.setItem("lr.zoom", String(z));
  }

  setPlayerName(n) {
    this.playerName = (n || "").trim() || "小洛克";
    localStorage.setItem("lr.name", this.playerName);
  }

  setSpeed(s) {
    this.speed = s;
    localStorage.setItem("lr.speed", String(s));
    // 视频正在播就直接换挡，不用重载、不打断画面
    if (this.windowKind === "video") store.setTimeScale(s);
  }

  setTypewriter(on) {
    this.typewriter = on;
    localStorage.setItem("lr.tw", on ? "1" : "0");
  }


  finish() {
    this.box.classList.add("hidden");
    this.onFinish?.();
  }
}
