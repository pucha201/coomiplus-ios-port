# CoomiPlus iOS 端

> 与安卓同构：**Rust 引擎原生编译进 App**，**iSH 只承担 proot 的角色**（提供能 fork/exec 的 Linux 环境给 shell 工具用）。
> 架构对比与取舍详见 [`docs/正确架构_引擎原生_iSH只做工作环境.md`](../../../docs/正确架构_引擎原生_iSH只做工作环境.md)。

---

## 一、两层结构

```
App (SwiftUI)
 ├─ Rust 引擎  libcoomi_ui.a  (aarch64-apple-ios, staticlib)
 │    进程内直接调用：coomi_start / coomi_port / coomi_version
 │    对话 / 记忆 / 会话 / 文件 全在原生 Rust 里跑，零模拟
 │
 └─ iSH 内核（可选，进程内）
      AI 需要执行 shell 命令时，引擎经 iSH 的 C 接口 fork/exec
      未链接时 App 照常工作，只是 shell 工具不可用
```

关键点：

- 引擎**不在** iSH 里跑。它是原生静态库，Swift 通过 C ABI 直接调。
- iSH **不是**必需依赖。`COOMI_HAS_ISH=0` 时 `ish_support.c` 编译桩实现，`ish_available()` 返回 0，其余功能不受影响。
- 因此不存在「先起 iSH 才能起引擎」的先后依赖 —— README 旧版那种 i686 ELF 方案已废弃。

### 与安卓的对应关系

| | Android | iOS |
|---|---|---|
| 引擎 | `libcoomi_engine.so`，JNI | `libcoomi_ui.a`，C ABI |
| 工作环境 | proot + Debian rootfs | iSH + Alpine rootfs |
| 引擎调 shell | 经 proot 起进程 | 经 iSH `coomi_ish_run` |

---

## 二、引擎的 C ABI

实现在 `apps/coomi-rs/ui/src/ios_ffi.rs`，`#[cfg(target_os = "ios")]` 条件编译。

```c
int32_t     coomi_start(const char *home, const char *token, uint16_t port_hint);
uint16_t    coomi_port(void);
const char *coomi_version(void);
```

- `coomi_start` — 启动 tokio + axum HTTP/WS 服务。`home` 是工作目录，`token` 是访问令牌，`port_hint` 为 0 时由系统分配。
- `coomi_port` — 返回实际监听端口。**幂等**，已启动时直接返回，不会重复绑定。
- `coomi_version` — 返回静态版本串。

Swift 侧对应 `EngineController.swift`：先试 `coomi_port()`，非 0 说明已在跑；否则 `coomi_start(...)` 再 `waitForHealth(port:token:timeout:60)`。
令牌用 `issuedToken` 记住签发值，避免重入时用错 token 导致 401 —— 这个 bug 真实出现过。

### 为什么用 C ABI 而不是 Swift framework

静态库 + 扁平 C 接口，XcodeGen 一行 `OTHER_LDFLAGS: -lcoomi_ui` 就够，不需要 module map、不需要 `Package.swift` 参与主工程构建。代价是不能用 Swift 类型，但边界只有三个函数，不构成负担。

---

## 三、iSH 工作环境

### 3.1 C 接口（`include/ishembed.h`，ABI v1）

Swift 只碰 `void *` 和 `char *`，不暴露 iSH 内部结构体。实现在 `Sources/ish_support.c`：

| 函数 | 作用 |
|---|---|
| `int ish_available(void)` | 是否链接了真实 iSH（桩实现返回 0） |
| `int coomi_ish_boot(const char *root, const char *workdir, void **out)` | 起内核 + 挂 fakefs |
| `int coomi_ish_run(void *inst, const char **argv, const char *cwd, uint32_t timeout_ms, ...)` | 一次性执行命令，收集 stdout/stderr |
| `int coomi_ish_shutdown(void *inst, uint32_t grace_ms)` | 关内核 |
| `void coomi_ish_free(void *p)` | 释放引擎返回的缓冲区 |

状态码见 `ISHBridge.swift` 的 `ISHStatus`（`ISH_OK=0`，`ISH_ERR_BOOT=-1` … `ISH_ERR_INTERNAL=-99`）。

### 3.2 fakefs = 普通宿主目录

iSH 的 fakefs 就是一个普通目录：App 沙箱里的 `Documents/linux` 就是 guest 的 `/`，双向可见。
所以 guest `/usr/bin/git` 对应宿主 `<Documents>/linux/usr/bin/git` —— `ISHBridge.hostURL(forGuestPath:)` 就是简单的前缀拼接。

### 3.3 rootfs 为什么要在 guest 里解包

