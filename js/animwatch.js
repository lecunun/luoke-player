/* 过场动画「播完」判定
 *
 * 背景：Ruffle 没有 ended 事件，isPlaying 恒为 true，JS API 也没有当前帧。
 * 之前用 canvas.toDataURL() 采样，但在 WebGL 渲染下拿到的是被合成器清空的缓冲，
 * 每帧都是同一张几 KB 的空图 —— 于是「连续 7 帧相同」在第 2.8 秒就成立，
 * 10 秒的动画被硬生生掐断在 3 秒。这不是判得不准，是根本没看到画面。
 *
 * 现在改成 captureStream()：把画布的合成输出接成 MediaStream，再 drawImage 到
 * 一张 160×90 的小 2D 画布上取校验和。WebGL 画布也能拿到真实帧（实测 3 秒内
 * 有 8 个不同签名，且能看出一段停留）。连续 quietMs 画面不变才算播完。
 *
 * 万一环境不支持 captureStream，退回「按片长」：最长 sprite 帧数 / fps 再加一点余量。
 */

function makeSampler(player) {
  const cv = player?.shadowRoot?.querySelector("canvas");
  if (!cv || typeof cv.captureStream !== "function") return null;
  let video = null;
  let ctx = null;
  let dst = null;
  try {
    const stream = cv.captureStream(8);
    video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    dst = document.createElement("canvas");
    dst.width = 160;
    dst.height = 90;
    ctx = dst.getContext("2d", { willReadFrequently: true });
  } catch {
    return null;
  }
  return {
    sig() {
      try {
        if (!video || video.readyState < 2) return "";
        ctx.drawImage(video, 0, 0, 160, 90);
        const d = ctx.getImageData(0, 0, 160, 90).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 32) {
          h ^= d[i];
          h = Math.imul(h, 16777619);
        }
        return String(h >>> 0);
      } catch {
        return "";
      }
    },
    stop() {
      try { video.pause(); } catch {}
      try { video.srcObject?.getTracks?.().forEach((t) => t.stop()); } catch {}
      try { video.srcObject = null; } catch {}
      video = null;
    },
  };
}

/**
 * 监听过场动画是否播完。
 * @returns 取消函数
 */
export function watchAnim(player, onEnd, { maxMs = 45000, durMs = 0, quietMs = 2000 } = {}) {
  let alive = true;
  const t0 = Date.now();
  const sampler = makeSampler(player);
  const quietNeed = Math.max(3, Math.round(quietMs / 400));
  let last = "";
  let still = 0;
  let changed = 0;

  /* 硬上限：最长 sprite 走完一遍的时长。
   * 这些 SWF 的 sprite 默认是循环播放的（实测 3684_0 的 328 帧、7002_0 的 991 帧
   * 都没有 stop 动作），所以「播完」对它们只可能是「播完一圈」。
   * 画面先静止的（多数短片）由 quiet 判定提前收，循环片就等这一圈走完。 */
  const hardMs = durMs > 0 ? Math.min(maxMs, Math.round(durMs + 600)) : maxMs;

  const finish = (why) => {
    if (!alive) return;
    alive = false;
    try { sampler?.stop(); } catch {}
    onEnd(why);
  };

  const tick = () => {
    if (!alive) return;
    const elapsed = Date.now() - t0;
    if (elapsed > maxMs) return finish("timeout");
    if (elapsed > hardMs) return finish("dur");
    if (!sampler) {
      setTimeout(tick, 400);
      return;
    }
    const sig = sampler.sig();
    if (sig) {
      if (sig === last) still++;
      else {
        still = 0;
        changed++;
        last = sig;
      }
      // 至少要看到过一次变化，避免开场静止 2 秒就被判成播完
      if (changed >= 2 && still >= quietNeed) return finish("still");
    }
    setTimeout(tick, 400);
  };
  setTimeout(tick, 700);

  return () => {
    alive = false;
    try { sampler?.stop(); } catch {}
  };
}
