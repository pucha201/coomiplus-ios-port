# CoomiPlus iOS 移植（iSH 内核内嵌，单 App 单进程）

> 本目录是 `D:\coomi-ios`（1.6.8 的独立副本）里的 iOS 移植工作区。
> Android 主线在 `D:\coomi168`；两者共享 Rust/前端修复，iOS 专属改动只在这里。

---

## 一、架构：引擎跑在 App 自己的进程里

**不是**「装一个 iSH App，再让 Coomi 去连它」。

```
┌─────────────────────────── Coomi App（一个进程）───────────────────────────┐
│  SwiftUI  ──▶  EngineWebView(WKWebView) ──▶ http://127.0.0.1:port         │
│                     ▲                                                      │
│                     │ 健康检查 / API                                        │
│  EngineController ──┘                                                      │
│         │                                                                  │
│         ▼                                                                  │
│  ISHBridge（Swift 封装）                                                   │
│         │                                                                  │
│         ▼                                                                  │
│  ish_support.c（C 桥接：xX_main_Xx / do_mount / do_fork / do_execve）      │
│         │                                                                  │
│         ▼                                                                  │
│  iSH Linux 内核（静态库，进程内）                                          │
│         │                                                                  │
│         ▼                                                                  │
│  普通 Linux 进程：/usr/local/bin/coomi serve                                │
│  （i686 二进制，由 iSH 模拟执行；Rust 不参与 iOS 目标编译）                  │
└────────────────────────────────────────────────────────────────────────────┘
```

### 为什么必须这样做（而不是拉起外部 iSH App）

早期版本用 `ish://run?cmd=...` 让外部 iSH App 跑引擎，再轮询 `127.0.0.1:port`。
**这条路是死的**，原因不是配置，是平台约束：

1. **iOS 会挂起后台 App**。Coomi 在前台时，iSH 必然在后台 → 若干秒后被 suspend
   → 引擎停摆、socket 断开。无法通过任何配置绕过。
2. 两个 App 之间**没有管道/信号**。只能盲发命令 + 轮询 HTTP：
   感知不到引擎退出，也没法优雅停止。
3. 用户还得手动装 iSH、手动拷二进制 —— 体验不可接受。

**单进程内嵌**同时解决这三点：引擎是 App 自己的子进程，App 活着它就在。

---

## 二、iSH 为什么能嵌进 App（且合法）

### 它本身就是一个可嵌入的库

iSH 仓库里就有 `app/AppLib.xcconfig`、`app/StaticLib.xcconfig`、`app/StaticLibLinux.xcconfig`
—— 官方支持编成静态库。它的入口是普通 C 函数：

```c
int err = xX_main_Xx(argc, argv, envp);      // 初始化全局结构
create_some_device_nodes();
do_mount(&procfs,   "proc",   "/proc",   "", 0);
do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
task_run_current();                           // 跑当前 task
```

模拟出来的 Linux 进程就是进程内的 task（`do_fork()` / `do_execve()` / `task_start()`），
**fork/exec/POSIX 信号在 App 内可用** —— 这正是 Coomi 工具层需要的。

### 授权：iSH 官方已明确豁免 App Store 冲突

`LICENSE.IOS` 原文：

> The copyright holders of the iSH app do not wish this conflict to prevent the
> otherwise-compliant distribution of derived apps via the App Store.
> Therefore, we have committed **not to pursue any license violation** that results
> solely from the conflict between the GNU GPLv2 or v3 and the Apple App Store
> terms of service. … as long as you comply with the GPL in all other respects.

即：**只要其余方面遵守 GPL**（提供源码等），把 iSH 嵌进 App 并可上架，iSH 作者不会追究。
本项目 `D:\coomi-ios` 是完整源码，符合该条件。

> GPL 仍要求：分发二进制时提供对应源码。上架时在 App 内提供「开源许可」页指向本仓库即可。

---

## 三、当前完成度

