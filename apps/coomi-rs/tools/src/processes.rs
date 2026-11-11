use coomi_engine::ToolResult;
use coomi_services::RuntimeBackend;
use coomi_services::RuntimeBackendKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

/// 全局进程注册表：所有 ConnectionContext 共享同一张表，引擎收到终止信号时
/// 能一次性清理所有由它启动的工具进程（“关闭 app 后全部终止”）。
static PROCESS_REGISTRY: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<ManagedProcess>>>>> =
    OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<AsyncMutex<ManagedProcess>>>> {
    PROCESS_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 全局终止所有受管工具进程（引擎退出前调用）。
pub async fn terminate_all_managed() {
    let processes: Vec<Arc<AsyncMutex<ManagedProcess>>> = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain()
        .map(|(_, process)| process)
        .collect();
    for process in processes {
        kill_managed(&process).await;
    }
}

#[derive(Clone)]
pub struct ProcessManager {
    runtime_limit: Duration,
    output_limit: usize,
    memory_limit: u64,
    termux_backend: Option<Arc<dyn RuntimeBackend>>,
    proot_backend: Option<Arc<dyn RuntimeBackend>>,
    /// iSH（iOS）：进程内 Linux 内核。与 proot 同角色，但在 iOS 上是**唯一**的
    /// Linux 用户态 —— Termux/ProotLinux 在 iOS 上根本不存在。
    ish_backend: Option<Arc<dyn RuntimeBackend>>,
    /// 本实例启动并拥有的进程（session_id → process），用于按任务精确终止。
    owned: Arc<Mutex<HashMap<String, Arc<AsyncMutex<ManagedProcess>>>>>,
    /// 默认运行环境（native 设置页的「环境选择」写入 COOMI_DEFAULT_ENVIRONMENT）。
    /// 模型在工具参数里没给 environment 时用它兜底；为空 = 维持原来的 auto。
    default_environment: Option<String>,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self {
            runtime_limit: Duration::from_secs(30 * 60),
            output_limit: 16 * 1024 * 1024,
            memory_limit: 512 * 1024 * 1024,
            termux_backend: None,
            proot_backend: None,
            ish_backend: None,
            owned: Arc::new(Mutex::new(HashMap::new())),
            default_environment: std::env::var("COOMI_DEFAULT_ENVIRONMENT")
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty() && value != "auto"),
        }
    }
}

struct ManagedProcess {
    child: Child,
    /// Process-group id (Unix only): the shell is spawned with `process_group(0)` so that
    /// descendants (`cmd &` inside the shell) share the group and can be killed together.
    pgid: Option<u32>,
    stdin: Option<ChildStdin>,
    stdout: Arc<AsyncMutex<Vec<u8>>>,
    stderr: Arc<AsyncMutex<Vec<u8>>>,
    stdout_offset: usize,
    stderr_offset: usize,
    started_at: Instant,
    runtime_limit: Duration,
    memory_limit: u64,
    limit_error: Arc<Mutex<Option<String>>>,
}

/// Best-effort kill of a managed process: first the whole process group (child plus any
/// descendants) via `kill -9 -<pgid>`, then the direct child as a fallback. If the process
/// already exited, skip the group kill to avoid hitting a reused pgid.
async fn kill_managed(process: &Arc<AsyncMutex<ManagedProcess>>) {
    let pgid = {
        let mut guard = process.lock().await;
        if let Ok(Some(_)) = guard.child.try_wait() {
            return;
        }
        guard.pgid
    };
    if let Some(pgid) = pgid {
        let _ = std::process::Command::new("kill")
            .arg("-9")
            .arg(format!("-{pgid}"))
            .status();
    }
    let _ = process.lock().await.child.kill().await;
}

impl ProcessManager {
    pub fn with_runtime_backend(mut self, backend: Arc<dyn RuntimeBackend>) -> Self {
        match backend.kind() {
            RuntimeBackendKind::LegacyTermux => self.termux_backend = Some(backend),
            RuntimeBackendKind::ProotLinux => self.proot_backend = Some(backend),
            // iSH 单独一个槽位：iOS 上它是唯一的 Linux 用户态；
            // 其它平台永远不会注册它，所以不影响既有行为。
            RuntimeBackendKind::IshLinux => self.ish_backend = Some(backend),
            /// 宿主原生：**不注册任何后端** —— 后端为空正是 runtime_shell / start
            /// 走 platform_shell()（平台原生 shell）的条件，这就是我们要的语义。
            RuntimeBackendKind::Host => {}
        }
        self
    }

