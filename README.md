# CoomiPlus iOS

CoomiPlus 的 **iOS 子集**：Rust 引擎以 `aarch64-apple-ios` 静态库链进 App，
在**同一进程内**跑；iSH 只作为「工作环境」提供 shell / git / python，不跑引擎。

> 本仓库**只含 iOS 相关代码**，不含 Android App（`apps/coomi-app`）、
> JNI 桥、签名材料与 proot rootfs。

## 两层结构

| | 作用 | 实现 |
|---|---|---|
| **引擎** | 对话、记忆、文件、会话、工具编排 | `apps/coomi-rs` → `libcoomi_ui.a`，Swift 经 C ABI 调用 |
| **工作环境** | 仅当 AI 要执行 shell 命令时才用 | iSH（进程内 boot，aarch64 Alpine rootfs） |

两者都是**进程内**的：不 fork App 之外的进程跑引擎，也不调用外部 iSH App。

## 引擎的 C ABI

`apps/coomi-rs/ui/src/ios_ffi.rs` 导出三个符号，Swift 侧在
`apps/ios/CoomiApp/Sources/EngineController.swift` 里调用：

```c
int32_t     coomi_start(const char *home, const char *workspace, uint16_t port_hint);
uint16_t    coomi_port(void);              // 引擎起来的真实端口
const char *coomi_version(void);
```

`coomi_start` 内部起 tokio + axum（WebSocket），返回端口后 Swift 用
`EngineWebView` 加载前端页面。启动只做一次，后续复用同一端口。

## 目录

```
apps/
  coomi-rs/                 Rust workspace（engine / services / tools / security / ui / catalogs / telemetry）
    ui/src/ios_ffi.rs       iOS C ABI：coomi_start / coomi_port / coomi_version
  ios/
    CoomiApp/Sources/       Swift：EngineController、EngineWebView、ISHBridge、Readiness、RootView
    CoomiApp/Sources/ish_support.c   iSH 的薄包装（COOMI_HAS_ISH=0 时提供可链接存根）
    project.yml             XcodeGen 工程描述
  web/                      前端（Vue + TS，Vite 构建）
.github/workflows/          build-ios.yml（主构建）、ios-native-engine.yml（引擎单独验证）
```

## 构建

需要 macOS + Xcode 16.x。

```bash
# ① 引擎静态库
rustup target add aarch64-apple-ios
cargo build --release -p coomi-ui --target aarch64-apple-ios \
  --manifest-path apps/coomi-rs/Cargo.toml
# 产物：apps/coomi-rs/target/aarch64-apple-ios/release/libcoomi_ui.a

# ② 前端
cd apps/web && npm ci && npm run build

# ③ 工程与打包
cd apps/ios && xcodegen generate
xcodebuild -project CoomiIOS.xcodeproj -scheme CoomiIOS \
  -sdk iphoneos -configuration Release archive
```

CI 里这套流程跑在 `macos-15` 上，产物是未签名的 `CoomiIOS-unsigned.ipa`
（约 10.8 MB）：**未签名、不含 rootfs**，体积小是正常的 —— 解压后主二进制
约 27.8 MB，说明引擎确实静态链进去了。

装真机需自己用 Sideloadly / AltStore / Xcode 自签名（免费证书 7 天有效）。

## 符号自检为什么用 `strings` 而不是 `nm`

rustc 1.99 带 LLVM 23 的 DWARF，而 Xcode 16.4 的 cctools `nm` 只认到 LLVM 17，
直接跑会报 `Unknown attribute kind (102)`。所以 CI 用两种独立判据：

1. `rustup component add llvm-tools-preview` 拿到的 `llvm-nm`（与 rustc 同代）；
2. `strings libcoomi_ui.a | grep coomi_start` 之类的纯字节检查。

两者都过才算通过。

## iSH 现状

`apps/ios/ThirdParty/ish/` 目前**没有** vendored 静态库，所以 CI 的 `ish` job 是
`skipped`，`project.yml` 里 `COOMI_HAS_ISH=0` 启用 `ish_support.c` 的存根分支。
效果：App 能启动、引擎能跑、对话与记忆正常，但 AI **暂不能执行 shell 命令**。

要让 shell 工具可用，需要：

1. 把 iSH 编成 `aarch64-apple-ios` 静态库，放进 `apps/ios/ThirdParty/ish/`；
2. `project.yml` 改 `COOMI_HAS_ISH=1` 并加 `-lish` 链接参数；
3. 打一个 Alpine **aarch64** rootfs 进 `CoomiApp/Resources/linux-rootfs.tar.gz`。

## rootfs 为什么在 guest 里解包

iOS 不允许 `fork`/`exec`，宿主侧的 `tar` 解不了一份 Linux rootfs（权限位、
设备节点、符号链接都会出问题）。所以流程是：把 `linux-rootfs.tar.gz` 作为
资源打进 App → 首次启动时由 iSH 内的 `/bin/tar` 分两阶段解开 → 完成后写
`Documents/linux/.userland-ok` 作为哨兵，避免重复解包。

iSH 的 fakefs 就是一个**普通宿主目录**（`Documents/linux` 下的 `data/` 与
`meta.db`），guest 的 `/` 与它 1:1 映射，所以不需要真的做镜像。

## 许可

- 本项目源码：MIT
- iSH：GPLv3（作为独立进程内的库链接，注意 GPL 传染性 —— 发布前需自行评估）
- Alpine rootfs：各包各自许可

## 相关文档

- [apps/ios/docs/README.md](apps/ios/docs/README.md)：iOS 端详细设计与目录说明
