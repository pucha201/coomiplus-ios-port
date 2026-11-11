#!/bin/sh
# 在 iSH 内安装 Coomi 引擎（幂等）。
#
# 用法（在 iSH 里执行）：
#   sh /root/install-in-ish.sh [二进制来源]
#
# 二进制来源可以是：
#   · 省略 —— 从当前目录的 dist/coomi（或 coomi）拷贝；
#   · 一个 URL —— 用 curl 下载；
#   · 一个已存在的路径 —— 直接拷贝。
#
# 为什么坚持 **iSH 内本机编译/安装** 而不是交叉编译产物：
#   iSH 是 i686 用户态模拟，交叉编译出的 musl 二进制理论上能跑，
#   但 ring 之类的 C 依赖需要匹配的 musl-gcc 与 as；本机编译最省事也最可靠
#   （ring 自带 x86 预生成汇编，iSH 里 gcc 直接就能编）。

set -eu

HOME_DIR="${COOMI_HOME:-/root/.coomi}"
BIN_DIR="/usr/local/bin"
WEB_DIR="$HOME_DIR/web"
LOG="$HOME_DIR/engine.log"
SRC="${1:-}"

say() { printf '%s\n' "$*"; }

say "==> 1/5 检查架构"
ARCH="$(uname -m)"
say "    uname -m = $ARCH"
case "$ARCH" in
  i686|i386|x86) : ;;
  *)
    say "!! 当前不是 x86 32 位用户态（iSH 应为 i686）。"
    say "   arm64 的 Linux 可执行文件在 iSH 里无法运行（iSH 是 x86 模拟器）。"
    exit 1
    ;;
esac

say "==> 2/5 准备目录"
mkdir -p "$HOME_DIR" "$WEB_DIR"
say "    home = $HOME_DIR"

say "==> 3/5 安装引擎二进制"
if [ -n "$SRC" ]; then
  case "$SRC" in
    http://*|https://*)
      say "    下载 $SRC"
      curl -fsSL "$SRC" -o /tmp/coomi
      ;;
    *)
      say "    拷贝 $SRC"
      cp "$SRC" /tmp/coomi
      ;;
  esac
elif [ -f ./coomi ]; then
  cp ./coomi /tmp/coomi
elif [ -f ./dist/coomi ]; then
  cp ./dist/coomi /tmp/coomi
else
  say "!! 找不到引擎二进制。"
  say "   请先在本目录执行： cargo build --release --no-default-features -p coomi-ui --bin coomi"
  say "   然后： cargo build ... 的产物在 apps/coomi-rs/target/release/coomi"
  exit 1
fi

chmod +x /tmp/coomi
mkdir -p "$BIN_DIR"
mv /tmp/coomi "$BIN_DIR/coomi"
say "    已安装到 $BIN_DIR/coomi"

say "==> 4/5 自检（--version）"
if ! "$BIN_DIR/coomi" --version; then
  say "!! 二进制无法执行。常见原因："
  say "   · 架构不匹配（见上面 uname -m）"
  say "   · 缺少 musl libc（iSH 自带，一般不会缺）"
  exit 1
fi

say "==> 5/5 放置前端静态文件"
if [ -d ./dist ]; then
  cp -r ./dist/* "$WEB_DIR"/ 2>/dev/null || true
  say "    已从 ./dist 拷贝前端"
elif [ -f ./web.zip ]; then
  ( cd "$WEB_DIR" && unzip -oq ./web.zip ) || true
  say "    已从 web.zip 解包前端"
else
  say "    （跳过）没有找到前端产物：WebView 会显示 API-only 提示页。"
  say "    可把构建好的 apps/web/dist 拷到 $WEB_DIR。"
fi

say ""
say "完成。引擎可用下面命令手动启动（App 会自动做同样的事）："
say "  COOMI_DISABLE_IROH=1 nohup $BIN_DIR/coomi serve \\"
say "    --home $HOME_DIR --cwd /root --port 28080 --token test \\"
say "    --static-dir $WEB_DIR >> $LOG 2>&1 &"
say ""
say "验证： curl -H 'Authorization: Bearer test' http://127.0.0.1:28080/api/runtime/health"
