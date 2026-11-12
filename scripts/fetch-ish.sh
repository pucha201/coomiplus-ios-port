#!/usr/bin/env bash
# 取 iSH 内核（嵌入式 ABI 版）到 apps/ios/ThirdParty/ish/
#
# 为什么用 Lolendor/ish-arm64-pkg 而不用 iSH 官方上游：
#   官方仓库只导出内核内部符号（task_start / do_execve / become_first_process），
#   那是给「完整 App」用的入口，会自己装 UI、自己管生命周期，还需要一堆私有头。
#   这个包提供了稳定的嵌入式 ABI v1（ishembed.h）：
#     ish_embed_boot / ish_embed_run_oneshot / ish_embed_shutdown / ish_embed_free
#   ish_support.c 就是照着这套 ABI 写的。
#
# 产物：
#   ThirdParty/ish/libIshKernel.xcframework/
#     ├── ios-arm64/libIshKernel.a          ← 83 个 arm64 目标文件
#     └── ios-arm64-simulator/...
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEST="$ROOT/apps/ios/ThirdParty/ish"
VERSION="0.3.3"
# SwiftPM 的 Package.swift 里声明的 checksum，用来确认下载没被污染。
EXPECTED="f747c2e85c3b6082e102fb45aa62797f52146a3bc5eb1a0c386b74bc156d4fca"
NAME="libIshKernel.xcframework"
ZIP="$DEST/ish-kernel.zip"

say() { printf '\033[1;36m[ish]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ish]\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$DEST"

# 已经有且结构完整就跳过（CI 里缓存命中时省 2MB 下载）
if [ -f "$DEST/$NAME/ios-arm64/libIshKernel.a" ] && [ -f "$DEST/$NAME/ios-arm64/Headers/ishembed.h" ]; then
  say "已存在，跳过下载"
  ls -la "$DEST/$NAME/ios-arm64/"
  exit 0
fi

URLS=(
  "https://github.com/Lolendor/ish-arm64-pkg/releases/download/v$VERSION/$NAME.zip"
  # GitHub Release 直连在大陆/部分 CI 网络下会 reset，走镜像兜底。
  "https://gh-proxy.com/https://github.com/Lolendor/ish-arm64-pkg/releases/download/v$VERSION/$NAME.zip"
  "https://ghfast.top/https://github.com/Lolendor/ish-arm64-pkg/releases/download/v$VERSION/$NAME.zip"
)

say "下载 iSH 内核 v$VERSION"
ok=0
for u in "${URLS[@]}"; do
  host=$(printf '%s' "$u" | sed -E 's#https?://([^/]+)/.*#\1#')
  say "  尝试 $host"
  if curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 \
          --max-time 600 -o "$ZIP" "$u" 2>/dev/null; then
    if [ -s "$ZIP" ]; then ok=1; break; fi
  fi
done
[ "$ok" = 1 ] || die "三个源都失败：$NAME 没能下载"

# 校验 checksum —— 与 SwiftPM 用的是同一个值，等于复用了上游的完整性保证。
say "校验 checksum"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$ZIP" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$ZIP" | awk '{print $1}')
else
  die "没有 sha256sum / shasum，无法校验"
fi
[ "$actual" = "$EXPECTED" ] || die "checksum 不匹配
  实际 $actual
  期望 $EXPECTED
  下载可能被污染或被中间人改过，拒绝使用。"

say "解包"
rm -rf "$DEST/$NAME"
unzip -q -o "$ZIP" -d "$DEST"
rm -f "$ZIP"

# 断言产物齐全 —— 缺任何一个都会让后面链接/编译失败，这里提前报。
[ -f "$DEST/$NAME/ios-arm64/libIshKernel.a" ] \
  || die "解包后没有 ios-arm64/libIshKernel.a"
[ -f "$DEST/$NAME/ios-arm64/Headers/ishembed.h" ] \
  || die "解包后没有 ishembed.h"

# 库必须是 arm64（不能混进 x86 模拟器 slice，真机链接会失败）
if command -v lipo >/dev/null 2>&1; then
  archs=$(lipo -info "$DEST/$NAME/ios-arm64/libIshKernel.a" 2>&1 || true)
  say "  $archs"
  case "$archs" in
    *arm64*) ;;
    *) die "libIshKernel.a 不含 arm64：$archs" ;;
  esac
fi

say "完成"
ls -la "$DEST/$NAME/ios-arm64/"
