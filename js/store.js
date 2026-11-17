// 资源层：本仓库不托管任何官方资源，全部按需从官方 CDN 拉取
// 因为 res.17roco.qq.com 不返回 Access-Control-Allow-Origin，
// 浏览器直接 fetch 会被 CORS 拦截，所以统一经由同源的 /proxy 转发（由 proxy/server.mjs 提供）

export const CDN = "https://res.17roco.qq.com/";

// Ruffle 运行时的加载：本地优先，缺了再走 CDN。
// 播放器和阅读模式共用这一处，避免两边各自判断（阅读模式曾因此直接报
// 「Cannot read properties of undefined (reading 'newest')」）。
const RUFFLE_LOCAL = "vendor/ruffle/ruffle.js";
const RUFFLE_CDN = "https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle/ruffle.js";
let rufflePromise = null;

export function ensureRuffle() {
  if (window.RufflePlayer?.newest) return Promise.resolve(window.RufflePlayer.newest());
  if (rufflePromise) return rufflePromise;
  const load = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("加载失败：" + src));
      document.head.appendChild(s);
    });
  rufflePromise = (async () => {
    try {
      await load(RUFFLE_LOCAL);
    } catch {
      await load(RUFFLE_CDN);
    }
    for (let i = 0; i < 100 && !window.RufflePlayer?.newest; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.RufflePlayer?.newest) throw new Error("Ruffle 没有初始化完成");
    return window.RufflePlayer.newest();
  })().catch((e) => {
    rufflePromise = null;
    throw e;
  });
  return rufflePromise;
}

const LS_KEY = "lr.proxy";
let proxyPrefix = localStorage.getItem(LS_KEY) || "/proxy?url=";

export function setProxy(prefix) {
  proxyPrefix = prefix;
  localStorage.setItem(LS_KEY, prefix);
}
export function getProxy() {
  return proxyPrefix;
}

export function wrap(url) {
  return proxyPrefix + encodeURIComponent(url);
}

// 图片走直连：<img> 不受同源策略限制，不需要代理
export function direct(relPath) {
  return CDN + relPath;
}

// 老故事（story 55–218）的剧本不在 CDN 的 scripts/<id>.xml 里，
// 而在 res/task2/scripts/<名字>.ats 这个 Flash 脚本库里，已离线还原到 data/ats/。
let LOCAL_CHAPTERS = new Set();
export function setLocalChapters(ids) {
  LOCAL_CHAPTERS = new Set((ids || []).map(String));
}

// 过场动画的 src 在脚本里写成 task/<任务号>/<名字>，
// 实际文件是 apps/task/<任务号>/<名字>.swf（APP_3685_0 这种老写法也适用）。
// 配置里的 src 有两种毛病：反斜杠（task\1033\1033_0）和带下划线的任务目录
// （task/1069_1072/ts_0，两个任务共用一个目录）。都要能还原成真实路径。
export function normalizeSrc(src) {
  return String(src || "").trim().replace(/\\/g, "/").replace(/\.swf$/i, "");
}

export function windowFromSrc(src) {
  const s = normalizeSrc(src);
  const m = /^tasks?\/([\w.-]+)\/(.+)$/i.exec(s);
  return m ? `apps/task/${m[1]}/${m[2]}.swf` : "";
}

// 过场动画在判据表（data/anim_review.json）里的 key：
//   task/3685/APP_3685_0        → "3685_0"（新章节的写法）
//   task/2006/AboutFiveElements → "2006_AboutFiveElements"（老 .ats 的写法）
export function animKeyFromSrc(src) {
  const m = /^tasks?\/([\w.-]+)\/(.+)$/i.exec(normalizeSrc(src));
  if (!m) return "";
  const t = /^APP_\d+_(\d+)$/.exec(m[2]);
  return `${m[1]}_${t ? t[1] : m[2]}`;
}

// 各类资源的 URL 规则（均已实测）
export const path = {
  story: (id) => (LOCAL_CHAPTERS.has(String(id)) ? `data/ats/${id}.xml` : `res/task2/scripts/${id}.xml`),
  window: (taskId, i) => `apps/task/${taskId}/APP_${taskId}_${i}.swf`,
  // 地图改版后旧版本没被删：第 1 版在 res/scene/<id>/，第 N 版在 res/scene/<id>.<N>/（实测 26 有 3 版）
  scene: (sceneId, ver = 1) =>
    ver > 1 ? `res/scene/${sceneId}.${ver}/scene.swf` : `res/scene/${sceneId}/scene.swf`,
  npc: (npcId) => `res/npc/${npcId}/${npcId}.swf`,
  music: (n) => `res/music/new_${n}.swf`,
  npcPreview: (npcId) => `res/npc/${npcId}/preview.png`,
  panel: (storyId) => `res/task2/panelBG/${storyId}.jpg`,
  themeTitle: (themeId) => `res/task2/themeTitle/${themeId}.1.png`,
  global: () => "Global.xml",
};

// ---------- IndexedDB 缓存 ----------
const DB_NAME = "luoke-story";
const STORE = "assets";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result || null);
    tx.onerror = () => resolve(null);
  });
}

export async function cachePut(key, blob) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, key);
    tx.onsuccess = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

// 缓存里有多少东西：条目数 + 总字节。「清空缓存」前先报个数，免得把「下载本章」存的一起清掉还不知道
export async function cacheStats() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      let count = 0,
        bytes = 0;
      const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return resolve({ count, bytes });
        count++;
        bytes += cur.value?.size || 0;
        cur.continue();
      };
      req.onerror = () => resolve({ count, bytes });
    });
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function cacheClear() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
    tx.onsuccess = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

