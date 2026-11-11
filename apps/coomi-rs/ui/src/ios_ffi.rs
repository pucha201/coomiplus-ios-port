//! iOS 原生入口：Swift 直接调用，**引擎跑在 App 进程内**。
//!
//! # 与 iSH 的分工（重要）
//!
//! | 层 | 谁负责 | 说明 |
//! |---|---|---|
//! | **引擎** | 本模块（原生 aarch64 Rust） | 会话/记忆/模型/文件/HTTP 全部原生跑 |
//! | **工作环境** | iSH（`ish_support.c`） | 只在需要 shell/git/python 时，把命令交给 iSH 执行 |
//!
//! 这与 Android 完全同构：
//! - Android：引擎原生（JNI）+ proot 做工作环境
//! - iOS：引擎原生（staticlib）+ iSH 做工作环境
//!
//! 之前的错误做法是「引擎也跑进 iSH」——那要多一层模拟、多一份 rootfs、
//! 还要把 22MB 的 i686 引擎塞进 App，性能只剩 10-20%。
//!
//! # 为什么用 C ABI 而不是 Swift-Rust 桥接库
//! C ABI 是唯一无依赖、跨 Swift 版本稳定的接口。参数只用 `*const c_char` 与整数，
//! 字符串由调用方负责生命周期（Swift 用 `withCString` 保证）。
//!
//! # 线程模型
//! `coomi_start` 会在**独立线程**里建 tokio 运行时并启动 axum 服务，
//! 立即返回端口号，Swift 侧随后轮询健康检查。**不能**阻塞调用线程 ——
//! SwiftUI 主线程被卡住会直接触发 watchdog 崩溃。

// C ABI 出口必须写 unsafe（解引用裸指针、#[unsafe(no_mangle)]）。
// workspace 的 `unsafe_code = "forbid"` 是为了约束业务代码，
// 这里只在本模块内放宽，边界就是下面这几个 extern "C" 函数：
//   · 指针由 Swift 侧保证有效（withCString 覆盖调用期）；
//   · 本模块不做任何跨线程的裸指针传递；
//   · 返回值要么是整数、要么是进程生命周期内稳定的静态串。
#![allow(unsafe_code)]

use std::ffi::{c_char, CStr, CString};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

/// 引擎实际监听的端口（0 = 启动中/未启动）。
static PORT: AtomicU16 = AtomicU16::new(0);

/// 一次性启动锁：Swift 可能重复调用 `coomi_start`。
static STARTED: OnceLock<()> = OnceLock::new();

/// 启动引擎，返回监听端口；失败返回负数错误码。
///
/// # 参数
/// - `home`：数据目录（`app_home`）。C 字符串。
/// - `cwd`：工作目录。C 字符串。
/// - `token`：访问令牌。可为 NULL（表示不校验）。
///
/// # 返回
/// - `> 0`：端口号，可立即用 `http://127.0.0.1:<port>` 访问；
/// - `-1`：参数非法（空指针/非法 UTF-8）；
/// - `-2`：端口分配失败；
/// - `-3`：引擎已在启动中（可轮询 `coomi_port()` 拿结果）。
///
/// # 安全性
/// 调用方必须保证三个指针在调用期间有效。本函数不持有它们。
#[unsafe(no_mangle)]
pub extern "C" fn coomi_start(
    home: *const c_char,
    cwd: *const c_char,
    token: *const c_char,
) -> i32 {
    if home.is_null() || cwd.is_null() {
        return -1;
    }
    let home = match unsafe { CStr::from_ptr(home) }.to_str() {
        Ok(value) => PathBuf::from(value),
        Err(_) => return -1,
    };
    let cwd = match unsafe { CStr::from_ptr(cwd) }.to_str() {
        Ok(value) => PathBuf::from(value),
        Err(_) => return -1,
    };
    let token = if token.is_null() {
        String::new()
    } else {
        match unsafe { CStr::from_ptr(token) }.to_str() {
            Ok(value) => value.to_owned(),
            Err(_) => return -1,
        }
    };

    // 已经在启动：直接把当前端口（可能还是 0）报回去，让调用方轮询。
    if STARTED.get().is_some() {
        return -(3);
    }
    let _ = STARTED.set(());

    // 先同步抢一个端口：Swift 拿到端口号才能开始轮询健康检查。
    // 不能等线程起来再回 —— 那会退化成"盲等"。
    let port = match pick_port() {
        Ok(value) => value,
        Err(_) => {
            return -2;
        }
    };
    PORT.store(port, Ordering::Release);

    // 静态站点目录：前端产物已打进 App bundle，交给引擎直接 serve。
    let static_dir = home.join("web");

    std::thread::Builder::new()
        .name("coomi-engine".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("[ios] tokio 运行时创建失败: {error}");
                    PORT.store(0, Ordering::Release);
                    return;
                }
            };
            runtime.block_on(async move {
                if let Err(error) =
                    crate::web::serve(home, cwd, None, port, token, static_dir).await
                {
                    eprintln!("[ios] 引擎退出: {error:#}");
                    PORT.store(0, Ordering::Release);
                }
            });
        })
        .ok();

    port as i32
}

/// 当前端口；0 表示未就绪或已退出。
#[unsafe(no_mangle)]
pub extern "C" fn coomi_port() -> u16 {
    PORT.load(Ordering::Acquire)
}

/// 版本串（供诊断显示）。返回的指针在进程生命周期内有效，调用方**不要**释放。
#[unsafe(no_mangle)]
pub extern "C" fn coomi_version() -> *const c_char {
    static VERSION: OnceLock<CString> = OnceLock::new();
    // SAFETY: CARGO_PKG_VERSION 是编译期常量，不含 NUL。
    VERSION
        .get_or_init(|| CString::new(env!("CARGO_PKG_VERSION")).unwrap_or_default())
        .as_ptr()
}

/// 取一个空闲的 loopback 端口。
///
/// 让内核分配（bind 到 0）再释放，避免与已有服务撞端口。
/// 有极小的竞态窗口（释放到再次 bind 之间可能被占），
/// 但在 App 进程内只有我们自己 bind，实际风险可忽略。
fn pick_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}
