#!/bin/sh
# 构建 iOS（iSH）用的引擎二进制 + 最小 rootfs。
#
# 用法（在 iSH 内部执行，或在任意 i686 Alpine 环境里执行）：
#   sh build-ios-runtime.sh [输出目录]
#
# 产物：
#   <out>/coomi            引擎二进制（i686 Linux ELF，--no-default-features）
#   <out>/linux-rootfs/   最小 Alpine rootfs（仅保留 Coomi 需要的部分）
#
# 为什么在 iSH 里编译而不是交叉编译：
#   · iSH 是 i686 用户态模拟，本机 gcc 直接产出可用二进制；
#   · ring（TLS）的 32 位汇编在 iSH 里能直接编，交叉编译则要匹配的 musl-gcc 与 as；
#   · 附带好处：编出来的二进制与 iSH 的 musl 版本严格一致。

set -eu

OUT="${1:-$PWD/ios-runtime}"
ROOTFS="$OUT/linux-rootfs"

say() { printf '%s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────
say "==> 0/6 环境自检"

ARCH="$(uname -m)"
say "    架构: $ARCH"
case "$ARCH" in
  i686|i386|x86) : ;;
  *) die "必须在 i686 环境编译（iSH 里 uname -m 应为 i686）。当前是 $ARCH。" ;;
esac

command -v cargo >/dev/null 2>&1 || die "缺少 cargo。请先：apk add rust cargo"
command -v cc    >/dev/null 2>&1 || die "缺少 C 编译器。请先：apk add gcc musl-dev"

# ─────────────────────────────────────────────────────────────
say "==> 1/6 编译引擎（--no-default-features：不构建 iroh/ring 的 QUIC 栈）"

# 找到 coomi-rs 工作区：脚本可能在 apps/ios/CoomiApp/Scripts/ 下，
# 也可能被单独拷出来执行，所以按「向上找 Cargo.toml」的方式定位。
find_workspace() {
  d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -f "$d/apps/coomi-rs/Cargo.toml" ]; then printf '%s\n' "$d/apps/coomi-rs"; return 0; fi
    if [ -f "$d/Cargo.toml" ] && [ -d "$d/ui" ]; then printf '%s\n' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  return 1
}

WS="$(find_workspace)" || die "找不到 coomi-rs 工作区（含 ui/Cargo.toml 的目录）"
say "    工作区: $WS"

cd "$WS"
# --no-default-features 关掉 iroh：iSH 上 QUIC/TLS 又慢又不稳，且会显著拖慢构建。
cargo build --release --no-default-features -p coomi-ui --bin coomi

BIN="$WS/target/release/coomi"
[ -f "$BIN" ] || die "编译产物不存在：$BIN"
say "    已编译: $BIN ($(wc -c < "$BIN") 字节)"

mkdir -p "$OUT"
cp "$BIN" "$OUT/coomi"
chmod 755 "$OUT/coomi"

# 自检：必须是 i686 Linux ELF
if command -v file >/dev/null 2>&1; then
  say "    自检: $(file -b "$OUT/coomi")"
fi
"$OUT/coomi" --version >/dev/null 2>&1 || die "二进制无法执行（架构或依赖不匹配）"
say "    自检通过: $("$OUT/coomi" --version)"

# ─────────────────────────────────────────────────────────────
say "==> 2/6 准备最小 rootfs 骨架"

rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"/bin "$ROOTFS"/etc "$ROOTFS"/lib "$ROOTFS"/proc "$ROOTFS"/root \
         "$ROOTFS"/tmp "$ROOTFS"/usr/bin "$ROOTFS"/usr/local/bin "$ROOTFS"/dev/pts \
         "$ROOTFS"/var/tmp
chmod 1777 "$ROOTFS/tmp" "$ROOTFS/var/tmp"

# ─────────────────────────────────────────────────────────────
say "==> 3/6 填入必要的用户态程序"

# 引擎实际会 exec 的命令（从源码里扫出来的）：
#   /bin/sh    —— 进程管理器硬编码（services/src/processes.rs: "/bin/sh", ["-lc", cmd]）
#   /bin/bash  —— shell 工具的默认值（tools/src/lib.rs，可用 COOMI_SHELL 覆盖）
#   git        —— 版本库类工具
#   kill       —— 取消任务
#   ssh        —— 远程执行工具（可选）
# tesseract/scenedetect 属媒体/OCR 能力，iOS 版按需再加，不进最小集。