// 统一取资源：缓存优先 → 网络（经代理）
// data/ 开头的是本站文件（离线还原的 ats 章节），走同源直取、不进缓存，免得改完还读旧文件
export async function fetchAsset(relPath, { useCache = true } = {}) {
  const isLocal = /^data\//.test(relPath);
  if (useCache && !isLocal) {
    const hit = await cacheGet(relPath);
    if (hit) return { blob: hit, from: "cache" };
  }
  const resp = await fetch(isLocal ? relPath : wrap(CDN + relPath));
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${relPath}`);
  const blob = await resp.blob();
  if (useCache && !isLocal) cachePut(relPath, blob).catch(() => {});
  return { blob, from: 'network' };
}

export async function fetchText(relPath, opts) {
  const { blob } = await fetchAsset(relPath, opts);
  return await blob.text();
}

// 下载模块：把某章涉及的资源一次性拉到本地缓存
export function blobUrl(blob) {
  return URL.createObjectURL(blob);
}

/* ---------- SWF 类库合并 ----------
 * 角色的 View swf 依赖 com.QQ.angel.* 类（在 libs/AngelClientLibs.swf 里，
 * 注意带 _s 后缀的那份是加密的，不带后缀的才是明文）。
 * Ruffle 不支持跨 SWF 共享 AVM2 ApplicationDomain，所以这里把类库的 ABC
 * 直接拼进目标 SWF，再交给 Ruffle —— 实测可以让角色的 AS3 动画跑起来。
 */
const LIB_PATH = "libs/AngelClientLibs.swf";
let libAbc = null;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/* ---------- 运行时倍速：篡改 requestAnimationFrame 的时间戳 ----------
 * Ruffle 0.7.1 的 JS 层没有任何调速接口（setFrameRate 在 0.7.1 里根本不存在，
 * 只在解析 config 时被调用，实测 typeof 是 undefined），帧率只能写进 SWF 头，
 * 于是每次换倍速都得重新拼字节、重新 load —— 这就是「一切倍速就重载」的根源。
 *
 * 但 Ruffle 的主循环时间来自 requestAnimationFrame 回调的时间戳（实测把时间冻住，
 * 画面立刻静止；放开就恢复）。所以只要在交付时间戳时乘一个系数，时间轴就按比例走。
 * 好处：0 延迟、不改字节、不影响已加载的播放器；坏处：作用于所有 Ruffle 实例，
 * 因此只在过场动画播放期间打开，其余时间恒为 1（动画窗口是整屏黑底，盖住了场景层，
 * 场景即便同时被加速也看不见）。
 */
let timeScale = 1;
let patched = false;

export function installTimeScale() {
  if (patched) return;
  patched = true;
  const real = window.requestAnimationFrame.bind(window);
  let vt = 0;
  let lt = null;
  window.requestAnimationFrame = (cb) =>
    real((t) => {
      if (lt === null) lt = t;
      vt += (t - lt) * timeScale;
      lt = t;
      cb(vt);
    });
}

export function setTimeScale(s) {
  const v = Number(s);
  timeScale = Number.isFinite(v) && v > 0 ? Math.min(4, Math.max(0.25, v)) : 1;
}

export function getTimeScale() {
  return timeScale;
}

installTimeScale();

async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function deflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function tagStart(x) {
  const nbits = x[8] >> 3;
  const n = (5 + nbits * 4 + 7) >> 3;
  return 8 + n + 4;
}

function parseTags(x) {
  const tags = [];
  let p = tagStart(x);
  while (p + 2 <= x.length) {
    const cl = u16(x, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(x, p + 2);
      hdr = 6;
    }
    tags.push({ code, raw: x.subarray(p, p + hdr + len), body: x.subarray(p + hdr, p + hdr + len) });
    if (code === 0) break;
    p += hdr + len;
  }
  return tags;
}

// 注：早先这里有个 setFrameRate()，靠改 SWF 头的 8.8 定点帧率实现倍速。
// 那个办法必须重新拼字节并重新 load，切一次倍速就重载一次，已弃用 ——
// 现在改用上面的 requestAnimationFrame 时间缩放，运行时生效。

// 判断一个 SWF 是否依赖 AngelClientLibs。
// 早期用 SymbolClass 的类名去 ABC 里找，但类名既会被定义也会被引用，
// 「出现过」不等于「定义过」，导致 678100 这种明明要类库的角色被判成不需要，
// ABC verify 失败、AS3 整体不执行（表现就是入场动画不停、角色在几帧间抽搐）。
// 直接看 ABC 有没有引用 com.QQ.angel.* 命名空间，有就合并类库。
function needsLib(tags) {
  const abc = tags.filter((t) => t.code === 82).map((t) => t.body);
  if (!abc.length) return false;
  const needle = new TextEncoder().encode("com.QQ.angel");
  return abc.some((a) => indexOfBytes(a, needle) >= 0);
}

function indexOfBytes(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}


// 部分场景的基类 AbstractSceneLogic 在构造时做 gotoAndStop("up")（可交互层），
// 而老场景的 DefineSceneAndFrameLabelData（tag 86）里根本没有这个 label，
// 异常一抛构造函数就中断，BGImage 没被 addChild —— 表现是灰底 + 零星元素。
// 这里给缺少该 label 的场景补一条（指向第 1 帧），让构造能走完。
function encU32(v) {
  const a = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    a.push(b);
  } while (v);
  return a;
}
function decU32(b, o) {
  let v = 0,
    shift = 0,
    x;
  do {
    x = b[o++];
    v |= (x & 0x7f) << shift;
    shift += 7;
  } while (x & 0x80);
  return [v >>> 0, o];
}

function ensureSceneLabel(x, name) {
  const start = tagStart(x);
  let p = start;
  let target = null;
  while (p + 2 <= x.length) {
    const cl = u16(x, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(x, p + 2);
      hdr = 6;
    }
    if (code === 86) {
      target = { pos: p, hdr, len };
      break;
    }
    if (code === 0) break;
    p += hdr + len;
  }
  if (!target) return { x, added: false };

  const body = x.subarray(target.pos + target.hdr, target.pos + target.hdr + target.len);
  const dec = new TextDecoder();
  let o = 0;
  let sceneCount;
  [sceneCount, o] = decU32(body, o);
  for (let i = 0; i < sceneCount; i++) {
    let f;
    [f, o] = decU32(body, o);
    while (o < body.length && body[o] !== 0) o++;
    o++;
  }
  const labelCountOff = o;
  let labelCount;
  [labelCount, o] = decU32(body, o);
  const labelsStart = o;
  let cursor = o;
  const names = [];
  for (let i = 0; i < labelCount; i++) {
    let f;
    [f, cursor] = decU32(body, cursor);
    const s = cursor;
    while (cursor < body.length && body[cursor] !== 0) cursor++;
    names.push(dec.decode(body.subarray(s, cursor)));
    cursor++;
  }
  if (names.includes(name)) return { x, added: false };

  // 重建 body：前面的 scene 段 + 新 count + 原 label 段 + 新 label
  const head = body.subarray(0, labelCountOff);
  const tail = body.subarray(labelsStart, cursor);
  const nb = new TextEncoder().encode(name + "\0");
  const newBody = new Uint8Array(head.length + encU32(labelCount + 1).length + tail.length + 1 + nb.length);
  let w = 0;
  newBody.set(head, w);
  w += head.length;
  newBody.set(encU32(labelCount + 1), w);
  w += encU32(labelCount + 1).length;
  newBody.set(tail, w);
  w += tail.length;
  newBody[w++] = 0; // frame 0
  newBody.set(nb, w);
  w += nb.length;

  // tag 头：短格式最多 0x3e，超了用长格式
  let tagHdr;
  if (w < 0x3f) tagHdr = new Uint8Array([((86 << 6) | w) & 0xff, (((86 << 6) | w) >> 8) & 0xff]);
  else {
    tagHdr = new Uint8Array(6);
    tagHdr[0] = ((86 << 6) | 0x3f) & 0xff;
    tagHdr[1] = (((86 << 6) | 0x3f) >> 8) & 0xff;
    tagHdr[2] = w & 0xff;
    tagHdr[3] = (w >> 8) & 0xff;
    tagHdr[4] = (w >> 16) & 0xff;
    tagHdr[5] = (w >> 24) & 0xff;
  }

  const oldEnd = target.pos + target.hdr + target.len;
  const outLen = x.length - (oldEnd - target.pos) + tagHdr.length + w;
  const y = new Uint8Array(outLen);
  let q = 0;
  y.set(x.subarray(0, target.pos), q);
  q += target.pos;
  y.set(tagHdr, q);
  q += tagHdr.length;
  y.set(newBody, q);
  q += newBody.length;
  y.set(x.subarray(oldEnd), q);
  const fl = y.length;
  y[4] = fl & 0xff;
  y[5] = (fl >> 8) & 0xff;
  y[6] = (fl >> 16) & 0xff;
  y[7] = (fl >> 24) & 0xff;
  return { x: y, added: true };
}


// ToolTipButton 这类按钮类在构造时会对自己的 MC 做 gotoAndStop("up")，
// 老场景的按钮 sprite 里没有 up/over/down 三态标签，异常再把外层构造函数一起带走。
// 给每个 DefineSprite 补上这三态（都指第 1 帧），构造就不会抛了。
function patchSpriteLabels(x) {
  const start = tagStart(x);
  const parts = [];
  let p = start;
  let changed = 0;
  let cursor = start;
  while (p + 2 <= x.length) {
    const cl = u16(x, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(x, p + 2);
      hdr = 6;
    }
    if (code === 0) break;
    if (code === 39 && len > 4) {
      const body = x.subarray(p + hdr, p + hdr + len);
      const patched = patchOneSprite(body);
      if (patched) {
        parts.push({ at: p, end: p + hdr + len, tag: buildTag(39, patched) });
        changed++;
      }
    }
    p += hdr + len;
  }
  if (!changed) return x;

  let total = x.length;
  for (const it of parts) total += it.tag.length - (it.end - it.at);
  const y = new Uint8Array(total);
  let r = 0;
  let w = 0;
  for (const it of parts) {
    y.set(x.subarray(r, it.at), w);
    w += it.at - r;
    y.set(it.tag, w);
    w += it.tag.length;
    r = it.end;
  }
  y.set(x.subarray(r), w);
  w += x.length - r;
  const fl = w;
  y[4] = fl & 0xff;
  y[5] = (fl >> 8) & 0xff;
  y[6] = (fl >> 16) & 0xff;
  y[7] = (fl >> 24) & 0xff;
  return y;
}

function buildTag(code, body) {
  if (body.length < 0x3f) {
    const cl = (code << 6) | body.length;
    const out = new Uint8Array(2 + body.length);
    out[0] = cl & 0xff;
    out[1] = (cl >> 8) & 0xff;
    out.set(body, 2);
    return out;
  }
  const out = new Uint8Array(6 + body.length);
  const cl = (code << 6) | 0x3f;
  out[0] = cl & 0xff;
  out[1] = (cl >> 8) & 0xff;
  out[2] = body.length & 0xff;
  out[3] = (body.length >> 8) & 0xff;
  out[4] = (body.length >> 16) & 0xff;
  out[5] = (body.length >> 24) & 0xff;
  out.set(body, 6);
  return out;
}

const STATE_LABELS = ["up", "over", "down"];

function patchOneSprite(body) {
  // 头部：SpriteID(2) + FrameCount(2)
  const head = body.subarray(0, 4);
  const inner = body.subarray(4);
  const tags = [];
  let p = 0;
  while (p + 2 <= inner.length) {
    const cl = u16(inner, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(inner, p + 2);
      hdr = 6;
    }
    tags.push({ code, pos: p, hdr, len });
    if (code === 0) break;
    p += hdr + len;
  }
  const dec = new TextDecoder();
  const have = new Set();
  for (const t of tags) {
    if (t.code !== 43) continue;
    const b = inner.subarray(t.pos + t.hdr, t.pos + t.hdr + t.len);
    have.add(dec.decode(b).replace(/\0[\s\S]*$/, ""));
  }
  const need = STATE_LABELS.filter((n) => !have.has(n));
  if (!need.length) return null;

  const firstShow = tags.find((t) => t.code === 1);
  if (!firstShow) return null;

  const extra = [];
  for (const name of need) {
    const nb = new TextEncoder().encode(name + "\0");
    const cl = (43 << 6) | nb.length;
    const t = new Uint8Array(2 + nb.length);
    t[0] = cl & 0xff;
    t[1] = (cl >> 8) & 0xff;
    t.set(nb, 2);
    extra.push(t);
  }
  const extraLen = extra.reduce((a, t) => a + t.length, 0);
  const out = new Uint8Array(body.length + extraLen);
  out.set(head, 0);
  out.set(inner.subarray(0, firstShow.pos), 4);
  let w = 4 + firstShow.pos;
  for (const t of extra) {
    out.set(t, w);
    w += t.length;
  }
  out.set(inner.subarray(firstShow.pos), w);
  return out;
}


// 角色 View swf 的主时间轴常常有 2~6 帧：每一帧摆一组不同的角色站位/姿态，
// 原版由 AS3 用 gotoAndStop 精确切换，所以静止。直接丢给 Ruffle 会当成循环动画，
// 在几帧之间来回闪 —— 表现就是「角色疯狂抽搐」。
// 这里把主时间轴截断到第 N 帧（默认第 1 帧），后面的帧丢掉，时间轴播完就停住；
// 角色自身的动作在 DefineSprite 里，不受影响。

// 角色 View swf 的主时间轴有 2~6 帧，是「入场序列」：每帧往舞台上多摆一个角色/物件，
// 原版靠 AS3 的 gotoAndStop 停在最后一帧，所以人物齐全且静止。
// Ruffle 里 AS3 起不来（类库跨 ABC 块的接口解析不了），时间轴就自由循环，
// 在「一个角色 → 两个角色 → 全员」之间高速切换，看起来就是疯狂抽搐。
// 解法：把中间所有 ShowFrame 删掉，只留最后一个，FrameCount 改成 1。
// Flash 的显示列表是累积的，这样第 1 帧就是最终状态（全员 + 最后的位置），并且不再循环。


/* ---------- 让卡死的帧脚本跑完 ----------
 * 角色 View 的 AS3 帧脚本进来第一句是 stage.setModal(false)，Ruffle 的 Stage 没有这个方法，
 * 抛 #1069 后整段脚本中断，后面的 stop() 永远执行不到 —— 入场动画就一直循环。
 *
 * 做法：在 ABC 里把这条调用指令「callpropvoid(setModal, 1 个参数)」换成「pop pop nop」。
 *   callpropvoid 消耗 receiver + arg、不产生返回值；两条 pop 消耗同样的两个值，栈深度一致，
 *   max_stack 不用改，字节长度也保持一样，不动任何索引和偏移。
 * 只改这一条指令，方法其余逻辑原样保留。
 */
function u30At(b, p) {
  let v = 0,
    shift = 0,
    byte;
  do {
    byte = b[p++];
    v |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [v >>> 0, p];
}

// 解析到 multiname 表，返回 setModal 的 multiname 索引（失败返回 -1）
function findMultinameIndex(abc) {
  let p = 4; // 跳过 minor/major
  const rd = () => {
    const [v, np] = u30At(abc, p);
    p = np;
    return v;
  };
  const skipS32 = () => {
    let byte;
    do {
      byte = abc[p++];
    } while (byte & 0x80);
  };

  let n = rd();
  for (let i = 0; i < Math.max(0, n - 1); i++) skipS32();
  n = rd();
  for (let i = 0; i < Math.max(0, n - 1); i++) rd();
  n = rd();
  p += 8 * Math.max(0, n - 1);

  const strings = [""];
  n = rd();
  const dec = new TextDecoder();
  for (let i = 0; i < Math.max(0, n - 1); i++) {
    const len = rd();
    strings.push(dec.decode(abc.subarray(p, p + len)));
    p += len;
  }

  n = rd();
  for (let i = 0; i < Math.max(0, n - 1); i++) {
    p += 1;
    rd();
  }
  n = rd();
  for (let i = 0; i < Math.max(0, n - 1); i++) {
    const c = rd();
    for (let j = 0; j < c; j++) rd();
  }

  const mn = [null];
  n = rd();
  for (let i = 0; i < Math.max(0, n - 1); i++) {
    const kind = abc[p++];
    if (kind === 0x07 || kind === 0x0d || kind === 0x09 || kind === 0x0e) {
      mn.push([rd(), rd()]);
    } else if (kind === 0x0f || kind === 0x10) {
      mn.push([0, rd()]);
    } else if (kind === 0x11 || kind === 0x12) {
      mn.push([0, 0]);
    } else if (kind === 0x1b || kind === 0x1c) {
      mn.push([rd(), 0]);
    } else if (kind === 0x1d) {
      const base = rd();
      const c = rd();
      for (let j = 0; j < c; j++) rd();
      mn.push([0, base]);
    } else {
      return -1;
    }
  }

  let target = -1;
  for (let i = 0; i < strings.length; i++) {
    if (strings[i] === "setModal") {
      target = i;
      break;
    }
  }
  if (target < 0) return -1;
  // 多名字里 name 索引指向 setModal 的那一条
  for (let i = 1; i < mn.length; i++) {
    if (mn[i] && mn[i][1] === target) return i;
  }
  return -1;
}

function patchSetModalCall(x) {
  let patched = 0;
  for (const t of parseTags(x)) {
    if (t.code !== 82 || !t.body) continue;
    const start = t.body.byteOffset - x.byteOffset;
    // DoABC: 4 字节 flags + null 结尾 name + ABC
    const head = x.subarray(start, start + Math.min(64, t.body.length));
    let z = -1;
    for (let i = 4; i < head.length; i++) {
      if (head[i] === 0) {
        z = i;
        break;
      }
    }
    if (z < 0) continue;
    const abcOff = start + z + 1;
    const abc = x.subarray(abcOff, start + t.body.length);
    const idx = findMultinameIndex(abc);
    if (idx < 0 || idx >= 128) continue;

    // callpropvoid(0x4F) + u30(idx) + arg_count(0x01)  ->  pop pop nop
    const pat = new Uint8Array([0x4f, idx, 0x01]);
    for (let i = 0; i + 3 <= abc.length; i++) {
      if (abc[i] !== 0x4f || abc[i + 1] !== idx || abc[i + 2] !== 0x01) continue;
      abc[i] = 0x29;
      abc[i + 1] = 0x29;
      abc[i + 2] = 0x02;
      patched++;
      i += 2;
    }
  }
  return patched;
}

// 只保留到第 n 帧（1 起）并压成单帧：去掉前面所有 ShowFrame，丢掉 n 之后的标签，
// 这样角色层直接显示剧本 state 对应的那一帧，不会循环、也不会停在最后一帧。
function flattenToFrame(x, n) {
  const nbits = x[8] >> 3;
  const rectLen = (5 + nbits * 4 + 7) >> 3;
  const fcOff = 8 + rectLen + 2;
  const ts = 8 + rectLen + 4;
  const tags = [];
  let p = ts;
  while (p + 2 <= x.length) {
    const cl = u16(x, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(x, p + 2);
      hdr = 6;
    }
    tags.push({ code, pos: p, size: hdr + len });
    if (code === 0) break;
    p += hdr + len;
  }
  const shows = tags.filter((t) => t.code === 1);
  if (!shows.length) return x;
  const idx = Math.max(1, Math.min(n | 0, shows.length)) - 1;
  const target = shows[idx];
  const keepUntil = target.pos + target.size;

  const parts = [x.subarray(0, ts)]; // 先放文件头，不然签名都没了
  let r = ts;
  for (const t of tags) {
    if (t.pos >= keepUntil) break;
    if (t.code === 1) {
      r = t.pos + t.size; // 前面的 ShowFrame 丢掉，标签内容留着
      continue;
    }
    if (t.pos > r) parts.push(x.subarray(r, t.pos));
    parts.push(x.subarray(t.pos, t.pos + t.size));
    r = t.pos + t.size;
  }
  parts.push(new Uint8Array([0x00, 0x00])); // End
  let total = 0;
  for (const q of parts) total += q.length;
  const y = new Uint8Array(total);
  let w = 0;
  for (const q of parts) {
    y.set(q, w);
    w += q.length;
  }
  // 帧数改成 1（已压平）
  const nb = y[8] >> 3;
  const rl = (5 + nb * 4 + 7) >> 3;
  const fc = 8 + rl + 2;
  y[fc] = 1;
  y[fc + 1] = 0;
  const fl = y.length;
  y[4] = fl & 0xff;
  y[5] = (fl >> 8) & 0xff;
  y[6] = (fl >> 16) & 0xff;
  y[7] = (fl >> 24) & 0xff;
  return y;
}

function collapseTimeline(x) {
  const nbits = x[8] >> 3;
  const rectLen = (5 + nbits * 4 + 7) >> 3;
  const fcOff = 8 + rectLen + 2;

  const ts = 8 + rectLen + 4;
  const tags = [];
  let p = ts;
  while (p + 2 <= x.length) {
    const cl = u16(x, p);
    let code = cl >> 6,
      len = cl & 0x3f,
      hdr = 2;
    if (len === 0x3f) {
      len = u32(x, p + 2);
      hdr = 6;
    }
    tags.push({ code, pos: p, size: hdr + len });
    if (code === 0) break;
    p += hdr + len;
  }
  const showIdx = tags.map((t, i) => (t.code === 1 ? i : -1)).filter((i) => i >= 0);
  if (showIdx.length <= 1) return x;
  const lastShow = showIdx[showIdx.length - 1];

  const drop = new Set(showIdx.filter((i) => i !== lastShow).map((i) => tags[i].pos));
  let newLen = x.length;
  for (const t of tags) if (drop.has(t.pos)) newLen -= t.size;
  if (newLen === x.length) return x;

  const parts = [];
  let r = 0;
  for (const t of tags) {
    if (drop.has(t.pos)) {
      r = t.pos + t.size;
      continue;
    }
    if (t.pos > r) parts.push(x.subarray(r, t.pos));
    parts.push(x.subarray(t.pos, t.pos + t.size));
    r = t.pos + t.size;
  }
  if (r < x.length) parts.push(x.subarray(r));
  let total = 0;
  for (const q of parts) total += q.length;
  const y = new Uint8Array(total);
  let w = 0;
  for (const q of parts) {
    y.set(q, w);
    w += q.length;
  }
  y[fcOff] = 1;
  y[fcOff + 1] = 0;
  const fl = y.length;
  y[4] = fl & 0xff;
  y[5] = (fl >> 8) & 0xff;
  y[6] = (fl >> 16) & 0xff;
  y[7] = (fl >> 24) & 0xff;
  return y;
}


async function loadLibAbc() {
  if (libAbc) return libAbc;
  const { blob } = await fetchAsset(LIB_PATH);
  let x = new Uint8Array(await blob.arrayBuffer());
  if (String.fromCharCode(x[0], x[1], x[2]) === "CWS") {
    x = new Uint8Array([...x.subarray(0, 8), ...(await inflate(x.subarray(8)))]);
  }
  const abc = parseTags(x).filter((t) => t.code === 82).map((t) => t.raw);
  libAbc = abc;
  return libAbc;
}

// 合并结果缓存：同一章里来回切场景时不必重复拼字节（每条约 1MB，只留最近 8 条）
const mergedCache = new Map();
const MERGED_MAX = 8;

/** 需要时把类库 ABC 拼进目标 SWF；返回可直接喂给 Ruffle 的 Blob */
export async function fetchSwfWithLib(relPath, opts = {}) {
  const ck = relPath + (opts.frame ? "#" + opts.frame : "");
  if (mergedCache.has(ck)) return mergedCache.get(ck);
  const out = await buildSwfWithLib(relPath, opts);
  mergedCache.set(ck, out);
  if (mergedCache.size > MERGED_MAX) mergedCache.delete(mergedCache.keys().next().value);
  return out;
}

async function buildSwfWithLib(relPath, opts) {
  const { blob } = await fetchAsset(relPath);
  try {
    let x = new Uint8Array(await blob.arrayBuffer());
    const sig = String.fromCharCode(x[0], x[1], x[2]);
    let compressed = false;
    if (sig === "CWS") {
      x = new Uint8Array([...x.subarray(0, 8), ...(await inflate(x.subarray(8)))]);
      compressed = true;
    } else if (sig !== "FWS") {
      return blob; // 不是标准 SWF，原样返回
    }

    // 角色 View：先把主时间轴截到第 1 帧，否则多帧循环会让人物抽搐
    if (relPath.includes("/npc/")) {
      const before = x.length;
      const fixed = patchSetModalCall(x);
      if (fixed) console.log("[swf] setModal 调用改为 pop pop x" + fixed, relPath);
      // frame：只保留到第 N 帧并压成单帧（剧本里的 state_N），否则退回原来的「合并到最后帧」
      x = opts.frame ? flattenToFrame(x, opts.frame) : collapseTimeline(x);
      if (x.length !== before) console.log("[swf] 合并帧", relPath, "frame", opts.frame || "-", before, "->", x.length);
    }

    const tags = parseTags(x);
    const hasAbc = tags.some((t) => t.code === 82);
    if (hasAbc && !needsLib(tags)) {
      // 自己的类齐全，不需要类库；只按倍速改帧率
      const y = new Uint8Array(x);
      if (compressed) {
        const packed = await deflate(y.subarray(8));
        const out2 = new Uint8Array(8 + packed.length);
        out2.set(y.subarray(0, 8), 0);
        out2.set(packed, 8);
        return new Blob([out2], { type: "application/x-shockwave-flash" });
      }
      return new Blob([y], { type: "application/x-shockwave-flash" });
    }
    if (!hasAbc) {
      // 纯图形 SWF：不改类库，但依然要按倍速改帧率
      const y = new Uint8Array(x);
      if (compressed) {
        const packed = await deflate(y.subarray(8));
        const out2 = new Uint8Array(8 + packed.length);
        out2.set(y.subarray(0, 8), 0);
        out2.set(packed, 8);
        return new Blob([out2], { type: "application/x-shockwave-flash" });
      }
      return new Blob([y], { type: "application/x-shockwave-flash" });
    }

    const abc = await loadLibAbc();
    if (!abc.length) return blob;

    // 插在 FileAttributes(69) / SetBackgroundColor(9) 之后
    let head = tagStart(x);
    let insertAt = head;
    for (const t of tags) {
      if (t.code === 69 || t.code === 9) insertAt += t.raw.length;
      else break;
    }
    const before = x.subarray(0, insertAt);
    const after = x.subarray(insertAt);

    const parts = [before, ...abc, after];
    let total = 0;
    for (const p of parts) total += p.length;
    let out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // 场景：补帧标签（角色/动画的 SWF 结构不同，别动）
    if (relPath.includes("/scene/")) {
      const patched = ensureSceneLabel(out, "up");
      out = patched.x;
      const pre = out.length;
      out = patchSpriteLabels(out);
      if (patched.added || out.length !== pre) console.log("[swf] 补标签", relPath, pre, "->", out.length);
    }
    // 更新 FileLength
    const fl = out.length;
    out[4] = fl & 0xff;
    out[5] = (fl >> 8) & 0xff;
    out[6] = (fl >> 16) & 0xff;
    out[7] = (fl >> 24) & 0xff;

    let final = out;
    if (compressed) {
      const packed = await deflate(out.subarray(8));
      final = new Uint8Array(8 + packed.length);
      final.set(out.subarray(0, 8), 0);
      final.set(packed, 8);
      final[0] = 0x43; // C
      final[1] = 0x57; // W
      final[2] = 0x53; // S
    }
    return new Blob([final], { type: "application/x-shockwave-flash" });
  } catch (e) {
    console.log("[swf] 处理失败，回退原文件", relPath, e.message);
    return blob;
  }
}

/* ---------- 背景音乐：从音乐 SWF 里抽出裸 MP3 ----------
 * 音乐 SWF 只有一个时间轴帧，音频是 SoundStream 挂在这一帧上。交给 Ruffle 播，
 * 时间轴 1/24 秒就停在第一帧，声音起不来（也不会循环）—— 这是之前"没音乐"的原因。
 * 这里把 SWF 解压、定位到第一个 MP3 帧、截出裸流，交给 <audio loop> 播，
 * 循环、音量、暂停都变成浏览器原生行为。
 */
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLES = [44100, 48000, 32000];
const musicCache = new Map();

function findMp3Start(x) {
  for (let i = 0; i < x.length - 4; i++) {
    if (x[i] !== 0xff) continue;
    const b1 = x[i + 1];
    if (b1 !== 0xfb && b1 !== 0xf3 && b1 !== 0xf2 && b1 !== 0xfa) continue;
    const b2 = x[i + 2];
    const bi = (b2 >> 4) & 0x0f;
    const si = (b2 >> 2) & 0x03;
    if (!BITRATES[bi] || si === 3) continue;
    // 用帧长验证下一帧是否也是同步字，避免撞到 SWF 头里的巧合字节
    const pad = (b2 >> 1) & 1;
    const len = Math.floor((144 * BITRATES[bi] * 1000) / SAMPLES[si]) + pad;
    if (i + len < x.length && x[i + len] === 0xff) return i;
    if (i + 1000 < x.length) return i; // 单帧兜底
  }
  return -1;
}

/** 取一首背景音乐，返回可直接喂给 <audio> 的 Blob */
export async function fetchMusicAudio(file) {
  if (musicCache.has(file)) return musicCache.get(file);
  const { blob } = await fetchAsset(`res/music/${file}`);
  let x = new Uint8Array(await blob.arrayBuffer());
  const sig = String.fromCharCode(x[0], x[1], x[2]);
  if (sig === "CWS") {
    const body = await inflate(x.subarray(8));
    const y = new Uint8Array(8 + body.length);
    y.set(x.subarray(0, 8), 0);
    y.set(body, 8);
    x = y;
  } else if (sig !== "FWS") {
    throw new Error("不是标准 SWF");
  }
  const start = findMp3Start(x);
  if (start < 0) throw new Error("SWF 里没有 MP3 流");
  const out = new Blob([x.subarray(start)], { type: "audio/mpeg" });
  musicCache.set(file, out);
  return out;
}

/* ---------- 场景底图兜底 ----------
 * 有些场景（地下研究室 394、暗黑实验室 372）的 BGImage 是 AS3 在构造函数里挂上去的，
 * 而构造函数还会调用 CheckActNpc() 之类依赖游戏主框架单例（IAngelSysAPI）的逻辑，
 * 在 Ruffle 里必然抛 #1009，整个构造中断，背景就没挂上 —— 只剩时间轴上的零星元素。
 * 这些 SWF 里本来就嵌着一张 960×560 的完整背景 JPEG，直接从字节里抽出来当底图，
 * 叠在 Ruffle 层下面。Ruffle 若能正常渲染自己的背景，会把它完全盖住，不影响正常场景。
 */
const bgCache = new Map();

function jpegSize(x, start) {
  let i = start + 2;
  while (i < x.length - 9) {
    if (x[i] !== 0xff) { i++; continue; }
    const m = x[i + 1];
    if (m === 0xd8 || m === 0xd9) { i += 2; continue; }
    const segLen = (x[i + 2] << 8) | x[i + 3];
    if (m >= 0xc0 && m <= 0xc3) {
      const h = (x[i + 5] << 8) | x[i + 6];
      const w = (x[i + 7] << 8) | x[i + 8];
      return { w, h };
    }
    i += 2 + segLen;
  }
  return null;
}

function findBackdrop(x) {
  let best = null;
  for (let i = 0; i + 3 < x.length; i++) {
    if (x[i] !== 0xff || x[i + 1] !== 0xd8 || x[i + 2] !== 0xff) continue;
    const sz = jpegSize(x, i);
    if (!sz) continue;
    let e = i + 2;
    while (e < x.length - 1 && !(x[e] === 0xff && x[e + 1] === 0xd9)) e++;
    if (e >= x.length - 1) break;
    if (sz.w === 960 && sz.h === 560) {
      const len = e + 2 - i;
      if (!best || len > best.len) best = { start: i, end: e + 2, len };
    }
    i = e + 1;
  }
  return best;
}

/** 取场景的 960×560 底图，返回 blob URL（取不到返回 null） */
export async function sceneBackdrop(sceneId, ver = 1) {
  const key = `${sceneId}.${ver}`;
  if (bgCache.has(key)) return bgCache.get(key);
  let url = null;
  try {
    const { blob } = await fetchAsset(path.scene(sceneId, ver));
    let x = new Uint8Array(await blob.arrayBuffer());
    if (String.fromCharCode(x[0], x[1], x[2]) === "CWS") {
      const body = await inflate(x.subarray(8));
      const y = new Uint8Array(8 + body.length);
      y.set(x.subarray(0, 8), 0);
      y.set(body, 8);
      x = y;
    }
    const found = findBackdrop(x);
    if (found) url = URL.createObjectURL(new Blob([x.subarray(found.start, found.end)], { type: "image/jpeg" }));
  } catch (e) {
    console.warn("底图提取失败", sceneId, e.message);
  }
  bgCache.set(key, url);
  return url;
}

/* ---------- 过场动画分类 ----------
 * 人工复核过 2714 段（1717 保留 / 997 剔除），结论是「视频类」在肉眼上有两个特征：
 *   · 一块较小的固定画幅（画面只占窗口中间一块）
 *   · 没有反复出现的交互按钮（不靠点击推进）
 * 但这两点都没法从 SWF 结构里可靠读出来：根节点放置都是 1:1、无缩放，内容坐标在 sprite
 * 局部系里，两类片子都可能是几十秒的长动画。实测过「内容包围盒」「根节点矩阵」「帧间变化区」
 * 三种代理，都在 80% 上下，不如人工一眼。
 *
 * 结构上真正拉开差距的是时长与舞台上的对象数：
 *   保留组中位：最长 sprite 611 帧 / 25 秒 / 根节点 1 个对象 / 101 个 sprite
 *   剔除组中位：最长 sprite 121 帧 /  5 秒 / 根节点 2 个对象 /  13 个 sprite
 *
 * 所以自动判据只做「分诊」，不追求精度，并且刻意偏向「宁可多显示」——
 * 漏掉一段视频是内容丢失，多显示一段漫画只是多点一下。
 *   maxFrames >= 150  &&  rootPlaces <= 3
 * 在复核样本上召回 99.0%（只藏起 17 段本该保留的），误收 117 段。
 * 新章节的最终结论请写回 data/anim_review.json，人工表永远优先。
 */
const kindCache = new Map();

const SHAPE_TAGS = new Set([2, 22, 32, 83, 84]);
const PLACE_TAGS = new Set([4, 26, 70]);

/** 返回 { kind, frames, fps, durMs, shapes, places }：kind 为 video / comic */
export async function animInfo(relPath) {
  if (kindCache.has(relPath)) return kindCache.get(relPath);
  let info = { kind: "comic", frames: 0, fps: 0, durMs: 0, shapes: 0, places: 0 };
  try {
    const { blob } = await fetchAsset(relPath);
    let x = new Uint8Array(await blob.arrayBuffer());
    if (String.fromCharCode(x[0], x[1], x[2]) === "CWS") {
      const body = await inflate(x.subarray(8));
      const y = new Uint8Array(8 + body.length);
      y.set(x.subarray(0, 8), 0);
      y.set(body, 8);
      x = y;
    }
    let maxFrames = 0;
    let sprites = 0;
    let shapes = 0;
    let places = 0;
    for (const t of parseTags(x)) {
      if (SHAPE_TAGS.has(t.code)) shapes++;
      else if (PLACE_TAGS.has(t.code)) places++;
      if (t.code !== 39 || !t.body || t.body.length < 4) continue;
      sprites++;
      const f = t.body[2] | (t.body[3] << 8);
      if (f > maxFrames) maxFrames = f;
    }
    const nbits = x[8] >> 3;
    const n = (5 + nbits * 4 + 7) >> 3;
    const fps = u16(x, 8 + n) / 256;
    info = {
      kind: maxFrames >= 150 && places <= 3 ? "video" : "comic",
      frames: maxFrames,
      fps,
      durMs: fps > 0 ? Math.round((maxFrames / fps) * 1000) : 0,
      sprites,
      shapes,
      places,
    };
  } catch (e) {
    console.warn("动画类型判断失败", relPath, e.message);
  }
  kindCache.set(relPath, info);
  return info;
}

export async function animKind(relPath) {
  return (await animInfo(relPath)).kind;
}

// 人工复核表：keep 明确按视频类处理，skip 明确按漫画处理，其余交自动判据。
// 阅读模式用它决定显示哪些过场，播放器用它决定哪些过场吃"缩放"。
let reviewPromise = null;
export function animReview() {
  if (!reviewPromise) {
    reviewPromise = fetch("data/anim_review.json")
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => ({ keep: new Set(j.keep || []), skip: new Set(j.skip || []) }))
      .catch(() => ({ keep: new Set(), skip: new Set() }));
  }
  return reviewPromise;
}

export async function animKindFor(src, relPath) {
  const key = animKeyFromSrc(src || relPath);
  if (key) {
    const rv = await animReview();
    if (rv.keep.has(key)) return "video";
    if (rv.skip.has(key)) return "comic";
  }
  return animKind(relPath);
}