    /// Build a one-shot shell command using the configured runtime backend.
    /// `None` means the caller should use the platform host shell.
    pub fn runtime_shell(
        &self,
        cwd: &Path,
        command: &str,
        environment: Option<&str>,
    ) -> anyhow::Result<Option<Command>> {
        let Some(backend) = self.backend(environment)? else {
            return Ok(None);
        };
        if backend.kind() == RuntimeBackendKind::ProotLinux && Self::requests_root(command) {
            anyhow::bail!(Self::ROOT_PROOT_HINT);
        }
        let command = Self::proot_fallback_note(environment, backend)
            .map(|note| format!("{note}{command}"))
            .unwrap_or_else(|| command.into());
        Ok(Some(
            backend
                .command(cwd, "/bin/sh", &["-lc".into(), command])?
                .into_tokio(),
        ))
    }

    pub async fn execute(&self, cwd: &std::path::Path, arguments: &Value) -> ToolResult {
        let action = arguments
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("exec");
        match action {
            "exec" => self.start(cwd, arguments).await,
            "write" => self.write(arguments).await,
            "wait" => self.wait(arguments).await,
            "terminate" => self.terminate(arguments).await,
            _ => ToolResult::error("action must be exec, write, wait, or terminate"),
        }
    }

    async fn start(&self, cwd: &std::path::Path, arguments: &Value) -> ToolResult {
        let Some(command) = arguments.get("command").and_then(Value::as_str) else {
            return ToolResult::error("missing string argument: command");
        };
        let yield_time_ms = arguments
            .get("yield_time_ms")
            .and_then(Value::as_u64)
            .unwrap_or(10_000)
            .min(60_000);
        let environment = arguments.get("environment").and_then(Value::as_str);
        let backend = match self.backend(environment) {
            Ok(backend) => backend,
            Err(error) => return ToolResult::error(error.to_string()),
        };
        if backend.is_some_and(|backend| backend.kind() == RuntimeBackendKind::ProotLinux)
            && Self::requests_root(command)
        {
            return ToolResult::error(Self::ROOT_PROOT_HINT);
        }
        let uses_runtime_backend = backend.is_some();
        let mut process = if let Some(backend) = backend {
            let command = Self::proot_fallback_note(environment, backend)
                .map(|note| format!("{note}{command}"))
                .unwrap_or_else(|| command.into());
            match backend.command(cwd, "/bin/sh", &["-lc".into(), command]) {
                Ok(command) => command.into_tokio(),
                Err(error) => {
                    return ToolResult::error(format!(
                        "failed to prepare runtime shell: {error:#}"
                    ));
                }
            }
        } else {
            platform_shell(command)
        };
        // RuntimeCommand already carries the namespace-correct cwd.  Applying
        // the host cwd again breaks guest aliases and can make an otherwise
        // valid Termux/Proot command fail before the shell starts.
        if !uses_runtime_backend {
            process.current_dir(cwd);
        }
        process
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        process.process_group(0);
        let mut child = match process.spawn() {
            Ok(child) => child,
            Err(error) => return ToolResult::error(format!("failed to start shell: {error}")),
        };
        #[cfg(unix)]
        let pgid = child.id();
        #[cfg(not(unix))]
        let pgid = None;
        let stdin = child.stdin.take();
        let stdout_buffer = Arc::new(AsyncMutex::new(Vec::new()));
        let stderr_buffer = Arc::new(AsyncMutex::new(Vec::new()));
        let limit_error = Arc::new(Mutex::new(None));
        if let Some(mut stdout) = child.stdout.take() {
            let buffer = Arc::clone(&stdout_buffer);
            let error = Arc::clone(&limit_error);
            let output_limit = self.output_limit;
            tokio::spawn(async move {
                let mut chunk = [0_u8; 8192];
                loop {
                    match stdout.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(size) => {
                            append_limited(&buffer, &error, &chunk[..size], output_limit).await
                        }
                    }
                }
            });
        }
        if let Some(mut stderr) = child.stderr.take() {
            let buffer = Arc::clone(&stderr_buffer);
            let error = Arc::clone(&limit_error);
            let output_limit = self.output_limit;
            tokio::spawn(async move {
                let mut chunk = [0_u8; 8192];
                loop {
                    match stderr.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(size) => {
                            append_limited(&buffer, &error, &chunk[..size], output_limit).await
                        }
                    }
                }
            });
        }
        let session_id = Uuid::new_v4().to_string();
        let managed = Arc::new(AsyncMutex::new(ManagedProcess {
            child,
            pgid,
            stdin,
            stdout: stdout_buffer,
            stderr: stderr_buffer,
            stdout_offset: 0,
            stderr_offset: 0,
            started_at: Instant::now(),
            runtime_limit: self.runtime_limit,
            memory_limit: self.memory_limit,
            limit_error,
        }));
        if yield_time_ms > 0 {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(yield_time_ms);
            loop {
                {
                    let mut process = managed.lock().await;
                    if let Some(error) = enforce_limits(&mut process).await {
                        return ToolResult::error(error);
                    }
                    match process.child.try_wait() {
                        Ok(Some(status)) => {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            let output = read_delta(&mut process).await;
                            return if status.success() {
                                ToolResult::success(format!("{output}\nexit: {status}"))
                            } else {
                                ToolResult::error(format!("{output}\nexit: {status}"))
                            };
                        }
                        Ok(None) => {}
                        Err(error) => {
                            return ToolResult::error(format!("failed to query process: {error}"));
                        }
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        self.owned
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_id.clone(), Arc::clone(&managed));
        registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_id.clone(), managed);
        ToolResult::success(format!("process running\nsession_id: {session_id}"))
    }

    /// proot 后端收到 root 命令时返回的可操作错误。
    const ROOT_PROOT_HINT: &str = "root is only available in the Termux backend; ProotLinux cannot \
escalate to Android root. Retry this command with environment=termux (or environment=host when \
Termux is unavailable), and never promise the user that root works inside proot.";

/// 保守判断「这条命令要 Android root」。只在 proot 后端拦截，避免模型在 guest 里
/// 反复执行注定失败的 su；真正的 root 仍走 Termux shim 或 host shell。
fn requests_root(command: &str) -> bool {
    command
        .split(|character| matches!(character, ';' | '&' | '|' | '\n'))
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .any(|segment| {
            let first = segment.split_whitespace().next().unwrap_or_default();
            first == "su"
                || first == "sudo"
                || first.ends_with("/su")
                || first.ends_with("/sudo")
        })
}

/// environment=proot 而实际落在 Termux 上时，把降级原因写进命令 stderr。
/// 返回 None 表示没有发生降级（或者根本没选 proot）。
fn proot_fallback_note(
    environment: Option<&str>,
    backend: &Arc<dyn RuntimeBackend>,
) -> Option<&'static str> {
    let wanted = matches!(environment, Some("proot") | Some("proot_linux"));
    if wanted && backend.kind() == RuntimeBackendKind::LegacyTermux {
        Some("echo '[coomi-runtime] ProotLinux 未就绪，本次已回退 Termux 执行' >&2; ")
    } else {
        None
    }
}

