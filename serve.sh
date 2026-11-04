#!/usr/bin/env bash
# serve.sh —— 本地起静态服务，并在局域网暴露，方便用 iPhone 访问测试
# 用法： ./serve.sh [端口]   默认端口 8080
set -e

PORT="${1:-8080}"
cd "$(dirname "$0")"

echo "📚 listen-book-ios 本地服务已启动"
echo "   本机：   http://localhost:${PORT}/"
echo "   局域网： 同一 Wi-Fi 下，用 iPhone 打开下面的地址"

# 尝试探测局域网 IP（Linux / macOS 通用）
IP=""
if command -v ip >/dev/null 2>&1; then
  IP=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '^127\.' | head -n1)
elif command -v ifconfig >/dev/null 2>&1; then
  IP=$(ifconfig 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '^127\.' | head -n1)
fi
if [ -n "$IP" ]; then
  echo "           http://${IP}:${PORT}/"
else
  echo "           （未能自动探测 IP，请自行查看电脑局域网地址）"
fi

echo ""
echo "   在 iPhone 的 Safari 打开后，点「分享 → 添加到主屏幕」即可像 App 一样使用。"
echo "   按 Ctrl+C 停止服务。"
echo ""

exec python3 -m http.server "$PORT"
