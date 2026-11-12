#!/usr/bin/env bash
# Alpine aarch64 rootfs for iSH（iOS 工作环境）
#
# 和 Android 的 build-rootfs.sh 不是一回事：
#   - Android 用 Debian bookworm + proot，rootfs 150~264 MB
#   - iOS 用 Alpine + iSH（内建 aarch64 Linux 内核），rootfs 约 15~25 MB
#
# 为什么可以小这么多：iSH 不是模拟器，它把 Linux syscall 直接映射到 Darwin，
# 所以不需要把 glibc、systemd、apt 的那套依赖全带上；Alpine 的 musl + busybox
# 又比 Debian 精简得多。AI 的 shell 工具只需要 sh/git/python/curl 这几样。
#
# 用法：
#   ./scripts/runtime-v2/build-rootfs-alpine-ish.sh              # 默认输出到 apps/ios/CoomiApp/Resources
#   RUNTIME_V2_OUTPUT=/tmp/out ./scripts/runtime-v2/build-rootfs-alpine-ish.sh
#
# 构建宿主：macOS 或 Linux 都行，**不需要 root**，也不需要 qemu。
# 思路是把官方 alpine-minirootfs 解包后直接改配置 —— 因为目标架构和宿主无关
# （我们只是把文件打包，不在本地 chroot 进去跑）。

set -euo pipefail

ALPINE_VER="${ALPINE_VER:-3.21}"
ALPINE_REL="${ALPINE_REL:-3.21.3}"
ARCH="aarch64"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT="${RUNTIME_V2_OUTPUT:-$ROOT/apps/ios/CoomiApp/Resources}"
WORK="${RUNTIME_V2_WORK:-$ROOT/.runtime-v2-work}/alpine-ish"

TARBALL="alpine-minirootfs-${ALPINE_REL}-${ARCH}.tar.gz"
# 官方源 + 国内镜像兜底（CI 在境外，本地在国内，两个都试）
URLS=(
  "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/releases/${ARCH}/${TARBALL}"
  "https://mirrors.aliyun.com/alpine/v${ALPINE_VER}/releases/${ARCH}/${TARBALL}"
  "https://mirrors.tuna.tsinghua.edu.cn/alpine/v${ALPINE_VER}/releases/${ARCH}/${TARBALL}"
)

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }

mkdir -p "$WORK" "$OUTPUT"

# ── 1. 下载 minirootfs ────────────────────────────────────────────────
cd "$WORK"
if [[ -f "$TARBALL" ]] && tar -tzf "$TARBALL" >/dev/null 2>&1; then
  say "复用已下载的 $TARBALL"
else
  ok=0
  for url in "${URLS[@]}"; do
    say "下载 $url"
    if curl -fL --retry 3 --connect-timeout 20 -o "$TARBALL.part" "$url"; then
      mv "$TARBALL.part" "$TARBALL"
      ok=1
      break
    fi
    warn "失败，换下一个源"
  done
  [[ "$ok" = 1 ]] || { echo "所有源都失败" >&2; exit 1; }
fi

# 校验：必须是 gzip、且含 bin/busybox。
#
# 注意条目可能带 "./" 前缀（GNU tar 打包的归档常见），所以用 grep -E
# 匹配可选的 "./"，而不是 -qx 精确匹配整行 —— 之前就是因为这个假设
# 让 CI 在下载成功（3.76 MB 已落盘）后误判成「不是有效的 rootfs」。
tar -tzf "$TARBALL" | grep -Eq '^(\./)?bin/busybox$' \
  || { echo "不是有效的 alpine rootfs（缺 bin/busybox）" >&2; exit 1; }

# ── 2. 解包到工作目录 ────────────────────────────────────────────────
ROOTFS="$WORK/rootfs"
rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"
say "解包"
tar -xzf "$TARBALL" -C "$ROOTFS"

# ── 3. 配置 APK 源（国内镜像，iSH 里装包才快）────────────────────────
say "写入 apk 源"
mkdir -p "$ROOTFS/etc/apk"
cat > "$ROOTFS/etc/apk/repositories" <<EOF
https://mirrors.aliyun.com/alpine/v${ALPINE_VER}/main
https://mirrors.aliyun.com/alpine/v${ALPINE_VER}/community
EOF

