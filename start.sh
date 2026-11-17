#!/usr/bin/env bash
# 启动播放器：优先用项目自带的 runtime/node，其次系统 node（需 18+），
# 都没有就尝试下载一份便携版到 runtime/，最后才提示手动安装。
set -u
cd "$(dirname "$0")" || exit 1

VER="v22.22.2"
NODE=""

major_of() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

if [ -x "runtime/node" ]; then
  NODE="runtime/node"
elif command -v node >/dev/null 2>&1; then
  maj="$(major_of node)"
  if [ -n "${maj:-}" ] && [ "$maj" -ge 18 ] 2>/dev/null; then
    NODE="node"
  fi
fi

if [ -z "$NODE" ]; then
  echo "Node.js 18+ 未找到，正在下载便携版（约 30MB，仅首次）…"
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) [ "$arch" = "arm64" ] && pkg="node-$VER-darwin-arm64" || pkg="node-$VER-darwin-x64" ;;
    Linux)  [ "$arch" = "aarch64" ] && pkg="node-$VER-linux-arm64" || pkg="node-$VER-linux-x64" ;;
    *) echo "不支持的系统：$os，请自行安装 Node.js 18+。"; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  got=""
  for base in "https://cdn.npmmirror.com/binaries/node" "https://nodejs.org/dist"; do
    echo "  尝试 $base"
    if curl -fL --connect-timeout 20 --max-time 1800 -o "$tmp/$pkg.tar.gz" "$base/$VER/$pkg.tar.gz"; then
      got="$tmp/$pkg.tar.gz"
      break
    fi
  done
  if [ -z "$got" ]; then
    rm -rf "$tmp"
    echo "下载失败。请安装 Node.js 18+（https://nodejs.org/）后重试。"
    exit 1
  fi
  tar -xzf "$got" -C "$tmp" || { rm -rf "$tmp"; echo "解压失败。"; exit 1; }
  mkdir -p runtime
  cp "$tmp/$pkg/bin/node" runtime/node && chmod +x runtime/node
  rm -rf "$tmp"
  if [ -x "runtime/node" ]; then
    NODE="runtime/node"
    echo "完成：runtime/node"
  fi
fi

if [ -z "$NODE" ]; then
  echo "找不到可用的 Node.js，请安装 18+ 后重试。"
  exit 1
fi

exec "$NODE" proxy/server.mjs --open
