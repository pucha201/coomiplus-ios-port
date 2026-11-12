#!/usr/bin/env bash
# 取 iSH 运行时到 apps/ios/ThirdParty/ish/
#
# 为什么用 Lolendor/ish-arm64-pkg 而不用 iSH 官方上游：
#   官方仓库只导出内核内部符号（task_start / do_execve / become_first_process），
#   那是给「完整 App」用的入口，会自己装 UI、自己管生命周期，还需要一堆私有头。
#   这个包提供稳定的嵌入式 ABI v1（ishembed.h）：
#     ish_embed_boot / ish_embed_run_oneshot / ish_embed_shutdown / ish_embed_free
#
# 两样东西都要，缺一不可：
#   ① libIshKernel.xcframework —— 内核本体（83 个 arm64 目标文件）
#   ② fs.tar.gz               —— **fakefs 编码**的 rootfs
#
# 关于 ②，这里踩过一个坑，写下来免得再犯：
#   `ish_embed_boot(rootfs_path:)` 的头文件注释是
#       "host fs path to fakefs root (the dir that has data/ + meta.db)"
#   也就是说它要的不是「一个 Alpine tar 解出来的目录」，而是 iSH 自己的
#   fakefs 镜像：根下有 meta.db（SQLite，记录 inode/权限/时间戳）、
#   data/（真实文件内容），以及 /sbin/ishsv（PID1 supervisor）。
#   早先我用 alpine-minirootfs-*.tar.gz 当 rootfs，格式根本不对 ——
#   没有 meta.db，也没有 ishsv，boot 会直接挂在 ISH_ERR_MOUNT/-2
#   或者 ISH_ERR_EXECVE/-6 上。fs.tar.gz 是官方用 fakefsify 生成好的，
#   解出来就是 fs/{data,meta.db,meta.db-shm,meta.db-wal}。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEST="$ROOT/apps/ios/ThirdParty/ish"
VERSION="0.3.3"
BASE="https://github.com/Lolendor/ish-arm64-pkg/releases/download/v$VERSION"

# SwiftPM 的 Package.swift 里声明的 checksum，确认 xcframework 没被污染。
XCF_NAME="libIshKernel.xcframework"
XCF_SHA="f747c2e85c3b6082e102fb45aa62797f52146a3bc5eb1a0c386b74bc156d4fca"
# fs.tar.gz 上游没给 checksum，我们锁定一份已知可用的哈希。
# 换版本时必须同时更新（否则下面校验会失败，这是有意的）。
FS_NAME="fs.tar.gz"
FS_SHA="be0f3c133f78f28b023288459b33dc28fa253a6ef29f7123bc5f3892edf90ad4"

say() { printf '\033[1;36m[ish]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ish]\033[0m %s\n' "$*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "没有 sha256sum / shasum，无法校验"
  fi
}

# 三个源依次试；GitHub Release 直连在某些网络下会 reset。
# 注意不要把 curl 的 stderr 全丢掉：CI 上排查时「为什么失败」比
# 「失败了」重要得多。这里只在非 verbose 时收窄输出。
fetch() {
  local url="$1" out="$2" what="$3"
  for prefix in "" "https://gh-proxy.com/" "https://ghfast.top/"; do
    local full="${prefix}${url}"
    local host
    host=$(printf '%s' "$full" | sed -E 's#https?://([^/]+)/.*#\1#')
    say "  $what ← $host"
    rm -f "$out"
    # 先存退出码再 say —— say 本身会覆盖 $?，之前写 `say "... 退出码 $?"`
    # 永远打印 0，等于把失败信息也一起吞了。
    if curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 \
            --max-time 900 -sS -o "$out" "$full"; then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
      say "    成功 $(wc -c < "$out" | tr -d ' ') B"
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      say "    失败（curl 退出码 $rc）"
    else
      say "    下载为空"
    fi
  done
  return 1
}

mkdir -p "$DEST"

# ── ① xcframework ────────────────────────────────────────────────────
if [ -f "$DEST/$XCF_NAME/ios-arm64/libIshKernel.a" ] \
   && [ -f "$DEST/$XCF_NAME/ios-arm64/Headers/ishembed.h" ]; then
  say "xcframework 已存在，跳过"