| 部件 | 文件 | 状态 |
|---|---|---|
| 引擎生命周期（端口/token/健康检查/状态机） | `Sources/EngineController.swift` | ✅ 重写为**进程内**模型 |
| iSH 封装（boot / 安装 / spawn / kill） | `Sources/ISHBridge.swift` | ✅ 接口与调用骨架完成 |
| C 桥接（真实 iSH API） | `Sources/ish_support.c` | ✅ 已按 iSH 源码写实现 + `COOMI_HAS_ISH=0` 桩 |
| WebView（只放行 loopback） | `Sources/EngineWebView.swift` | ✅ |
| UI 状态机 + 回前台重连 | `Sources/RootView.swift` | ✅ |
| 工程描述 | `project.yml`、`Package.swift` | ✅ |
| 安装脚本（iSH 内手动验证用） | `Scripts/install-in-ish.sh` | ✅ 保留（用于手工验证引擎能跑） |

### ⚠️ 两个必须说清的缺口

**1. Swift 与 C 代码未经编译验证。**
本机没有 Swift/Xcode 工具链（`swift`/`swiftc`/`xcodebuild` 全缺），也没有 iOS SDK。
我做的是逐项静态审查（已修：缺 `import UIKit`/`Security`、`Duration` 可用性、
未使用变量、C 侧 `const` 不匹配等），**但仍可能有编译错误**。

请在 Mac 上验证：
```bash
cd apps/ios
xcodegen generate
xcodebuild -scheme CoomiIOS -destination 'generic/platform=iOS' build
```

**2. iSH 静态库尚未编入工程。**
`ish_support.c` 里引用的是 iSH 真实符号（`xX_main_Xx`、`do_mount`、`do_fork`、
`do_execve`、`ish_switch_root` 等）。**在没有链接 libish.a 时，`COOMI_HAS_ISH=0`
会走桩实现**，工程照样能编、UI 能跑，点启动会明确提示「未链接 iSH 运行时」。

集成步骤见下一节。

---

## 四、集成 iSH 静态库（在 Mac 上做）

```bash
cd apps/ios
mkdir -p ThirdParty && cd ThirdParty
git clone --depth 1 --recursive https://github.com/ish-app/ish.git
cd ish
```

iSH 用 meson 构建，编静态库大致是：

```bash
meson setup build -Dstatic=true        # 具体开关以 iSH 的 meson_options.txt 为准
ninja -C build
# 产物：build/libish.a 及其依赖（libapps.a 等）
```

然后把产物交给工程：

1. 把 `libish.a`（及 meson 报出的其它 `.a`）放到 `ThirdParty/ish/build/`；
2. 在 `project.yml` 里取消注释这两行：
   ```yaml
   OTHER_LDFLAGS: ["$(inherited)", "-lish"]
   LIBRARY_SEARCH_PATHS: ["$(inherited)", "$(SRCROOT)/ThirdParty/ish/build"]
   ```
3. 把 `GCC_PREPROCESSOR_DEFINITIONS` 里的 `COOMI_HAS_ISH=0` 改成 `1`；
4. `xcodegen generate` 重新生成工程。

> iSH 的头文件搜索路径已经预置为 `$(SRCROOT)/ThirdParty/ish`，
> 对应 `ish_support.c` 里的 `#include "kernel/calls.h"` 等。

### 需要的 Linux 用户态

iSH 内核只提供「Linux 系统调用」，**不提供 rootfs 内容**。引擎是 i686 musl 二进制，
还需要一个最小 Alpine rootfs（`/bin/sh`、`/lib/ld-musl-i386.so.1` 等）。

做法二选一：
- **离线打包**：把 Alpine minirootfs（i686）解包进 `CoomiApp/Resources/linux-rootfs/`，
  首次启动由 `ISHBridge.installRuntimeIfNeeded()` 铺到 `Documents/linux/`；
- **首次联网下载**：启动时拉取并解包（需处理断点与校验）。