fn backend(
        &self,
        environment: Option<&str>,
    ) -> anyhow::Result<Option<&Arc<dyn RuntimeBackend>>> {
        match environment.or(self.default_environment.as_deref()).unwrap_or("auto") {
            // auto 的优先级：iSH > proot > termux。
            // iSH 只在 iOS 上注册，其它平台这个槽位恒为 None，行为不变。
            "auto" => Ok(self
                .ish_backend
                .as_ref()
                .or(self.proot_backend.as_ref())
                .or(self.termux_backend.as_ref())),
            // 显式选 ish：iOS 上就是"用 Linux 用户态"。
            // 非 iOS 平台没有注册它，给出明确错误而不是静默降级。
            "ish" | "ish_linux" => self
                .ish_backend
                .as_ref()
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("iSH environment is only available on iOS")),
            "proot" | "proot_linux" => {
                // 用户报「运行工具报错（proot 环境有问题）」：显式选 proot 但环境没就绪时，
                // 回退 Termux 并让任务继续，降级原因由 proot_fallback_note 写进命令输出；
                // 连 Termux 都没有（桌面端）才保持硬错误 —— 那里 proot 本就不该被选。
                if self.proot_backend.is_some() {
                    return Ok(self.proot_backend.as_ref());
                }
                if self.termux_backend.is_some() {
                    return Ok(self.termux_backend.as_ref());
                }
                Err(anyhow::anyhow!("ProotLinux environment is not ready"))
            }
            "termux" => self
                .termux_backend
                .as_ref()
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("Termux environment is not available")),
            "host" => Ok(None),
            value => {
                let allowed = if cfg!(target_os = "ios") {
                    "auto, host, or ish"
                } else if cfg!(target_os = "android") {
                    "auto, host, termux, or proot"
                } else {
                    "auto or host (Termux, ProotLinux and iSH do not exist on this platform)"
                };
                anyhow::bail!("environment must be {allowed} (received {value})")
            }
        }
    }

    async fn write(&self, arguments: &Value) -> ToolResult {
        let Some(id) = arguments.get("session_id").and_then(Value::as_str) else {
            return ToolResult::error("missing string argument: session_id");
        };
        let input = arguments
            .get("input")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let process = match self.lookup(id) {
            Some(process) => process,
            None => return ToolResult::error(format!("unknown process session: {id}")),
        };
        let mut process = process.lock().await;
        let Some(stdin) = &mut process.stdin else {
            return ToolResult::error("process stdin is closed");
        };
        if let Err(error) = stdin.write_all(input.as_bytes()).await {
            return ToolResult::error(format!("failed to write stdin: {error}"));
        }
        if arguments
            .get("close_stdin")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            process.stdin.take();
        }
        ToolResult::success(format!("wrote {} bytes", input.len()))
    }

    async fn wait(&self, arguments: &Value) -> ToolResult {
        let Some(id) = arguments.get("session_id").and_then(Value::as_str) else {
            return ToolResult::error("missing string argument: session_id");
        };
        let yield_time_ms = arguments
            .get("yield_time_ms")
            .and_then(Value::as_u64)
            .unwrap_or(10_000)
            .min(60_000);
        let process = match self.lookup(id) {
            Some(process) => process,
            None => return ToolResult::error(format!("unknown process session: {id}")),
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(yield_time_ms);
        loop {
            let mut process = process.lock().await;
            if let Some(error) = enforce_limits(&mut process).await {
                drop(process);
                registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
                return ToolResult::error(error);
            }
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    let output = read_delta(&mut process).await;
                    drop(process);
                    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
                    return if status.success() {
                        ToolResult::success(format!("{output}\nexit: {status}"))
                    } else {
                        ToolResult::error(format!("{output}\nexit: {status}"))
                    };
                }
                Ok(None) => {
                    let output = read_delta(&mut process).await;
                    if !output.trim().is_empty() || tokio::time::Instant::now() >= deadline {
                        return ToolResult::success(format!("{output}\nprocess still running"));
                    }
                }
                Err(error) => {
                    return ToolResult::error(format!("failed to query process: {error}"));
                }
            }
            drop(process);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn terminate(&self, arguments: &Value) -> ToolResult {
        let Some(id) = arguments.get("session_id").and_then(Value::as_str) else {
            return ToolResult::error("missing string argument: session_id");
        };
        self.owned.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
        let process = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
        let Some(process) = process else {
            return ToolResult::error(format!("unknown process session: {id}"));
        };
        kill_managed(&process).await;
        ToolResult::success(format!("terminated {id}"))
    }

    /// Kill every process owned by this manager instance (per-turn / per-task cancel),
    /// so cancelling one task does not kill processes belonging to other sessions.
    pub async fn terminate_all(&self) {
        self.terminate_all_owned().await;
    }

    /// 终止本实例拥有的所有进程，并同步从全局注册表移除。
    pub async fn terminate_all_owned(&self) {
        let owned: Vec<(String, Arc<AsyncMutex<ManagedProcess>>)> = self
            .owned
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .collect();
        for (id, process) in owned {
            registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
            kill_managed(&process).await;
        }
    }

    fn lookup(&self, id: &str) -> Option<Arc<AsyncMutex<ManagedProcess>>> {
        registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }
}