copy_bin() {
  name="$1"; dest="$2"
  src="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$src" ]; then
    say "    - 跳过 $name（未安装）"
    return 0
  fi
  mkdir -p "$(dirname "$ROOTFS$dest")"
  cp -L "$src" "$ROOTFS$dest" 2>/dev/null || { say "    - 跳过 $name（拷贝失败）"; return 0; }
  chmod 755 "$ROOTFS$dest"
  say "    + $dest"
}

copy_bin sh   /bin/sh
# busybox 的 sh 通常是个符号链接；把 busybox 本体也带上，否则 rootfs 里 sh 会断。
if [ -L "$(command -v sh)" ] || [ -L /bin/sh ]; then
  copy_bin busybox /bin/busybox
  ln -sf /bin/busybox "$ROOTFS/bin/sh"
fi
copy_bin bash /bin/bash
copy_bin git  /usr/bin/git
copy_bin kill /bin/kill
copy_bin ssh  /usr/bin/ssh

# ─────────────────────────────────────────────────────────────
say "==> 4/6 复制动态库（musl 静态链的话会自动跳过）"

copy_libs_of() {
  target="$1"
  # musl 上是 /lib/ld-musl-*.so.1；优先用 ldd 列出真实依赖。
  if command -v ldd >/dev/null 2>&1; then
    ldd "$target" 2>/dev/null | awk '/=> \// {print $3}' | while read -r lib; do
      [ -f "$lib" ] || continue
      dest="$ROOTFS$lib"
      mkdir -p "$(dirname "$dest")"
      [ -f "$dest" ] || cp -L "$lib" "$dest" 2>/dev/null || true
    done
  fi
}

for f in "$OUT/coomi" "$ROOTFS/bin/sh" "$ROOTFS/bin/bash" "$ROOTFS/usr/bin/git"; do
  [ -f "$f" ] && copy_libs_of "$f"
done

# musl 的 loader 必须存在，否则任何动态二进制都起不来。
for loader in /lib/ld-musl-i386.so.1 /lib/ld-musl-i686.so.1 /lib/ld-linux.so.2; do
  if [ -f "$loader" ]; then
    mkdir -p "$ROOTFS$(dirname "$loader")"
    cp -L "$loader" "$ROOTFS$loader" 2>/dev/null || true
    say "    + $loader"
  fi
done

# ─────────────────────────────────────────────────────────────
say "==> 5/6 写入 /etc 与设备节点占位"

cat > "$ROOTFS/etc/passwd" <<'EOF'
root:x:0:0:root:/root:/bin/sh
EOF
cat > "$ROOTFS/etc/group" <<'EOF'
root:x:0:
EOF
cat > "$ROOTFS/etc/hostname" <<'EOF'
coomi
EOF
cat > "$ROOTFS/etc/resolv.conf" <<'EOF'
# iSH 共享宿主 DNS；这个文件仅作占位，实际解析由 iSH 的 network 层处理。
nameserver 1.1.1.1
EOF

# /dev 与 /dev/pts 由 iSH 内核在 boot 时挂载，这里只保证挂载点存在。
: > "$ROOTFS/dev/.keep"

# ─────────────────────────────────────────────────────────────
say "==> 6/6 打包并汇报"

( cd "$ROOTFS" && tar -czf "$OUT/linux-rootfs.tar.gz" . )
say "    已打包: $OUT/linux-rootfs.tar.gz ($(wc -c < "$OUT/linux-rootfs.tar.gz") 字节)"

say ""
say "产物："
say "  $OUT/coomi                  → 放进 App 的 CoomiApp/Resources/"
say "  $OUT/linux-rootfs.tar.gz    → 同上，首次启动由 App 解包到 Documents/linux/"
say ""
say "体积："
du -sh "$ROOTFS" 2>/dev/null || true
say ""
say "下一步（在 Mac 上）："
say "  1. 把上面两个产物拷进 apps/ios/CoomiApp/Resources/"
say "  2. xcodegen generate && xcodebuild ..."
say "  3. 若未集成 iSH 静态库，App 会提示「未链接 iSH 运行时」而不是崩溃。"
