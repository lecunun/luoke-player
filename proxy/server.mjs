// 洛克王国怀旧播放器 - 本地服务
// 用途：托管本目录的静态文件，并转发到官方资源服务器（该服务器不返回 Access-Control-Allow-Origin）
// 用法：node proxy/server.mjs   然后访问 http://127.0.0.1:8787/
// 注意：只监听 127.0.0.1，不对外提供服务；本项目不做任何在线部署。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 8787;
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ALLOW = new Set(["res.17roco.qq.com", "17roco.qq.com", "web2.17roco.qq.com"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".swf": "application/x-shockwave-flash",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");

  if (u.pathname === "/proxy") {
    const target = u.searchParams.get("url");
    if (!target) return send(res, 400, "missing url param");
    let t;
    try {
      t = new URL(target);
    } catch {
      return send(res, 400, "bad url");
    }
    if (!ALLOW.has(t.hostname)) return send(res, 403, "host not allowed: " + t.hostname);

    try {
      const upstream = await fetch(t.href, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36",
          Referer: "https://17roco.qq.com/",
        },
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(buf);
    } catch (e) {
      send(res, 502, "upstream failed: " + e.message);
    }
    return;
  }

  // 静态文件
  // 目录路径补 index.html（/audit/ 这种直接可开）
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found");
    const ext = path.extname(file).toLowerCase();
    const head = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    };
    // 数据表与本地脚本都会随开发改动，别让浏览器拿旧副本（图片/SWF 照旧走缓存）
    if (ext === ".json" || ext === ".js" || ext === ".css" || ext === ".html") {
      head["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, head);
    res.end(data);
  });
});

function send(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(text);
}

// 傻瓜式启动：node proxy/server.mjs --open  起服务后自动用默认浏览器打开
const OPEN = process.argv.includes("--open");
const URL_LOCAL = `http://127.0.0.1:${PORT}/`;

function openBrowser() {
  const cmd =
    process.platform === "win32"
      ? `start "" "${URL_LOCAL}"`
      : process.platform === "darwin"
        ? `open "${URL_LOCAL}"`
        : `xdg-open "${URL_LOCAL}"`;
  exec(cmd, { shell: true }, () => {});
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // 已经有一个实例在跑（比如双击了两次）：直接把浏览器指过去，不再报错
    console.log(`端口 ${PORT} 已被占用，应该是播放器已经在运行：${URL_LOCAL}`);
    if (OPEN) openBrowser();
    setTimeout(() => process.exit(0), 600);
    return;
  }
  console.error("启动失败:", e.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`播放器: ${URL_LOCAL}`);
  console.log(`代理:   ${URL_LOCAL}proxy?url=<encoded target>`);
  console.log("关闭这个窗口即停止服务。");
  if (OPEN) openBrowser();
});