else
  say "下载 iSH 内核 v$VERSION"
  fetch "$BASE/$XCF_NAME.zip" "$DEST/ish-kernel.zip" "xcframework" \
    || die "xcframework 三个源都失败"
  actual=$(sha256_of "$DEST/ish-kernel.zip")
  [ "$actual" = "$XCF_SHA" ] \
    || die "xcframework checksum 不匹配
  实际 $actual
  期望 $XCF_SHA"
  say "解包 xcframework"
  rm -rf "$DEST/$XCF_NAME"
  unzip -q -o "$DEST/ish-kernel.zip" -d "$DEST"
  rm -f "$DEST/ish-kernel.zip"
  [ -f "$DEST/$XCF_NAME/ios-arm64/libIshKernel.a" ] || die "解包后没有 libIshKernel.a"
  [ -f "$DEST/$XCF_NAME/ios-arm64/Headers/ishembed.h" ] || die "解包后没有 ishembed.h"
fi

# ── ② fakefs rootfs ──────────────────────────────────────────────────
# 打成 App 资源：Resources/linux-rootfs.tar.gz（沿用既有文件名，
# 但内容从「Alpine tar」换成「fakefs tar」，见文件头注释）。
RES="$ROOT/apps/ios/CoomiApp/Resources"
mkdir -p "$RES"
TARGET="$RES/linux-rootfs.tar.gz"

if [ -f "$TARGET" ] && [ -s "$TARGET" ]; then
  # 已有就核对是不是 fakefs（而不是旧的 Alpine tar）。
  # 同样不能写成 `tar -tzf | grep -q`：pipefail 下 grep 提前退出会让
  # tar 吃 SIGPIPE，管道整体非 0，于是把「其实是好的」误判成「不是 fakefs」，
  # 每次 CI 都白下一遍 6MB。
  existing_listing=$(tar -tzf "$TARGET" 2>/dev/null || true)
  case "$existing_listing" in
    *meta.db*) say "fakefs rootfs 已存在，跳过" ;;
    *)
      say "已存在的 linux-rootfs.tar.gz 不是 fakefs（缺 meta.db），重新下载"
      rm -f "$TARGET"
      ;;
  esac
fi

if [ ! -f "$TARGET" ]; then
  say "下载 fakefs rootfs"
  fetch "$BASE/$FS_NAME" "$DEST/$FS_NAME" "fs.tar.gz" \
    || die "fs.tar.gz 三个源都失败"
  actual=$(sha256_of "$DEST/$FS_NAME")
  [ "$actual" = "$FS_SHA" ] \
    || die "fs.tar.gz checksum 不匹配
  实际 $actual
  期望 $FS_SHA"

  # 断言这是 fakefs，不是普通 Alpine rootfs。
  # 这是「能不能真的 boot 起来」的分界线，不能省。
  #
  # 注意：不要写成 `tar -tzf x | grep -q 'meta\.db'`。
  # 脚本开了 pipefail，而 grep -q 命中后会立刻退出，
  # tar 因为写不出去收到 SIGPIPE → 整条管道退出码非 0 →
  # 在 set -e 下直接把脚本干掉。看似「找不到文件」，实则是自己杀自己。
  # 所以先把清单落到变量里，再在字符串上匹配。
  listing=$(tar -tzf "$DEST/$FS_NAME")
  printf '%s\n' "$listing" | grep -q 'meta\.db' \
    || die "fs.tar.gz 里没有 meta.db，不是 fakefs，boot 会失败"
  printf '%s\n' "$listing" | grep -q 'ishsv' \
    || die "fs.tar.gz 里没有 ishsv（PID1 supervisor），boot 会失败"

  cp "$DEST/$FS_NAME" "$TARGET"
  rm -f "$DEST/$FS_NAME"
  say "已放入 $(basename "$TARGET")"
fi

say "完成"
ls -la "$DEST/$XCF_NAME/ios-arm64/"
ls -la "$TARGET"
