#!/usr/bin/env bash
# 双击或 ./start.sh 启动；起服务后自动用默认浏览器打开播放器
cd "$(dirname "$0")" || exit 1

if [ -x "runtime/node" ]; then
  NODE="runtime/node"
elif command -v node >/dev/null 2>&1; then
  NODE="node"
else
  echo "Node.js not found. Put a node binary into ./runtime/ or install Node.js 18+."
  exit 1
fi

exec "$NODE" proxy/server.mjs --open
