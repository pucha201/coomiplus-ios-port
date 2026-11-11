//! JNI 桥：把 coomi 引擎编译成 cdylib（libcoomi_engine.so）直接集成进 Android
//! 应用进程内，替代 Termux 式子进程 exec —— 启动确定性：引擎在本进程内绑定端口，
//! WebView 首次 loadUrl 一次成功，连接被拒的竞态从根上消失。
//!
//! 参数不经 JNIEnv：Java 侧用 android.system.Os.setenv 写入 COOMI_JNI_LAUNCH
//! （JSON，字段与 `coomi serve` CLI 一一对应），native 端只读环境变量 ——
//! 全程零 unsafe，零 JNI vtable 操作。
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};

use serde::Deserialize;

/// Java 侧写入的启动参数（与 `coomi serve` CLI 一一对应）。
#[derive(Deserialize)]
struct Launch {
    home: String,
    cwd: String,
    #[serde(default)]
    inbox: Option<String>,
    static_dir: String,
    port: u16,
    #[serde(default)]
    token: String,
}

/// 进程内引擎状态机：
/// 0 = 未启动；1 = 正在运行；2 = 上一次 serve 已退出/失败（允许重新启动）。
///
/// 旧实现用 `AtomicBool` 做一次性闩锁：serve 线程 panic/退出后，`nativeStart()`
/// 只会返回 0（"已受理"）而不会再起线程 —— 于是引擎在 App 的整个生命周期里
/// 永久死亡，用户只能看到「引擎已崩溃」。
static STATE: AtomicU8 = AtomicU8::new(0);

fn append_crash(home: &str, message: String) {
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(home).join("crash_rust.log"))
    else {
        return;
    };
    let _ = writeln!(
        file,
        "[{}] {message}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
}

/// 进程内启动引擎服务线程。
///
/// 幂等语义：引擎正在运行时重复调用返回 0；上一次 serve 线程已经退出（STATE=2）
/// 时允许重新启动。返回 0 = 受理；-1 = 启动参数缺失/不合法；-2 = 后台线程创建失败。
#[unsafe(no_mangle)]
pub extern "C" fn Java_app_coomi_CoomiJniBridge_nativeStart() -> i32 {
    let raw = match std::env::var("COOMI_JNI_LAUNCH") {
        Ok(value) => value,
        Err(_) => return -1,
    };
    let cfg: Launch = match serde_json::from_str(&raw) {
        Ok(cfg) => cfg,
        Err(_) => return -1,
    };
    // 状态机：空闲/失败 → 运行中；已在运行则幂等返回 0。
    // 上一次 serve 线程退出（STATE=2）后允许重新启动，这是“同一个 App 进程内
    // 引擎崩溃后能自愈”的前提。
    let mut current = STATE.load(Ordering::SeqCst);
    loop {
        match current {
            0 | 2 => match STATE.compare_exchange(
                current,
                1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            },
            _ => return 0,
        }
    }
    // 崩溃采集与 bin 的 run() 同款：panic 落盘 <home>/crash_rust.log。
    {
        let home = PathBuf::from(cfg.home.clone());
        std::panic::set_hook(Box::new(move |info| {
            let message = format!(
                "[{}] panic: {info}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(home.join("crash_rust.log"))
            {
                let _ = writeln!(file, "{message}");
            }
        }));
    }
    let handle = std::thread::Builder::new()
        .name("coomi-engine-serve".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    append_crash(&cfg.home, format!("jni: tokio runtime failed: {err}"));
                    STATE.store(2, Ordering::SeqCst);
                    return;
                }
            };
            let home = cfg.home.clone();
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                runtime.block_on(coomi_ui::web::serve(
                    PathBuf::from(cfg.home.clone()),
                    PathBuf::from(cfg.cwd.clone()),
                    cfg.inbox.clone().map(PathBuf::from),
                    cfg.port,
                    cfg.token.clone(),
                    PathBuf::from(cfg.static_dir.clone()),
                ))
            }));
            match result {
                Ok(Ok(())) => append_crash(&home, "jni: serve loop exited".to_string()),
                Ok(Err(err)) => append_crash(&home, format!("jni: serve failed: {err}")),
                Err(panic) => append_crash(&home, format!("jni: serve panicked: {panic:?}")),
            }
            // serve 已经结束（无论是正常返回、报错还是 panic）：标记为可重启。
            STATE.store(2, Ordering::SeqCst);
        });
    match handle {
        Ok(_) => 0,
        Err(_) => {
            STATE.store(0, Ordering::SeqCst);
            -2
        }
    }
}