iOS **不允许** `fork`/`exec` 外部进程（`Process` 在 iOS SDK 里根本不存在）。所以：

1. 把 `linux-rootfs.tar.gz` 从 App 资源拷到 `Documents/linux/.rootfs.tar.gz`（宿主侧可直接做的事）；
2. 起 iSH 内核；
3. 在 guest 里跑 `["/bin/tar","xzf","/.rootfs.tar.gz","-C","/"]` 解包。

所以是**两阶段启动**：内核先起，再铺 userland。顺序反了不行 —— `/bin/tar` 还没解出来时什么都干不了。
哨兵文件 `Documents/linux/.userland-ok` 标记已完成，比反复扫目录便宜，也比记 `UserDefaults` 可靠（用户可能删了 Documents）。

---

## 四、构建

### 4.1 引擎静态库

由 CI 产出（`.github/workflows/build-ios.yml` 的 `engine` job），不需要本地有 macOS：

```
rustup target add aarch64-apple-ios
cargo build --release --target aarch64-apple-ios -p coomi-ui --lib
# 产物 target/aarch64-apple-ios/release/libcoomi_ui.a
```

注意 `ring` 需要 clang，**Windows 上编不了 iOS target**，必须在 macOS 或 CI 上做。

### 4.2 前端

```bash
cd apps/web
npm ci
npx vite build
cp -R dist/. ../../apps/ios/CoomiApp/Resources/web/
```

### 4.3 工程与打包

```bash
brew install xcodegen
cd apps/ios
xcodegen generate
xcodebuild -project CoomiIOS.xcodeproj -scheme CoomiIOS \
  -configuration Release -sdk iphoneos \
  -archivePath build/CoomiIOS.xcarchive archive \
  CODE_SIGNING_ALLOWED=NO
```

产物 `CoomiIOS.ipa` **未签名**。装到真机需要自签：Xcode 用免费证书（7 天有效）、Sideloady、或 AltStore。

### 4.4 符号自检为什么用 `strings` 而不是 `nm`

CI 上踩过的真实坑：rustc 1.99.1 带 LLVM 23，而 Xcode 16.4 的 `nm` 是 LLVM 17 的产物，
解析 LLVM 23 的 DWARF 会报 `Unknown attribute kind (102)`，导致**符号其实存在却判为缺失**。

现在双保险：

1. 用 `rustup component add llvm-tools-preview` 装配套的 `llvm-nm`；
2. 同时用 `strings "$LIB" | grep -E "^_?coomi_(start|port|version)$"` —— `strings` 免疫 DWARF 版本漂移。

两者**任一通过即算通过**，永远不会因为工具链版本错配而产生假阴性。

---

## 五、目录

```
apps/ios/
├── CoomiApp/
│   ├── Sources/
│   │   ├── CoomiApp.swift        App 入口
│   │   ├── RootView.swift        主界面 + 首启引导页
│   │   ├── Readiness.swift       启动前就绪诊断（4 项）
│   │   ├── EngineController.swift 引擎生命周期（C ABI 调用）
│   │   ├── ISHBridge.swift       iSH 封装（C ABI 调用）
│   │   ├── ish_support.c         iSH 桩/真实实现切换
│   │   └── WebView.swift         承载前端
│   └── Resources/
│       ├── web/                  vite build 产物
│       └── linux-rootfs.tar.gz   Alpine aarch64（可选）
├── ThirdParty/
│   ├── engine/                   libcoomi_ui.a（CI 产出）
│   └── ish/                      libish.a + include/
├── project.yml                   XcodeGen 配置
└── docs/README.md                本文件
```

### 就绪诊断的 4 项（`Readiness.swift`）

| id | 是否阻塞 | 检查内容 |
|---|---|---|
| `engine` | ✅ 阻塞 | `libcoomi_ui.a` 的符号是否链进来了 |
| `home` | ✅ 阻塞 | `Documents/coomi-home` 可写（写探针） |
| `ish` | ❌ 非阻塞 | `ish_available()` 是否为真 |
| `rootfs` | ❌ 非阻塞 | 仅当 iSH 就绪时检查 `/bin/sh` 是否存在 |

前两项缺一个就进引导页（`canStart == false`）；后两项缺失只降级，不拦启动。
这个「阻塞 / 非阻塞」区分是本端的设计核心 —— 引擎缺了必须修，shell 缺了只是少个功能。

---

## 六、许可

- iSH 的 `LICENSE.IOS` 明确豁免 GPL 与 App Store 的冲突条款。
- `Lolendor/ish-arm64-pkg`（当前选用的 arm64 方案）**尚未确认 LICENSE**，商用前必须解决。