async fn read_delta(process: &mut ManagedProcess) -> String {
    let stdout = process.stdout.lock().await;
    let stdout_delta = &stdout[process.stdout_offset.min(stdout.len())..];
    let stdout_text = String::from_utf8_lossy(stdout_delta).into_owned();
    process.stdout_offset = stdout.len();
    drop(stdout);

    let stderr = process.stderr.lock().await;
    let stderr_delta = &stderr[process.stderr_offset.min(stderr.len())..];
    let stderr_text = String::from_utf8_lossy(stderr_delta).into_owned();
    process.stderr_offset = stderr.len();
    match (stdout_text.trim().is_empty(), stderr_text.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout_text,
        (true, false) => format!("[stderr]\n{stderr_text}"),
        (false, false) => format!("{stdout_text}\n[stderr]\n{stderr_text}"),
    }
}

async fn append_limited(
    buffer: &Arc<AsyncMutex<Vec<u8>>>,
    error: &Arc<Mutex<Option<String>>>,
    chunk: &[u8],
    output_limit: usize,
) {
    let mut buffer = buffer.lock().await;
    let remaining = output_limit.saturating_sub(buffer.len());
    buffer.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    if chunk.len() > remaining {
        *error.lock().unwrap_or_else(|value| value.into_inner()) =
            Some(format!("process output exceeded {output_limit} bytes"));
    }
}