# ── 4. 预置目录与 DNS ────────────────────────────────────────────────
mkdir -p "$ROOTFS/workspace" "$ROOTFS/home/coomi" "$ROOTFS/tmp" "$ROOTFS/root"
chmod 1777 "$ROOTFS/tmp"

cat > "$ROOTFS/etc/resolv.conf" <<'EOF'
# Coomi guest DNS
nameserver 223.5.5.5
nameserver 119.29.29.29
nameserver 8.8.8.8
EOF

# ── 5. 时区与 locale（Alpine 默认 UTC、无 locale）────────────────────
ln -sf /usr/share/zoneinfo/Asia/Shanghai "$ROOTFS/etc/localtime" 2>/dev/null || true
mkdir -p "$ROOTFS/etc/profile.d"
cat > "$ROOTFS/etc/profile.d/coomi.sh" <<'EOF'
# Coomi iSH 工作环境
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PS1='\[\e[1;36m\]coomi\[\e[0m\]:\w\$ '
cd /workspace 2>/dev/null || true
EOF
chmod 0644 "$ROOTFS/etc/profile.d/coomi.sh"

# ── 6. 首启标记（iSH 里 git 需要这个，否则报 dubious ownership）──────
cat > "$ROOTFS/etc/profile.d/git-safe.sh" <<'EOF'
# iSH 的 fakefs 里 uid/gid 映射可能和 git 记录不一致，
# 不设这个的话 git 会报 "detected dubious ownership" 并拒绝工作。
git config --global --add safe.directory '*' 2>/dev/null || true
EOF
chmod 0644 "$ROOTFS/etc/profile.d/git-safe.sh"

# ── 7. 打包 ─────────────────────────────────────────────────────────
OUT="$OUTPUT/linux-rootfs.tar.gz"
say "打包 → $OUT"

# uid/gid 归一化到 root:root。
#
# 目的：iSH 是 fakefs（普通宿主目录），解包后权限位与所有者会原样落盘。
# 如果构建机的 uid（比如 macOS 的 501）被压进去，guest 里会变成
# "uid 501 拥有 /bin/sh"，部分文件在 iSH 里不可读。
#
# 但 GNU tar 和 BSD tar 的参数**不兼容**：
#   GNU: --owner=0 --group=0 --numeric-owner
#   BSD: --uid 0 --gid 0        （没有 --owner/--numeric-owner）
# macOS 自带的是 bsdtar，直接写 GNU 选项会报
# "tar: unknown option -- owner" 并让整个脚本失败。
if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
  TAR_OWN=(--owner=0 --group=0 --numeric-owner)
  say "tar: GNU，用 --owner/--group"
else
  TAR_OWN=(--uid 0 --gid 0)
  say "tar: BSD/bsdtar，用 --uid/--gid"
fi

# COPYFILE_DISABLE=1：防止 macOS 往归档里塞 ._AppleDouble（__MACOSX）垃圾文件。
COPYFILE_DISABLE=1 tar -czf "$OUT" "${TAR_OWN[@]}" -C "$ROOTFS" .

# 校验产物真的存在且是 gzip —— 免得静默产出一个 0 字节文件。
[[ -s "$OUT" ]] || { echo "打包失败：$OUT 不存在或为空" >&2; exit 1; }
tar -tzf "$OUT" >/dev/null 2>&1 || { echo "打包失败：$OUT 不是有效 gzip" >&2; exit 1; }

SIZE=$(wc -c < "$OUT" | tr -d ' ')
if command -v shasum >/dev/null 2>&1; then
  SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
else
  SHA=$(sha256sum "$OUT" | awk '{print $1}')
fi
say "完成：$OUT"
echo "  大小 : $(( SIZE / 1024 / 1024 )) MB ($SIZE B)"
echo "  SHA256: $SHA"
echo
echo "下一步：重新跑 CI，或本地 xcodebuild —— 资源会被打进 .app。"
echo "首启时 ISHBridge 会用 guest 内的 /bin/tar 分两阶段解包，"
echo "完成后写 Documents/linux/.userland-ok 作为哨兵。"