当前代码预留了 `Documents/linux` 作为 Linux 根，但**尚未内置 rootfs**。

---

## 五、构建引擎二进制（i686 Linux）

引擎**不需要** `aarch64-apple-ios` 工具链；它是普通 Linux 二进制。

在 iSH 里本机编译（最简单、最可靠）：
```sh
apk add rust cargo gcc musl-dev
cd apps/coomi-rs
cargo build --release --no-default-features -p coomi-ui --bin coomi
```
产物 `target/release/coomi` 就是 i686 ELF，拷进 `CoomiApp/Resources/coomi` 即可。

或交叉编译（需要 musl 交叉工具链，`ring` 会用到 `musl-gcc`）：
```bash
rustup target add i686-unknown-linux-musl
cargo build --release --no-default-features --target i686-unknown-linux-musl -p coomi-ui --bin coomi
```

> `--no-default-features` 关掉 iroh（避免 ring/TLS 在 32 位模拟下的开销与构建麻烦）。
> 已验证：`cargo check -p coomi-ui --no-default-features` → Finished；
> `cargo test -p coomi-ui --lib --no-default-features` → 187 passed。

---

## 六、平台适配（已完成）

### iroh 编译期开关

`ui/Cargo.toml` 里 `iroh` 改 optional、`default = ["iroh-tunnel"]`；
`iroh_tunnel.rs` 拆成转发层 + `iroh_tunnel_impl.rs`（真实现）+ 无 feature 时的同签名 stub。
两种配置都能编译并跑测试（190 / 187）。

### iSH 运行时提示词

`system_prompt_with_cognitive` 原本用 `cfg!(target_os = "android")` 二选一，
iSH 会落到「桌面」分支 —— 那段的措辞是「PowerShell or cmd on Windows」，
模型会尝试 `powershell`/`apt`/`systemctl`，全失败后反复重试（用户看到"卡住"）。

修法**不用** `cfg!(target_os="ios")`（iSH 里 `target_os` 是 `"linux"`，
硬编码会误伤真正的 Linux 桌面），改成**运行时探测**：

```rust
fn running_in_ish() -> bool   // /proc/version 含 "ish"，或环境变量 ISH
fn ish_environment_note()     // 命中则注入 iSH 专属说明
```

注入内容：BusyBox `sh`（无 PowerShell/bash）、`apk`（非 apt）、无 systemd、
32 位模拟下重活慢一个数量级、路径就是普通 Linux 路径（无 `/workspace` 映射）、
外网可能不可用（报一次别死循环）。

---

## 七、已知限制

| 限制 | 说明 | 缓解 |
|---|---|---|
| 性能 | x86 模拟，约为原生 10–20% | 关 iroh；避免大文件 hash 与全量构建 |
| 内存 | iOS 单个 App 有内存上限（随设备约 1–2 GB） | 引擎 + 模拟层占用需实测；必要时降 `max_tool_rounds` |
| GPL 义务 | 分发即需提供源码 | App 内置「开源许可」页指向本仓库 |
| 无法上架的限制 | 若选用非 App Store 分发（自签/TestFlight）另说 | iSH 作者已豁免 App Store 冲突 |
| Swift/C 未编译验证 | 本机无工具链 | 见第三节「两个缺口」 |
| rootfs 未内置 | 当前只预留了 `Documents/linux` 目录 | 见第四节末尾 |

---

## 八、下一步（按确定性排序）

1. **在 Mac 上 `xcodegen generate && xcodebuild`** —— 修掉 Swift/C 编译错误（最确定）。
2. **编出 libish.a 并打开 `COOMI_HAS_ISH=1`** —— 让 `ish_support.c` 走真实实现。
3. **内置 i686 Alpine rootfs** —— 让 Linux 侧真的有 `/bin/sh`。
4. **在 iSH 里编出 `coomi` 并放进 Resources** —— 打通最后一环。
5. **实机验证**：启动耗时、内存峰值、长会话稳定性。