async fn enforce_limits(process: &mut ManagedProcess) -> Option<String> {
    let output_error = process
        .limit_error
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .clone();
    let error = if let Some(error) = output_error {
        Some(error)
    } else if process.started_at.elapsed() > process.runtime_limit {
        Some(format!(
            "process runtime exceeded {} seconds",
            process.runtime_limit.as_secs()
        ))
    } else if let Some(pid) = process.child.id()
        && let Some(bytes) = process_memory_bytes(pid)
        && bytes > process.memory_limit
    {
        Some(format!(
            "process memory exceeded {} bytes (observed {bytes})",
            process.memory_limit
        ))
    } else {
        None
    };
    if error.is_some() {
        let _ = process.child.kill().await;
    }
    error
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn process_memory_bytes(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let kilobytes = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kilobytes.saturating_mul(1024))
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn process_memory_bytes(_pid: u32) -> Option<u64> {
    None
}

#[cfg(windows)]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("powershell.exe");
    process.args(["-NoLogo", "-NoProfile", "-Command", command]);
    process
}

#[cfg(target_os = "android")]
fn platform_shell(command: &str) -> Command {
    // Android 上没有 /bin/bash。JNI 引擎继承的是 App 进程环境，通常没有 PREFIX/
    // COOMI_SHELL；如果 bootstrap 缺失或损坏，原来的回退会去 exec 一个不存在的
    // /bin/bash，host 后端（以及 root 的最后退路）直接起不来。系统 sh 一定存在。
    let shell = std::env::var_os("COOMI_SHELL")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("PREFIX")
                .map(std::path::PathBuf::from)
                .map(|prefix| prefix.join("bin").join("bash"))
        })
        .filter(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("/system/bin/sh"));
    let mut process = Command::new(shell);
    process.args(["-lc", command]);
    process
}

#[cfg(all(not(windows), not(target_os = "android")))]
fn platform_shell(command: &str) -> Command {
    let shell = std::env::var_os("COOMI_SHELL")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("PREFIX")
                .map(std::path::PathBuf::from)
                .map(|prefix| prefix.join("bin").join("bash"))
        })
        .filter(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("/bin/bash"));
    let mut process = Command::new(shell);
    process.args(["-lc", command]);
    process
}

#[cfg(test)]
mod tests {
    use super::ProcessManager;

    #[test]
    fn detects_root_commands_without_matching_arguments() {
        assert!(ProcessManager::requests_root("su -c id"));
        assert!(ProcessManager::requests_root("sudo id"));
        assert!(ProcessManager::requests_root("/system/bin/su -c id"));
        assert!(ProcessManager::requests_root("pwd && su -c id"));
        assert!(ProcessManager::requests_root("echo ready; su 0 id"));
        assert!(!ProcessManager::requests_root("echo su"));
        assert!(!ProcessManager::requests_root("grep su file.txt"));
        assert!(!ProcessManager::requests_root("sudoers --check"));
    }
}
