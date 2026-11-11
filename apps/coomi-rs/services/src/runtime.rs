use anyhow::{Context, Result};
use async_trait::async_trait;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::header::{ETAG, IF_RANGE, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const RUNTIME_STATE_VERSION: u32 = 2;

/// 首次启动补装 guest 依赖（Node/npm、Python/pip、git、curl、ssh、uv）的一次性标记。
/// v2：旧镜像可能只有 npm/pip/ssh，缺 git/curl/uv；升级后自动补一轮。
const GUEST_ENV_MARKER: &str = ".coomi-env-npm-pip-ssh-v2";
const GUEST_ENV_STATUS_FILE: &str = "guest-env-status.json";
static GUEST_ENV_REPAIRING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GuestEnvStatus {
    /// pending / running / ready / error
    pub state: String,
    /// prepare / apt-update / downloading / installing / finalize / done / error
    #[serde(default)]
    pub phase: String,
    /// 最近一段安装日志（UI 自动滚到底部展示）。
    #[serde(default)]
    pub log_tail: String,
    /// 本次 apt 已下载字节数（从 Get: 行累计）。
    #[serde(default)]
    pub downloaded_bytes: u64,
    /// 最近一个采样窗口的下载速度（字节/秒）。
    #[serde(default)]
    pub speed_bps: u64,
    #[serde(default)]
    pub elapsed_ms: u64,
    /// 本次使用的镜像摘要（apt / npm / pip）。
    #[serde(default)]
    pub mirror: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at_ms: u64,
}

impl GuestEnvStatus {
    fn new(state: impl Into<String>, error: Option<String>) -> Self {
        Self {
            state: state.into(),
            phase: String::new(),
            log_tail: String::new(),
            downloaded_bytes: 0,
            speed_bps: 0,
            elapsed_ms: 0,
            mirror: String::new(),
            error,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBackendKind {
    LegacyTermux,
    ProotLinux,
    /// 宿主原生：不经任何 guest。**Windows / macOS / Linux 的默认**——
    /// 这两个平台既没有 Termux 也没有 ProotLinux，默认成 legacy_termux 会让
    /// 落盘的 state.json 一直声称存在，shell 也会被解析到 `/bin/sh` 这类非原生路径。
    Host,
    /// iSH（iOS）：x86 用户态模拟，**在 App 进程内**跑 Linux。
    ///
    /// 它取代 Termux/ProotLinux 的角色：iOS 上既没有 Termux 也没有 proot，
    /// 但引擎仍然需要一个 Linux 用户态（git/shell/python 等）。
    /// 与 ProotLinux 的区别只在「启动器」：
    ///   · proot：ptrace 劫持路径的独立可执行文件；
    ///   · iSH：进程内的 Linux 内核（task 表 + 系统调用实现），命令直接交给它跑。
    /// 命令组装（workspace/home/tmp 的绑定）、PATH、环境变量与 ProotLinux 保持一致，
    /// 这样工具层、前端、提示词都不需要改。
    IshLinux,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeInstallStatus {
    NotInstalled,
    Downloading,
    Initializing,
    Ready,
    NeedsRepair,
    UpdateAvailable,
    RollingBack,
    Removing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeArtifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

impl RuntimeArtifact {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.url.starts_with("https://"),
            "runtime artifact URL must use HTTPS"
        );
        anyhow::ensure!(
            self.sha256.len() == 64 && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "runtime artifact SHA-256 is invalid"
        );
        anyhow::ensure!(self.size > 0, "runtime artifact size must be positive");
        Ok(())
    }
}

/// 当前二进制自己的 ABI。编译期确定，不依赖运行时探测。
///
/// 为什么需要：manifest 里的 `architecture` 以前被硬断言成 `arm64-v8a`，
/// 于是 32 位包拿到 arm64 manifest 时会「校验通过」然后去下载 158MB 的
/// arm64 rootfs，在 armhf 设备上解压/执行阶段卡死（真实线上故障）。
/// 架构不匹配必须在打开 manifest 的那一刻就失败，不能等下载完才发现。
pub const fn host_abi() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64-v8a"
    } else if cfg!(target_arch = "arm") {
        "armeabi-v7a"
    } else {
        "unsupported"
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeManifest {
    pub version: u32,
    pub runtime_version: String,
    pub architecture: String,
    pub proot_commit: String,
    pub proot_license: String,
    pub host: RuntimeArtifact,
    /// 缺失表示「当前构建不含运行环境」。
    ///
    /// 32 位分支在没有 armhf rootfs 时会产出这种 manifest：界面应当显示
    /// 「本版本不含运行环境」并隐藏安装按钮，而不是让用户点了再卡住。
    #[serde(default)]
    pub rootfs: Option<RuntimeArtifact>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

impl RuntimeManifest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.version == RUNTIME_STATE_VERSION,
            "unsupported runtime manifest version"
        );
        // 先确认是本产品支持的架构，再确认与本机一致。分两步是为了让错误信息
        // 能区分「这份 manifest 是垃圾」和「这份 manifest 是另一台设备的」。
        anyhow::ensure!(
            matches!(self.architecture.as_str(), "arm64-v8a" | "armeabi-v7a"),
            "unsupported runtime architecture: {}",
            self.architecture
        );
        // 桌面构建与单元测试跑在 x86 上，`host_abi()` 会是 "unsupported"。
        // 那种情况下没法判断「本机架构」，只做上面的白名单校验即可。
        let host = host_abi();
        if host != "unsupported" {
            anyhow::ensure!(
                self.architecture == host,
                "runtime manifest targets {}, but this build is {}",
                self.architecture,
                host
            );
        }
        anyhow::ensure!(self.proot_commit.len() == 40, "PRoot commit must be pinned");
        anyhow::ensure!(
            self.proot_license == "GPL-2.0-or-later",
            "unexpected PRoot license"
        );
        self.host.validate()?;
        // rootfs 可以为 None（「本版本不含运行环境」），有就校验。
        if let Some(rootfs) = &self.rootfs {
            rootfs.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeState {
    pub version: u32,
    pub backend: RuntimeBackendKind,
    pub status: RuntimeInstallStatus,
    #[serde(default)]
    pub active_version: Option<String>,
    #[serde(default)]
    pub previous_version: Option<String>,
    #[serde(default)]
    pub installed_at_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            version: RUNTIME_STATE_VERSION,
            /* 默认后端按平台定：桌面端既没有 Termux 也没有 ProotLinux，
               默认成 legacy_termux 会让落盘的 state.json 一直声称它存在，
               UI 与提示词据此给出误导信息。 */
            backend: if cfg!(target_os = "ios") {
                // iOS：iSH 内核在进程内，"guest" 就是本进程看到的 Linux 用户态。
                RuntimeBackendKind::IshLinux
            } else if cfg!(target_os = "android") {
                RuntimeBackendKind::LegacyTermux
            } else {
                RuntimeBackendKind::Host
            },
            status: RuntimeInstallStatus::NotInstalled,
            active_version: None,
            previous_version: None,
            installed_at_ms: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct DownloadState {
    version: u32,
    url: String,
    etag: Option<String>,
    downloaded: u64,
    expected_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RuntimeDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeCommand {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Debug)]
pub struct RuntimeOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl RuntimeCommand {
    pub fn into_tokio(self) -> Command {
        let mut command = Command::new(self.program);
        command.args(self.arguments);
        command.env_clear();
        command.envs(self.environment);
        command.current_dir(self.cwd);
        command.stdin(Stdio::null());
        command
    }

    pub async fn output_limited(
        self,
        runtime_limit: Duration,
        output_limit: usize,
    ) -> Result<RuntimeOutput> {
        anyhow::ensure!(output_limit > 0, "runtime output limit must be positive");
        let mut command = self.into_tokio();
        command
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("failed to start runtime command")?;
        let stdout = child
            .stdout
            .take()
            .context("runtime command has no stdout")?;
        let stderr = child
            .stderr
            .take()
            .context("runtime command has no stderr")?;
        let stdout_reader = tokio::spawn(read_limited(stdout, output_limit));
        let stderr_reader = tokio::spawn(read_limited(stderr, output_limit));

        let status = match tokio::time::timeout(runtime_limit, child.wait()).await {
            Ok(status) => status.context("failed to wait for runtime command")?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = stdout_reader.await;
                let _ = stderr_reader.await;
                anyhow::bail!(
                    "runtime command exceeded {} seconds",
                    runtime_limit.as_secs()
                );
            }
        };
        let stdout = stdout_reader
            .await
            .context("runtime stdout reader stopped")??;
        let stderr = stderr_reader
            .await
            .context("runtime stderr reader stopped")??;
        anyhow::ensure!(
            stdout.len().saturating_add(stderr.len()) <= output_limit,
            "runtime command output exceeded {output_limit} bytes"
        );
        // 方案4：Permission denied 诊断——命令失败且 stderr 暴露权限拒绝时，
        // 追加一行可操作的诊断提示，避免用户看到裸的 Permission denied 无从下手。
        let mut stderr = stderr;
        if !status.success() {
            let lower = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
            if lower.contains("permission denied") {
                stderr.extend_from_slice("\n[coomi-runtime] 权限不足诊断：请检查 proot 挂载目录 host 权限（/home/coomi、/opt/coomi-dev、/tmp 应为 0700，rootfs /tmp 应为 1777）。若为 Android /storage 目录只读，请在授权目录内工作。\n".as_bytes());
            }
        }
        Ok(RuntimeOutput {
            status,
            stdout,
            stderr,
        })
    }
}

async fn read_limited<R>(stream: R, output_limit: usize) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let byte_limit = output_limit.saturating_add(1) as u64;
    let mut stream = stream.take(byte_limit);
    let mut output = Vec::with_capacity(output_limit.min(64 * 1024));
    stream.read_to_end(&mut output).await?;
    anyhow::ensure!(
        output.len() <= output_limit,
        "runtime command output exceeded {output_limit} bytes"
    );
    Ok(output)
}

#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    fn kind(&self) -> RuntimeBackendKind;
    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand>;
    fn command_with_environment(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
        environment: &BTreeMap<String, String>,
    ) -> Result<RuntimeCommand> {
        let mut runtime_command = self.command(workspace, command, arguments)?;
        runtime_command.environment.extend(environment.clone());
        Ok(runtime_command)
    }
    async fn health_check(&self) -> Result<()>;
}

/// iSH（iOS）后端：把命令交给**进程内的 iSH Linux 内核**执行。
///
/// # 与 ProotLinux 的关系（这是「仅做适配」的关键）
/// 两者扮演同一角色 —— 提供 Linux 用户态让 `git`/`sh`/`python` 可用：
///
/// | | ProotLinux | iSH |
/// |---|---|---|
/// | 启动方式 | 外部 `proot` 可执行文件，ptrace 劫持路径 | 进程内 Linux 内核（task 表 + 系统调用） |
/// | 路径映射 | `-b host:guest` 绑定 workspace/home/tmp | **不需要**：iSH 看到的 `/` 就是真实的宿主根 |
/// | rootfs | `runtime-v2/versions/<v>/rootfs` | iSH 内的一整套 Alpine 用户态 |
/// | 环境变量 | 手工拼 PATH/HOME | 同样拼，保持一致 |
///
/// 因此命令组装比 ProotLinux **更简单**：没有 `-b` 绑定、没有 `-0` fake root、
/// 没有 proc shim（iSH 自己实现了 /proc）。
/// 但对外接口（`RuntimeBackend`）与产出的 `RuntimeCommand` 完全一致，
/// 所以工具层、前端、提示词**一行都不用改**。
#[derive(Clone, Debug)]
pub struct IshLinuxBackend {
    /// 运行时根（与其它后端保持同名字段，便于共用诊断接口）。
    pub runtime_root: PathBuf,
}

impl IshLinuxBackend {
    pub fn new(runtime_root: PathBuf) -> Self {
        Self { runtime_root }
    }

    /// iSH 里 guest 的工作目录就是宿主目录本身（没有 `/workspace` 映射）。
    fn guest_workspace(&self, workspace: &Path) -> PathBuf {
        // 保持与其它后端一致的“必须先存在”约定：不存在的目录直接报错，
        // 而不是让命令在一个不存在的 cwd 里跑出难以理解的错误。
        canonical_existing(workspace).unwrap_or_else(|_| workspace.to_path_buf())
    }
}

#[async_trait]
impl RuntimeBackend for IshLinuxBackend {
    fn kind(&self) -> RuntimeBackendKind {
        RuntimeBackendKind::IshLinux
    }

    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand> {
        self.command_with_environment(workspace, command, arguments, &BTreeMap::new())
    }

    fn command_with_environment(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
        guest_environment: &BTreeMap<String, String>,
    ) -> Result<RuntimeCommand> {
        let cwd = self.guest_workspace(workspace);
        // 与 ProotLinux 保持同一套 PATH/HOME 语义：先本地 bin，再系统路径。
        // 环境变量是**全量**（RuntimeCommand 会 env_clear 后只注入这里的），
        // 所以一个都不能漏。
        let mut environment = BTreeMap::new();
        environment.insert(
            "PATH".to_owned(),
            "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
        );
        environment.insert("HOME".to_owned(), "/root".to_owned());
        environment.insert("TERM".to_owned(), "xterm-256color".to_owned());
        environment.insert("LANG".to_owned(), "C.UTF-8".to_owned());
        // 标记当前处于 iSH：工具/提示词可据此选择更保守的行为。
        environment.insert("COOMI_RUNTIME".to_owned(), "ish_linux".to_owned());
        for (key, value) in guest_environment {
            environment.insert(key.clone(), value.clone());
        }
        Ok(RuntimeCommand {
            program: PathBuf::from(command),
            arguments: arguments.to_vec(),
            environment,
            cwd,
        })
    }

    async fn health_check(&self) -> Result<()> {
        // iSH 的价值判断只有一个：`/bin/sh` 能不能跑。
        // 这与 ProotLinux 的 health_check 同口径（那边查的是 rootfs 里的 sh）。
        let shell = Path::new("/bin/sh");
        anyhow::ensure!(
            shell.is_file(),
            "iSH userland is incomplete: /bin/sh is missing"
        );
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct LegacyTermuxBackend {
    pub prefix: PathBuf,
    pub home: PathBuf,
}

impl LegacyTermuxBackend {
    /// Resolve the Termux bootstrap roots from Coomi's config directory.
    /// Android launches the engine with COOMI_HOME at
    /// `<files>/home/.coomi`, while the bootstrap lives at `<files>/usr`.
    pub fn from_coomi_home(coomi_home: &Path) -> Self {
        let termux_home = coomi_home
            .file_name()
            .is_some_and(|name| name == ".coomi")
            .then(|| coomi_home.parent())
            .flatten()
            .filter(|home| home.file_name().is_some_and(|name| name == "home"));
        if let Some(termux_home) = termux_home
            && let Some(files_root) = termux_home.parent()
            && files_root.file_name().is_some_and(|name| name == "files")
        {
            return Self {
                prefix: files_root.join("usr"),
                home: termux_home.to_path_buf(),
            };
        }
        Self {
            prefix: coomi_home.join("files/usr"),
            home: coomi_home.join("files/home"),
        }
    }
}

#[async_trait]
impl RuntimeBackend for LegacyTermuxBackend {
    fn kind(&self) -> RuntimeBackendKind {
        RuntimeBackendKind::LegacyTermux
    }

    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand> {
        // Runtime callers use Linux-style absolute names (for example
        // `/bin/sh`).  Those names belong to the selected runtime namespace;
        // they must be resolved inside Termux's PREFIX instead of being
        // appended as an absolute host path.
        let program = termux_program_path(&self.prefix, command);
        anyhow::ensure!(
            program.is_file(),
            "Termux executable is missing at {}; resolved PREFIX is {}",
            program.display(),
            self.prefix.display()
        );
        let mut environment = minimal_environment(&self.home, &self.prefix.join("tmp"));
        environment.insert("PREFIX".into(), self.prefix.to_string_lossy().into_owned());
        environment.insert(
            "PATH".into(),
            format!("{}/bin:/system/bin", self.prefix.display()),
        );
        environment.insert(
            "LD_LIBRARY_PATH".into(),
            self.prefix.join("lib").to_string_lossy().into_owned(),
        );
        let preload = self.prefix.join("lib/libtermux-exec-ld-preload.so");
        if preload.is_file() {
            environment.insert("LD_PRELOAD".into(), preload.to_string_lossy().into_owned());
        }
        environment.insert(
            "SHELL".into(),
            self.prefix.join("bin/bash").to_string_lossy().into_owned(),
        );
        environment.insert(
            "SSL_CERT_FILE".into(),
            self.prefix
                .join("etc/tls/cert.pem")
                .to_string_lossy()
                .into_owned(),
        );
        environment.insert("COOMI_RUNTIME_BACKEND".into(), "termux".into());
        Ok(RuntimeCommand {
            program,
            arguments: arguments.to_vec(),
            environment,
            cwd: workspace.to_owned(),
        })
    }

    async fn health_check(&self) -> Result<()> {
        anyhow::ensure!(
            self.prefix.join("bin/sh").is_file(),
            "legacy shell is missing"
        );
        Ok(())
    }
}

fn termux_program_path(prefix: &Path, command: &str) -> PathBuf {
    let command = command.trim();
    let relative = command
        .strip_prefix("/bin/")
        .or_else(|| command.strip_prefix("/usr/bin/"))
        .or_else(|| command.strip_prefix('/'))
        .unwrap_or(command);
    // Termux's PREFIX already represents `/usr`; both Linux spellings map
    // to PREFIX/bin, never PREFIX/usr/bin.
    prefix.join("bin").join(relative)
}

#[derive(Clone, Debug)]
pub struct ProotLinuxBackend {
    pub runtime_root: PathBuf,
    pub version: String,
}

impl ProotLinuxBackend {
    fn version_root(&self) -> PathBuf {
        self.runtime_root.join("versions").join(&self.version)
    }

    fn proot(&self) -> PathBuf {
        self.version_root().join("bin").join("proot")
    }

    fn rootfs(&self) -> PathBuf {
        self.version_root().join("rootfs")
    }
}

#[async_trait]
impl RuntimeBackend for ProotLinuxBackend {
    fn kind(&self) -> RuntimeBackendKind {
        RuntimeBackendKind::ProotLinux
    }

    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand> {
        self.command_with_environment(workspace, command, arguments, &BTreeMap::new())
    }

    fn command_with_environment(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
        guest_environment: &BTreeMap<String, String>,
    ) -> Result<RuntimeCommand> {
        let rootfs = self.rootfs();
        anyhow::ensure!(self.proot().is_file(), "PRoot host is not installed");
        anyhow::ensure!(
            rootfs.join("bin/sh").is_file(),
            "guest rootfs is incomplete"
        );
        let home = self.runtime_root.join("home");
        let build_kit = home.join(".coomi-dev");
        let tmp = self.runtime_root.join("tmp");
        let shm = tmp.join("shm");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&build_kit)?;
        fs::create_dir_all(&tmp)?;
        // Python 的 multiprocessing / 共享内存要 /dev/shm。rootfs 里有这个目录，
        // 但启动时整个 /dev 被 Android 的只读 /dev 覆盖，guest 内建不出来 → 绑一个可写目录过去。
        fs::create_dir_all(&shm)?;
        // 权限兜底：proot 以 -0（fake root）运行，但 host 侧目录仍受 Android 权限约束。
        // 统一设为 0700，避免 host 侧目录 000/只读导致 guest 内写 /home/coomi、/opt/coomi-dev、/tmp 报 Permission denied。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [&home, &build_kit, &tmp, &shm] {
                let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
            }
        }
        let workspace = canonical_existing(workspace)?;
        let home = canonical_existing(&home)?;
        let build_kit = canonical_existing(&build_kit)?;
        let tmp = canonical_existing(&tmp)?;
        let shm = tmp.join("shm");
        // Android 10+ 对 /proc/stat、/proc/uptime、/proc/loadavg 做了访问限制。
        // 能读就不用假文件；读不到才生成一份单调递增的占位数据并文件级 bind，
        // 让 psutil 这类库不至于直接抛 PermissionError（数值仅供参考）。
        let proc_shim = write_proc_shim(&tmp).ok();
        let mut proot_args = vec![
            "--kill-on-exit".into(),
            "-0".into(),
            "-r".into(),
            rootfs.to_string_lossy().into_owned(),
            "-b".into(),
            format!("{}:/workspace", workspace.display()),
            "-b".into(),
            format!("{}:/home/coomi", home.display()),
            "-b".into(),
            format!("{}:/opt/coomi-dev", build_kit.display()),
            "-b".into(),
            format!("{}:/tmp", tmp.display()),
            // Expose the same verified host launcher inside the guest so
            // `which proot` and tools that explicitly invoke PRoot resolve to
            // the Runtime V2 binary instead of falling back to Termux.
            "-b".into(),
            format!("{}:/usr/local/bin/proot", self.proot().display()),
            "-b".into(),
            "/proc".into(),
            "-b".into(),
            "/dev".into(),
            // /dev 被 Android 的只读版本覆盖后，guest 里再建 /dev/shm 会被拒；
            // 绑一个 host 可写目录过去，multiprocessing / POSIX 信号量才能用。
            "-b".into(),
            format!("{}:/dev/shm", shm.display()),
        ];
        if let Some(dir) = proc_shim {
            for name in ["stat", "uptime", "loadavg"] {
                let file = dir.join(name);
                if file.is_file() {
                    proot_args.push("-b".into());
                    proot_args.push(format!("{}:/proc/{name}", file.display()));
                }
            }
        }
        proot_args.extend([
            "-w".into(),
            "/workspace".into(),
            "/usr/bin/env".into(),
            "-i".into(),
            "HOME=/home/coomi".into(),
            "PATH=/opt/coomi-dev/current/bin:/opt/coomi-dev/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
            "TMPDIR=/tmp".into(),
            "COOMI_RUNTIME_BACKEND=proot_linux".into(),
            "COOMI_BUILD_KIT=/opt/coomi-dev".into(),
            "COOMI_PROOT_HOST=/usr/local/bin/proot".into(),
            "LANG=C.UTF-8".into(),
            "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt".into(),
        ]);
        for (key, value) in guest_environment {
            anyhow::ensure!(
                !key.is_empty()
                    && key.bytes().all(|byte| byte.is_ascii_uppercase()
                        || byte.is_ascii_digit()
                        || byte == b'_'),
                "invalid guest environment key"
            );
            anyhow::ensure!(!value.contains('\0'), "invalid guest environment value");
            proot_args.push(format!("{key}={value}"));
        }
        proot_args.push(command.into());
        proot_args.extend(arguments.iter().cloned());
        Ok(RuntimeCommand {
            program: self.proot(),
            arguments: proot_args,
            environment: {
                let mut environment = minimal_environment(&home, &tmp);
                // PRoot otherwise falls back to the compile-time Termux temp
                // path (/data/data/com.termux/...), which does not exist in
                // the standalone Coomi package.
                environment.insert("PROOT_TMP_DIR".into(), tmp.to_string_lossy().into_owned());
                environment.insert(
                    "LD_LIBRARY_PATH".into(),
                    self.version_root()
                        .join("lib")
                        .to_string_lossy()
                        .into_owned(),
                );
                environment
            },
            cwd: workspace,
        })
    }

    async fn health_check(&self) -> Result<()> {
        let command = self.command(
            &self.runtime_root,
            "/bin/sh",
            &[
                "-c".into(),
                "test -x /usr/bin/apt && test -x /usr/bin/python3".into(),
            ],
        )?;
        let output = command.into_tokio().output().await?;
        anyhow::ensure!(
            output.status.success(),
            "guest health check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(())
    }
}

/// guest 环境事实（执行探测结果），供 runtime_doctor、提示词注入与前端徽标使用。
#[derive(Clone, Debug, Default, Serialize)]
pub struct GuestFacts {
    pub backend: String,
    pub sh: bool,
    pub python: Option<String>,
    pub git: Option<String>,
    pub node: Option<String>,
    pub curl: Option<String>,
    pub network: Option<String>,
    pub workspace: bool,
    pub tmp_writable: bool,
    pub error: Option<String>,
}

/// 环境检测里的单个命令结果。
#[derive(Clone, Debug, Default, Serialize)]
pub struct EnvCommandProbe {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// 环境检测里的网络探测结果。
#[derive(Clone, Debug, Default, Serialize)]
pub struct EnvNetworkProbe {
    pub url: String,
    pub ok: bool,
    pub status: String,
}

/// 给扩展中心「环境检测」用的完整报告：在活跃运行时里真的执行命令，而不是猜路径。
#[derive(Clone, Debug, Default, Serialize)]
pub struct RuntimeEnvReport {
    pub backend: String,
    pub status: String,
    pub active_version: Option<String>,
    pub rootfs: Option<String>,
    pub home: String,
    pub shell_ok: bool,
    pub commands: Vec<EnvCommandProbe>,
    pub mirrors: BTreeMap<String, String>,
    pub network: Vec<EnvNetworkProbe>,
    pub missing: Vec<String>,
    pub ok: bool,
    pub fixable: bool,
    pub error: Option<String>,
}

/// 在指定后端内实际执行一次探测：shell 可运行 + 工具链版本 + 挂载点可达。
pub async fn probe_guest_facts(
    backend: &impl RuntimeBackend,
    workspace: &Path,
) -> Result<GuestFacts> {
    let script = r#"
echo "__sh__ok"
test -d /workspace && echo "__workspace__ok" || echo "__workspace__missing"
test -w /tmp && echo "__tmp__ok" || echo "__tmp__no"
if command -v python3 >/dev/null 2>&1; then echo "__python__$(python3 --version 2>&1 | head -1)"; fi
if command -v git >/dev/null 2>&1; then echo "__git__$(git --version 2>&1 | head -1)"; fi
if command -v node >/dev/null 2>&1; then echo "__node__$(node -v 2>&1 | head -1)"; fi
if command -v curl >/dev/null 2>&1; then echo "__curl__$(curl --version 2>&1 | head -1)"; echo "__net__$(curl -sS -m 5 -o /dev/null -w '%{http_code}' https://coomi.septemc.com/ 2>&1)"; else echo "__net__no-curl"; fi
"#;
    let result = match backend.command_with_environment(
        workspace,
        "/bin/sh",
        &["-c".into(), script.trim().into()],
        &BTreeMap::new(),
    ) {
        Ok(command) => {
            command
                .output_limited(Duration::from_secs(20), 64 * 1024)
                .await
        }
        Err(error) => Err(error),
    };
    let mut facts = GuestFacts {
        backend: match backend.kind() {
            RuntimeBackendKind::ProotLinux => "proot_linux".into(),
            RuntimeBackendKind::LegacyTermux => "legacy_termux".into(),
            RuntimeBackendKind::IshLinux => "ish_linux".into(),
            RuntimeBackendKind::Host => "host".into(),
        },
        ..GuestFacts::default()
    };
    match result {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let line = line.trim();
                if let Some(_) = line.strip_prefix("__sh__ok") {
                    facts.sh = true;
                } else if line == "__workspace__ok" {
                    facts.workspace = true;
                } else if line == "__tmp__ok" {
                    facts.tmp_writable = true;
                } else if let Some(value) = line.strip_prefix("__python__") {
                    facts.python = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__git__") {
                    facts.git = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__node__") {
                    facts.node = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__curl__") {
                    facts.curl = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__net__") {
                    let value = value.trim();
                    facts.network = if value.is_empty() {
                        None
                    } else {
                        Some(value.to_owned())
                    };
                }
            }
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    facts.error = Some(stderr.trim().chars().take(300).collect());
                }
            }
        }
        Err(error) => {
            facts.error = Some(format!("{error:#}").chars().take(300).collect());
        }
    }
    Ok(facts)
}

#[derive(Clone, Debug)]
pub struct RuntimeManager {
    /// Coomi 主目录（settings.json / mirrors 配置在这里）。
    home: PathBuf,
    root: PathBuf,
    state_path: PathBuf,
}

impl RuntimeManager {
    pub fn open(home: &Path) -> Result<Self> {
        let root = home.join("runtime-v2");
        fs::create_dir_all(root.join("versions"))?;
        fs::create_dir_all(root.join("downloads"))?;
        let manager = Self {
            home: home.to_path_buf(),
            state_path: root.join("state.json"),
            root,
        };
        if !manager.state_path.exists() {
            manager.save_state(&RuntimeState::default())?;
        }
        Ok(manager)
    }

    pub fn state(&self) -> Result<RuntimeState> {
        let bytes = fs::read(&self.state_path)?;
        let state: RuntimeState = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            state.version == RUNTIME_STATE_VERSION,
            "unsupported runtime state version"
        );
        Ok(state)
    }

    /// 扩展中心「环境检测」：在活跃运行时里实际执行 command -v / --version，
    /// 并探测 npm / pip / GitHub 镜像与网络；不再用 rootfs 文件是否存在来猜。
    pub async fn check_environment(&self) -> RuntimeEnvReport {
        let state = match self.state() {
            Ok(state) => state,
            Err(error) => {
                let mut report = RuntimeEnvReport {
                    home: self.home.display().to_string(),
                    error: Some(format!("读取运行时状态失败：{error:#}")),
                    ..RuntimeEnvReport::default()
                };
                report.status = "unknown".into();
                return report;
            }
        };
        let backend_label = match state.backend {
            RuntimeBackendKind::ProotLinux => "proot_linux",
            RuntimeBackendKind::LegacyTermux => "legacy_termux",
            RuntimeBackendKind::IshLinux => "ish_linux",
            RuntimeBackendKind::Host => "host",
        }
        .to_owned();
        let status_label = match state.status {
            RuntimeInstallStatus::NotInstalled => "not_installed",
            RuntimeInstallStatus::Downloading => "downloading",
            RuntimeInstallStatus::Initializing => "initializing",
            RuntimeInstallStatus::Ready => "ready",
            RuntimeInstallStatus::NeedsRepair => "needs_repair",
            RuntimeInstallStatus::UpdateAvailable => "update_available",
            RuntimeInstallStatus::RollingBack => "rolling_back",
            RuntimeInstallStatus::Removing => "removing",
        }
        .to_owned();
        let mut report = RuntimeEnvReport {
            backend: backend_label.clone(),
            status: status_label,
            active_version: state.active_version.clone(),
            rootfs: state
                .active_version
                .as_ref()
                .map(|version| self.root.join("versions").join(version).join("rootfs"))
                .map(|path| path.display().to_string()),
            home: self.home.display().to_string(),
            ..RuntimeEnvReport::default()
        };
        let mirrors = crate::mirrors::load_mirrors(&self.home);
        let mirror_env = mirrors.env();
        report.mirrors.insert(
            "npm".into(),
            mirror_env
                .get("npm_config_registry")
                .cloned()
                .unwrap_or_else(|| "https://registry.npmmirror.com/".into()),
        );
        report.mirrors.insert(
            "pip".into(),
            mirror_env
                .get("PIP_INDEX_URL")
                .cloned()
                .unwrap_or_else(|| "https://pypi.tuna.tsinghua.edu.cn/simple/".into()),
        );
        report.mirrors.insert(
            "github".into(),
            mirrors.github_prefix().unwrap_or_else(|| "官方直连".into()),
        );
        report.mirrors.insert("apt".into(), "清华 TUNA".into());

        const SCRIPT: &str = r#"set +e
echo "__SH__OK"
for c in node npm npx uv uvx git python3 curl; do
  p=$(command -v "$c" 2>/dev/null || true)
  v=""
  if [ -n "$p" ]; then v=$("$c" --version 2>&1 | head -n 1 || true); fi
  printf 'CMD|%s|%s|%s\n' "$c" "$p" "$v"
done
printf 'MIRROR|npm|%s\n' "$(npm config get registry 2>/dev/null || true)"
printf 'MIRROR|pip|%s\n' "$(pip3 config get global.index-url 2>/dev/null || true)"
printf 'MIRROR|home|%s\n' "$HOME"
if command -v curl >/dev/null 2>&1; then
  for u in https://registry.npmmirror.com/ https://pypi.tuna.tsinghua.edu.cn/simple/ https://codeload.github.com/ https://cdn.jsdelivr.net/gh/github/awesome-copilot@main/skills/acquire-codebase-knowledge/SKILL.md; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$u" 2>/dev/null || true)
    printf 'NET|%s|%s\n' "$u" "$code"
  done
fi
"#;

        let guest_command = match state.backend {
            RuntimeBackendKind::ProotLinux => {
                if state.status != RuntimeInstallStatus::Ready {
                    report.error = Some(format!(
                        "Proot 未就绪（{}），请先安装/修复运行时",
                        report.status
                    ));
                    None
                } else if let Some(version) = state.active_version.as_deref() {
                    let backend = ProotLinuxBackend {
                        runtime_root: self.root.clone(),
                        version: version.to_owned(),
                    };
                    Some(RuntimeBackend::command(
                        &backend,
                        &self.home,
                        "/bin/sh",
                        &["-lc".to_owned(), SCRIPT.to_owned()],
                    ))
                } else {
                    None
                }
            }
            RuntimeBackendKind::LegacyTermux => {
                let backend = LegacyTermuxBackend::from_coomi_home(&self.home);
                Some(RuntimeBackend::command(
                    &backend,
                    &self.home,
                    "/bin/sh",
                    &["-lc".to_owned(), SCRIPT.to_owned()],
                ))
            }
            RuntimeBackendKind::IshLinux => {
                // iOS：iSH 内核在本进程内，"guest" 与宿主是同一套文件系统。
                // 直接用 IshLinuxBackend 跑同一段探测脚本即可。
                let backend = IshLinuxBackend::new(self.root.clone());
                Some(RuntimeBackend::command(
                    &backend,
                    &self.home,
                    "/bin/sh",
                    &["-lc".to_owned(), SCRIPT.to_owned()],
                ))
            }
            RuntimeBackendKind::Host => None,
        };

        let mut guest_stdout = String::new();
        if let Some(guest_command) = guest_command {
            match guest_command {
                Ok(command) => {
                    match tokio::time::timeout(
                        Duration::from_secs(60),
                        command.into_tokio().output(),
                    )
                    .await
                    {
                        Ok(Ok(output)) => {
                            guest_stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            report.shell_ok = output.status.success()
                                && guest_stdout.contains("__SH__OK");
                            if !output.status.success() {
                                let stderr = String::from_utf8_lossy(&output.stderr);
                                report.error = Some(format!(
                                    "运行时命令执行失败：{}",
                                    stderr.trim()
                                ));
                            }
                        }
                        Ok(Err(error)) => {
                            report.error = Some(format!("运行环境检测命令失败：{error:#}"))
                        }
                        Err(_) => report.error = Some("环境检测超时（60s）".into()),
                    }
                }
                Err(error) => report.error = Some(format!("无法启动运行时 shell：{error:#}")),
            }
        } else if state.backend == RuntimeBackendKind::Host {
            report.shell_ok = true;
            report.commands = host_env_commands().await;
        }

        let mut guest_mirrors = BTreeMap::new();
        for line in guest_stdout.lines() {
            if let Some(rest) = line.strip_prefix("CMD|") {
                let mut parts = rest.splitn(3, '|');
                let name = parts.next().unwrap_or_default().trim();
                let path = parts.next().unwrap_or_default().trim();
                let version = parts.next().unwrap_or_default().trim();
                if name.is_empty() {
                    continue;
                }
                report.commands.push(EnvCommandProbe {
                    name: name.to_owned(),
                    found: !path.is_empty(),
                    path: (!path.is_empty()).then(|| path.to_owned()),
                    version: (!version.is_empty()).then(|| version.to_owned()),
                });
            } else if let Some(rest) = line.strip_prefix("MIRROR|") {
                let mut parts = rest.splitn(2, '|');
                let key = parts.next().unwrap_or_default().trim();
                let value = parts.next().unwrap_or_default().trim();
                if !key.is_empty() && !value.is_empty() {
                    guest_mirrors.insert(key.to_owned(), value.to_owned());
                }
            } else if let Some(rest) = line.strip_prefix("NET|") {
                let mut parts = rest.splitn(2, '|');
                let url = parts.next().unwrap_or_default().trim();
                let status = parts.next().unwrap_or_default().trim();
                if !url.is_empty() {
                    let ok = status
                        .parse::<u16>()
                        .map(|code| (200..400).contains(&code))
                        .unwrap_or(false);
                    report.network.push(EnvNetworkProbe {
                        url: url.to_owned(),
                        ok,
                        status: status.to_owned(),
                    });
                }
            }
        }
        for (key, value) in guest_mirrors {
            report.mirrors.insert(key, value);
        }
        if report.network.is_empty() {
            report.network = host_network_probes().await;
        }
        report.missing = report
            .commands
            .iter()
            .filter(|command| !command.found)
            .map(|command| command.name.clone())
            .collect();
        let has_node = report
            .commands
            .iter()
            .any(|command| command.name == "node" && command.found)
            && report
                .commands
                .iter()
                .any(|command| command.name == "npm" && command.found);
        let network_ok = report.network.iter().any(|probe| probe.ok);
        report.ok = report.error.is_none()
            && report.shell_ok
            && has_node
            && (network_ok || report.network.is_empty());
        report.fixable = matches!(
            state.backend,
            RuntimeBackendKind::ProotLinux | RuntimeBackendKind::LegacyTermux
        );
        report
    }

    pub fn download_progress(
        &self,
        name: &str,
        artifact: &RuntimeArtifact,
    ) -> RuntimeDownloadProgress {
        let target = self.root.join("downloads").join(name);
        let partial = target.with_extension("partial");
        let downloaded = if target.is_file() {
            artifact.size
        } else {
            fs::metadata(partial).map(|value| value.len()).unwrap_or(0)
        };
        let downloaded = downloaded.min(artifact.size);
        let status = if target.is_file() {
            "completed"
        } else if downloaded > 0 {
            "downloading"
        } else {
            "pending"
        };
        let percent = if artifact.size == 0 {
            0
        } else {
            ((downloaded.saturating_mul(100)) / artifact.size).min(100) as u8
        };
        RuntimeDownloadProgress {
            downloaded,
            total: artifact.size,
            percent,
            status: status.into(),
        }
    }

    pub fn begin_install(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        anyhow::ensure!(
            matches!(
                state.status,
                RuntimeInstallStatus::NotInstalled
                    | RuntimeInstallStatus::NeedsRepair
                    | RuntimeInstallStatus::UpdateAvailable
            ),
            "runtime installation is already in progress"
        );
        state.status = RuntimeInstallStatus::Downloading;
        state.error = None;
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn fail_install(&self, error: impl Into<String>) -> Result<RuntimeState> {
        let mut state = self.state()?;
        state.status = if state.active_version.is_some() {
            RuntimeInstallStatus::NeedsRepair
        } else {
            RuntimeInstallStatus::NotInstalled
        };
        state.error = Some(error.into());
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn backend(
        &self,
        legacy_prefix: PathBuf,
        legacy_home: PathBuf,
    ) -> Result<Box<dyn RuntimeBackend>> {
        let state = self.state()?;
        if state.backend == RuntimeBackendKind::ProotLinux
            && state.status == RuntimeInstallStatus::Ready
            && let Some(version) = state.active_version
        {
            // state.json 说 Ready 不代表 proot/rootfs 真的还在（升级中断、目录被清）。
            // 这里做一次轻量文件检查；不通过就落到 Termux 降级，而不是让 auto
            // 一直卡在一个起不来的 Proot 上。
            let version_root = self.root.join("versions").join(&version);
            if version_root.join("bin").join("proot").is_file()
                && version_root.join("rootfs").join("bin").join("sh").is_file()
            {
                return Ok(Box::new(ProotLinuxBackend {
                    runtime_root: self.root.clone(),
                    version,
                }));
            }
        }
        Ok(Box::new(LegacyTermuxBackend {
            prefix: legacy_prefix,
            home: legacy_home,
        }))
    }

    pub async fn download_artifact(
        &self,
        name: &str,
        artifact: &RuntimeArtifact,
    ) -> Result<PathBuf> {
        artifact.validate()?;
        anyhow::ensure!(
            name.chars()
                .all(|character| character.is_ascii_alphanumeric()
                    || matches!(character, '-' | '_' | '.')),
            "invalid runtime artifact name"
        );
        let target = self.root.join("downloads").join(name);
        if target.is_file() {
            if verify_artifact(&target, artifact).is_ok() {
                return Ok(target);
            }
            fs::remove_file(&target)?;
        }
        let partial = target.with_extension("partial");
        let state_path = target.with_extension("download.json");
        let mut offset = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
        let old_state = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DownloadState>(&bytes).ok())
            .filter(|state| state.url == artifact.url && state.expected_sha256 == artifact.sha256);
        if old_state.is_none() && partial.exists() {
            fs::remove_file(&partial)?;
            offset = 0;
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .build()?;
        // GitHub 下载走 gh-proxy 加速；失败回退直链。
        let accelerated_url = if artifact.url.starts_with("https://github.com/") {
            format!("https://gh-proxy.com/{}", artifact.url)
        } else {
            artifact.url.clone()
        };
        let mut request = client.get(&accelerated_url);
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
            if let Some(etag) = old_state.as_ref().and_then(|state| state.etag.as_deref()) {
                request = request.header(IF_RANGE, etag);
            }
        }
        let response = match request.send().await {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(_) | Err(_) => {
                // 加速源失败：回退直链
                let mut fallback = client.get(&artifact.url);
                if offset > 0 {
                    fallback = fallback.header(RANGE, format!("bytes={offset}-"));
                    if let Some(etag) = old_state.as_ref().and_then(|state| state.etag.as_deref()) {
                        fallback = fallback.header(IF_RANGE, etag);
                    }
                }
                fallback.send().await?
            }
        };
        anyhow::ensure!(
            response.status().is_success(),
            "runtime download failed with HTTP {}",
            response.status()
        );
        let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if offset > 0 && !resumed {
            offset = 0;
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&partial)
            .await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            offset = offset.saturating_add(chunk.len() as u64);
            save_json(
                &state_path,
                &DownloadState {
                    version: 1,
                    url: artifact.url.clone(),
                    etag: etag.clone(),
                    downloaded: offset,
                    expected_sha256: artifact.sha256.clone(),
                },
            )?;
        }
        file.flush().await?;
        drop(file);
        anyhow::ensure!(offset == artifact.size, "runtime artifact size mismatch");
        anyhow::ensure!(
            sha256_file(&partial)? == artifact.sha256,
            "runtime artifact checksum mismatch"
        );
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&partial, &target)?;
        if state_path.exists() {
            fs::remove_file(state_path)?;
        }
        Ok(target)
    }

    pub fn install(
        &self,
        manifest: &RuntimeManifest,
        host_file: &Path,
        rootfs_tar: &Path,
    ) -> Result<RuntimeState> {
        manifest.validate()?;
        verify_artifact(host_file, &manifest.host)?;
        // 没有 rootfs 就不装运行环境：装机到一半是最糟的状态，宁可提前拒绝。
        let rootfs_artifact = manifest
            .rootfs
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("runtime manifest has no rootfs for this build"))?;
        verify_artifact(rootfs_tar, rootfs_artifact)?;
        let mut state = self.state()?;
        state.status = RuntimeInstallStatus::Initializing;
        state.error = None;
        self.save_state(&state)?;
        let staging = self
            .root
            .join("versions")
            .join(format!("{}.staging", manifest.runtime_version));
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir_all(&staging)?;
        unpack_archive(open_archive(host_file)?, &staging)?;
        let host = staging.join("bin").join("proot");
        anyhow::ensure!(host.is_file(), "PRoot host archive has no bin/proot");
        set_executable(&host)?;
        let rootfs = staging.join("rootfs");
        fs::create_dir_all(&rootfs)?;
        unpack_archive(open_archive(rootfs_tar)?, &rootfs)?;
        anyhow::ensure!(rootfs.join("bin/sh").is_file(), "rootfs has no /bin/sh");
        normalize_rootfs_permissions(&rootfs);
        let destination = self.root.join("versions").join(&manifest.runtime_version);
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(&staging, &destination)?;
        // 清理 Termux 时代遗留的登录脚本（可能引用 /root/.cargo/env 等失效路径），
        // 避免 guest 登录 shell（-lc）加载它们导致环境问题。
        let guest_home = self.root.join("home");
        for name in [".profile", ".bashrc", ".bash_profile", ".zshrc"] {
            let _ = fs::remove_file(guest_home.join(name));
        }
        self.ensure_guest_dns()?;
        // 只保留单一运行环境：升级即替换，不保留旧版本（不回滚）。
        // 旧版本（如历史 Debian）目录直接删除，磁盘与状态都只留当前版本。
        if let Some(previous) = state.active_version.take() {
            let prev_dir = self.root.join("versions").join(&previous);
            if prev_dir.is_dir() {
                let _ = fs::remove_dir_all(&prev_dir);
            }
        }
        state.previous_version = None;
        state.active_version = Some(manifest.runtime_version.clone());
        state.backend = RuntimeBackendKind::ProotLinux;
        state.status = RuntimeInstallStatus::Ready;
        state.installed_at_ms = Some(now_ms());
        self.save_state(&state)?;
        Ok(state)
    }

    /// 修复 guest DNS：debootstrap 产物里的 /etc/resolv.conf 可能停留在构建机
    /// （如 systemd-resolved 的 127.0.0.53），guest 内无监听者导致解析全挂。
    /// 统一重写为公共 DNS。对当前激活版本幂等。
    pub fn ensure_guest_dns(&self) -> Result<()> {        let state = self.state()?;
        let Some(version) = state.active_version else {
            return Ok(());
        };
        let rootfs = self.root.join("versions").join(&version).join("rootfs");
        fs::create_dir_all(rootfs.join("etc"))?;
        fs::write(
            rootfs.join("etc").join("resolv.conf"),
            "# Coomi guest DNS (rewritten at install time)\n\
             nameserver 223.5.5.5\n\
             nameserver 119.29.29.29\n\
             nameserver 8.8.8.8\n",
        )?;
        Ok(())
    }

    pub fn guest_env_status(&self) -> GuestEnvStatus {
        if self.root.join(GUEST_ENV_MARKER).is_file() {
            let mut status = GuestEnvStatus::new("ready", None);
            status.phase = "done".into();
            return status;
        }
        let mut status = fs::read(self.root.join(GUEST_ENV_STATUS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<GuestEnvStatus>(&bytes).ok())
            .unwrap_or_else(|| GuestEnvStatus::new("pending", None));
        // 旧版本 marker 已过期（当前 v2 不存在）时，旧 status 的 ready 不能阻止补装。
        if status.state == "ready" && !self.root.join(GUEST_ENV_MARKER).is_file() {
            status.state = "pending".into();
            status.phase = "prepare".into();
        }
        // 进程被杀/系统回收时状态会永远停在 running；30s 没有心跳就判中断，
        // UI 才能给出「重新补全」而不是一直转圈。
        if status.state == "running"
            && now_ms().saturating_sub(status.updated_at_ms) > 30_000
        {
            status.state = "error".into();
            status.phase = "error".into();
            status.error = Some("依赖补全过程已中断，请重新补全".into());
        }
        status
    }

    /// 首次启动后台补装 guest 里缺的东西：npm（Shell MCP）、pip/venv、openssh-client。
    /// 已成功（marker 在）就不再跑；失败 6 小时内不重试，避免离线时每次启动都卡在 apt update。
    pub fn spawn_guest_package_repair(&self) {
        let status = self.guest_env_status();
        if status.state == "ready" {
            return;
        }
        if status.state == "error"
            && now_ms().saturating_sub(status.updated_at_ms) < 6 * 60 * 60 * 1000
        {
            return;
        }
        if GUEST_ENV_REPAIRING.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = manager.run_guest_package_repair() {
                eprintln!("[runtime] guest package repair failed: {error:#}");
            }
            GUEST_ENV_REPAIRING.store(false, Ordering::SeqCst);
        });
    }

    fn write_guest_env(&self, status: &GuestEnvStatus) {
        let _ = save_json(&self.root.join(GUEST_ENV_STATUS_FILE), status);
    }

    /// 把 apt / npm / pip 切到国内镜像，并返回给 UI 展示的镜像摘要。
    /// npm / pip 遵循 settings.json → mirrors 的生效项；apt 固定走清华 TUNA。
    fn configure_guest_mirrors(&self, rootfs: &Path, home: &Path) -> Result<String> {
        let mirrors = crate::mirrors::load_mirrors(&self.home);
        let npm_entry = mirrors.effective(crate::mirrors::MirrorKind::Npm);
        let pip_entry = mirrors.effective(crate::mirrors::MirrorKind::Pip);
        let npm_url = npm_entry
            .map(|entry| entry.url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| "https://registry.npmmirror.com/".to_owned());
        let pip_url = pip_entry
            .map(|entry| entry.url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| "https://pypi.tuna.tsinghua.edu.cn/simple/".to_owned());
        let npm_label = npm_entry
            .map(|entry| entry.label.clone())
            .unwrap_or_else(|| "npmmirror".to_owned());
        let pip_label = pip_entry
            .map(|entry| entry.label.clone())
            .unwrap_or_else(|| "清华 TUNA".to_owned());

        // apt：debian 12 (bookworm)。用 http 避免 rootfs 缺 ca-certificates 时
        // https 直接失败；apt 仍然按签名校验包。
        let apt = "http://mirrors.tuna.tsinghua.edu.cn";
        let apt_dir = rootfs.join("etc").join("apt");
        fs::create_dir_all(&apt_dir)?;
        fs::write(
            apt_dir.join("sources.list"),
            format!(
                "deb {apt}/debian bookworm main contrib non-free non-free-firmware\n\
                 deb {apt}/debian bookworm-updates main contrib non-free non-free-firmware\n\
                 deb {apt}/debian-security bookworm-security main contrib non-free non-free-firmware\n"
            ),
        )?;
        // bookworm 默认可能用 debian.sources（deb822），不清掉会和 sources.list 重复。
        let _ = fs::remove_file(apt_dir.join("sources.list.d").join("debian.sources"));

        // npm / pip：写到 guest 用户的 HOME，后续 npx / pip 安装 MCP 直接走镜像。
        fs::create_dir_all(home)?;
        fs::write(home.join(".npmrc"), format!("registry={npm_url}\n"))?;
        let pip_dir = home.join(".config").join("pip");
        fs::create_dir_all(&pip_dir)?;
        let pip_host = pip_url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or_default();
        fs::write(
            pip_dir.join("pip.conf"),
            format!(
                "[global]\nindex-url = {pip_url}\ntrusted-host = {pip_host}\n"
            ),
        )?;
        Ok(format!(
            "apt 清华 TUNA · npm {npm_label} · pip {pip_label}"
        ))
    }

    fn run_guest_package_repair(&self) -> Result<()> {
        let state = self.state()?;
        if state.backend != RuntimeBackendKind::ProotLinux {
            return Ok(());
        }
        let Some(version) = state.active_version.clone() else {
            return Ok(());
        };
        if self.root.join(GUEST_ENV_MARKER).is_file() {
            return Ok(());
        }
        // apt 依赖 DNS：先把 debootstrap 里可能残留的 127.0.0.53 换掉。
        let _ = self.ensure_guest_dns();
        let rootfs = self.root.join("versions").join(&version).join("rootfs");
        let home = self.root.join("home");
        fs::create_dir_all(&home)?;
        let mirror = match self.configure_guest_mirrors(&rootfs, &home) {
            Ok(mirror) => mirror,
            Err(error) => {
                let mut status =
                    GuestEnvStatus::new("error", Some(format!("配置镜像失败：{error:#}")));
                status.phase = "error".into();
                self.write_guest_env(&status);
                return Err(error);
            }
        };
        let started = Instant::now();
        let mut initial = GuestEnvStatus::new("running", None);
        initial.phase = "prepare".into();
        initial.mirror = mirror.clone();
        self.write_guest_env(&initial);

        let backend = ProotLinuxBackend {
            runtime_root: self.root.clone(),
            version,
        };
        let script = r#"set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/home/coomi
export PATH=/usr/local/bin:/usr/bin:/bin:/home/coomi/.local/bin:$PATH
echo "Coomi: installing Node.js/npm, Python/pip, git, curl, ssh and uv..."
echo __coomi_phase__ apt-update
apt-get -o Acquire::Retries=2 update
echo __coomi_phase__ apt-install
apt-get -o Acquire::Retries=2 install -y --no-install-recommends nodejs npm git curl ca-certificates openssh-client python3-pip python3-venv
echo __coomi_phase__ uv-install
if ! command -v uv >/dev/null 2>&1; then
  echo "Coomi: installing uv (uvx MCP runtime)..."
  pip3 install --break-system-packages --no-cache-dir uv \
    || pip3 install --no-cache-dir uv \
    || curl -LsSf https://astral.sh/uv/install.sh | sh \
    || echo "Coomi: uv install failed; uvx-based MCP servers will stay unavailable"
fi
echo __coomi_phase__ finalize
mkdir -p /home/coomi/.ssh /home/coomi/.local/bin
chmod 700 /home/coomi/.ssh
command -v node || true
command -v npm || true
command -v npx || true
command -v uv || true
command -v uvx || true
echo __coomi_phase__ done
"#;
        let command = RuntimeBackend::command(
            &backend,
            &home,
            "/bin/sh",
            &["-lc".to_string(), script.to_string()],
        )?;
        let logs = self.root.join("logs");
        fs::create_dir_all(&logs)?;
        let log_path = logs.join("guest-env.log");
        let log = File::create(&log_path)?;
        let mut child = std::process::Command::new(&command.program)
            .args(&command.arguments)
            .env_clear()
            .envs(&command.environment)
            .current_dir(&command.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()
            .context("failed to start guest package repair")?;
        // 子进程直接写日志文件；这里另开读句柄，逐次读新增字节做进度/日志尾部。
        let mut reader = File::open(&log_path).ok();
        let mut read_offset = 0u64;
        let mut tail = String::new();
        let mut downloaded = 0u64;
        let mut phase = "prepare".to_string();
        let mut last_sample = Instant::now();
        let mut last_bytes = 0u64;
        let deadline = Instant::now() + Duration::from_secs(900);
        let exit = loop {
            drain_guest_log(
                &mut reader,
                &mut read_offset,
                &mut tail,
                &mut downloaded,
                &mut phase,
            );
            if let Some(exit) = child.try_wait()? {
                break exit;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let message = "guest package install timed out after 900s".to_string();
                let mut status = GuestEnvStatus::new("error", Some(message.clone()));
                status.phase = "error".into();
                status.log_tail = tail;
                status.downloaded_bytes = downloaded;
                status.elapsed_ms = started.elapsed().as_millis() as u64;
                status.mirror = mirror;
                self.write_guest_env(&status);
                anyhow::bail!(message);
            }
            let now = Instant::now();
            let elapsed_delta = now.duration_since(last_sample).as_millis() as u64;
            let byte_delta = downloaded.saturating_sub(last_bytes);
            let speed = if elapsed_delta > 0 {
                byte_delta.saturating_mul(1000) / elapsed_delta
            } else {
                0
            };
            last_sample = now;
            last_bytes = downloaded;
            let mut status = GuestEnvStatus::new("running", None);
            status.phase = phase.clone();
            status.log_tail = tail.clone();
            status.downloaded_bytes = downloaded;
            status.speed_bps = speed;
            status.elapsed_ms = started.elapsed().as_millis() as u64;
            status.mirror = mirror.clone();
            self.write_guest_env(&status);
            std::thread::sleep(Duration::from_millis(300));
        };
        // 收尾再读一次，避免最后几行（含错误信息）没进 tail。
        drain_guest_log(
            &mut reader,
            &mut read_offset,
            &mut tail,
            &mut downloaded,
            &mut phase,
        );
        if !exit.success() {
            let message = format!("apt install failed ({exit}); see {}", log_path.display());
            let mut status = GuestEnvStatus::new("error", Some(message.clone()));
            status.phase = "error".into();
            status.log_tail = tail;
            status.downloaded_bytes = downloaded;
            status.elapsed_ms = started.elapsed().as_millis() as u64;
            status.mirror = mirror;
            self.write_guest_env(&status);
            anyhow::bail!(message);
        }
        fs::write(self.root.join(GUEST_ENV_MARKER), b"ok")?;
        let mut status = GuestEnvStatus::new("ready", None);
        status.phase = "done".into();
        status.log_tail = tail;
        status.downloaded_bytes = downloaded;
        status.elapsed_ms = started.elapsed().as_millis() as u64;
        status.mirror = mirror;
        self.write_guest_env(&status);
        Ok(())
    }

    pub fn migrate_legacy_home(&self, legacy_home: &Path) -> Result<u64> {
        let destination = self.root.join("home");
        fs::create_dir_all(&destination)?;
        let copied = copy_user_tree(legacy_home, &destination)?;
        // Termux 时代的登录脚本（.profile/.bashrc 等）在 guest 里会引用 /root/.cargo/env 等
        // 不存在的路径，污染登录 shell（-lc）。迁移后统一清掉，让 guest 使用干净默认。
        for name in [".profile", ".bashrc", ".bash_profile", ".zshrc"] {
            let _ = fs::remove_file(destination.join(name));
        }
        Ok(copied)
    }

    pub fn rollback(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        let previous = state
            .previous_version
            .clone()
            .context("no runtime version is available for rollback")?;
        anyhow::ensure!(
            self.root.join("versions").join(&previous).is_dir(),
            "rollback runtime is missing"
        );
        state.status = RuntimeInstallStatus::RollingBack;
        self.save_state(&state)?;
        let active = state.active_version.replace(previous);
        state.previous_version = active;
        state.status = RuntimeInstallStatus::Ready;
        state.error = None;
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn remove(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        state.status = RuntimeInstallStatus::Removing;
        self.save_state(&state)?;
        let versions = self.root.join("versions");
        if versions.exists() {
            fs::remove_dir_all(&versions)?;
        }
        fs::create_dir_all(versions)?;
        state = RuntimeState::default();
        self.save_state(&state)?;
        Ok(state)
    }

    fn save_state(&self, state: &RuntimeState) -> Result<()> {
        save_json(&self.state_path, state)
    }
}

/// Android 10+ 会拒绝应用读 /proc/stat、/proc/uptime、/proc/loadavg。
/// 读得到就返回 None（用真的）；读不到才生成一份单调递增的占位文件，
/// 由 proot 文件级 bind 覆盖 guest 里的对应路径 —— 让 psutil 之类的库不至于直接抛
/// PermissionError。里面的 CPU 数值是合成的，只能当“有数据”用，别当真实负载。
fn write_proc_shim(tmp: &Path) -> Result<PathBuf> {
    let host_ok = std::fs::read_to_string("/proc/stat").is_ok()
        && std::fs::read_to_string("/proc/uptime").is_ok();
    anyhow::ensure!(!host_ok, "host /proc is readable; no shim needed");
    let dir = tmp.join("proc-shim");
    fs::create_dir_all(&dir)?;
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let secs = START.get_or_init(Instant::now).elapsed().as_secs().max(1);
    let cpus = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    let ticks = secs.saturating_mul(100);
    let mut stat = String::new();
    stat.push_str(&format!(
        "cpu 0 0 0 {} 0 0 0 0 0 0\n",
        ticks.saturating_mul(cpus as u64)
    ));
    for index in 0..cpus {
        stat.push_str(&format!("cpu{index} 0 0 0 {ticks} 0 0 0 0 0 0\n"));
    }
    stat.push_str("intr 0\nctxt 0\nbtime 0\nprocesses 0\nprocs_running 1\nprocs_blocked 0\n");
    fs::write(dir.join("stat"), stat)?;
    fs::write(dir.join("uptime"), format!("{secs}.00 {secs}.00\n"))?;
    fs::write(
        dir.join("loadavg"),
        format!("0.00 0.00 0.00 1/{cpus} {}\n", std::process::id()),
    )?;
    Ok(dir)
}

fn minimal_environment(home: &Path, tmp: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        (
            "PATH".into(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        ),
        ("TMPDIR".into(), tmp.to_string_lossy().into_owned()),
        ("LANG".into(), "C.UTF-8".into()),
        (
            "SSL_CERT_FILE".into(),
            "/etc/ssl/certs/ca-certificates.crt".into(),
        ),
    ])
}

fn canonical_existing(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("runtime bind path does not exist: {}", path.display()))
}

fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<()> {
    anyhow::ensure!(
        fs::metadata(path)?.len() == artifact.size,
        "runtime artifact size mismatch"
    );
    anyhow::ensure!(
        sha256_file(path)? == artifact.sha256,
        "runtime artifact checksum mismatch"
    );
    Ok(())
}

fn open_archive(path: &Path) -> Result<Box<dyn Read>> {
    let file = File::open(path)?;
    match path.extension().and_then(|value| value.to_str()) {
        Some("gz") => Ok(Box::new(GzDecoder::new(file))),
        // AnLinux 等预构建 rootfs 常为 tar.xz：解压后交给 tar 处理。
        Some("xz") => Ok(Box::new(xz2::read::XzDecoder::new(file))),
        _ => Ok(Box::new(file)),
    }
}

/// rootfs 解压后权限归一化：修复 tar 里可能过严/异常的权限位。
/// - rootfs 根目录必须可读可执行
/// - /tmp 必须 1777（sticky），否则 apt/gcc 等临时文件创建报 Permission denied
/// - /root 0755，避免 0700 在部分场景下影响工具探测
/// - 遍历根目录：只读目录兜底为 0755（防止 rootfs 不可读）
#[cfg(unix)]
fn normalize_rootfs_permissions(rootfs: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let set_mode = |path: &Path, mode: u32| {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    };
    set_mode(rootfs, 0o755);
    set_mode(&rootfs.join("root"), 0o755);
    set_mode(&rootfs.join("tmp"), 0o1777);
    set_mode(&rootfs.join("var/tmp"), 0o1777);
    set_mode(&rootfs.join("run"), 0o755);
    // 遍历根目录，只读目录兜底为 0755。
    if let Ok(entries) = fs::read_dir(rootfs) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = fs::metadata(&path) {
                if meta.is_dir() && meta.permissions().readonly() {
                    set_mode(&path, 0o755);
                }
            }
        }
    }
}

#[cfg(not(unix))]
fn normalize_rootfs_permissions(_rootfs: &Path) {}

/// Android's app-private filesystem rejects hard-link creation. Expand tar
/// hard-link entries into ordinary file copies while retaining tar's normal
/// handling for directories, files and symlinks.
fn unpack_archive(reader: Box<dyn Read>, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut hard_links = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_hard_link() {
            let path = archive_path(entry.path()?)?;
            let link = archive_path(entry.link_name()?.context("hard link has no target")?)?;
            hard_links.push((path, link));
            continue;
        }
        anyhow::ensure!(
            entry.unpack_in(destination)?,
            "archive path escaped destination"
        );
    }
    for (path, link) in hard_links {
        let target = destination.join(&link);
        let output = destination.join(&path);
        anyhow::ensure!(
            target.is_file(),
            "hard link target is missing: {}",
            link.display()
        );
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&target, &output).with_context(|| {
            format!(
                "failed to expand hard link {} -> {}",
                path.display(),
                link.display()
            )
        })?;
        if let Ok(permissions) = fs::metadata(&target).map(|metadata| metadata.permissions()) {
            let _ = fs::set_permissions(&output, permissions);
        }
    }
    Ok(())
}

fn archive_path(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => clean.push(value),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                anyhow::bail!("archive path escapes destination")
            }
        }
    }
    anyhow::ensure!(!clean.as_os_str().is_empty(), "archive path is empty");
    Ok(clean)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("state path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn copy_user_tree(source: &Path, destination: &Path) -> Result<u64> {
    if !source.is_dir() {
        return Ok(0);
    }
    let mut copied = 0u64;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if matches!(
            name.to_str(),
            Some("usr" | ".cache" | ".profile" | ".bashrc" | ".bash_profile" | ".zshrc")
        ) {
            continue;
        }
        let target = destination.join(&name);
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&target)?;
            copied = copied.saturating_add(copy_user_tree(&entry.path(), &target)?);
        } else if entry.file_type()?.is_file() && !target.exists() {
            copied = copied.saturating_add(fs::copy(entry.path(), target)?);
        }
    }
    Ok(copied)
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

/// 读取日志文件的新增字节，更新进度与日志尾部。
/// 不阻塞子进程：子进程自己写文件，这里只做一次 seek + read。
fn drain_guest_log(
    reader: &mut Option<File>,
    offset: &mut u64,
    tail: &mut String,
    downloaded: &mut u64,
    phase: &mut String,
) {
    let Some(file) = reader.as_mut() else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let length = metadata.len();
    if length <= *offset {
        return;
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut buffer = Vec::new();
    let mut limited = std::io::Read::by_ref(file).take(length - *offset);
    if limited.read_to_end(&mut buffer).is_err() {
        return;
    }
    *offset = length;
    let chunk = String::from_utf8_lossy(&buffer);
    for line in chunk.lines() {
        let line = line.trim_end_matches('\r');
        update_guest_phase(phase, line);
        if line.starts_with("Get:")
            && let Some(size) = parse_apt_size(line)
        {
            *downloaded = downloaded.saturating_add(size);
        }
    }
    append_log_tail(tail, &chunk);
}

fn update_guest_phase(phase: &mut String, line: &str) {
    let trimmed = line.trim();
    if let Some(marker) = trimmed.strip_prefix("__coomi_phase__") {
        let next = marker.trim();
        if !next.is_empty() {
            *phase = next.to_owned();
        }
        return;
    }
    if trimmed.starts_with("Get:") {
        *phase = "downloading".into();
    } else if trimmed.starts_with("Unpacking")
        || trimmed.starts_with("Setting up")
        || trimmed.starts_with("Preparing to unpack")
    {
        *phase = "installing".into();
    } else if trimmed.starts_with("Fetched") {
        *phase = "installing".into();
    }
}

/// 从 apt 的 `Get:1 ... [2,728 kB]` 行解析本次下载字节数。
fn parse_apt_size(line: &str) -> Option<u64> {
    let start = line.rfind('[')?;
    let end = line[start..].find(']')? + start;
    let raw = &line[start + 1..end];
    let mut parts = raw.split_whitespace();
    let number = parts.next()?.replace(',', "");
    let value: f64 = number.parse().ok()?;
    let unit = parts.next().unwrap_or("B").to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "b" => 1.0,
        "kb" | "k" => 1024.0,
        "mb" | "m" => 1024.0 * 1024.0,
        "gb" | "g" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * multiplier) as u64)
}

fn append_log_tail(tail: &mut String, chunk: &str) {
    const MAX_TAIL_CHARS: usize = 16 * 1024;
    tail.push_str(chunk);
    if tail.len() > MAX_TAIL_CHARS {
        let keep = tail
            .chars()
            .rev()
            .take(MAX_TAIL_CHARS)
            .collect::<Vec<_>>();
        *tail = keep.into_iter().rev().collect();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}


fn host_which(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        let base = directory.join(command);
        if base.extension().is_some() {
            if base.is_file() {
                return Some(base);
            }
            continue;
        }
        if cfg!(windows) {
            let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
            for extension in pathext.split(';').map(str::trim).filter(|value| !value.is_empty()) {
                let candidate = PathBuf::from(format!("{}{}", base.display(), extension));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        if base.is_file() {
            return Some(base);
        }
    }
    None
}

async fn host_env_commands() -> Vec<EnvCommandProbe> {
    let names = ["node", "npm", "npx", "uv", "uvx", "git", "python3", "curl"];
    let mut probes = Vec::new();
    for name in names {
        let Some(path) = host_which(name) else {
            probes.push(EnvCommandProbe {
                name: name.to_owned(),
                found: false,
                path: None,
                version: None,
            });
            continue;
        };
        let output = tokio::time::timeout(
            Duration::from_secs(6),
            Command::new(&path).arg("--version").output(),
        )
        .await;
        let version = match output {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let line = stdout
                    .lines()
                    .chain(stderr.lines())
                    .map(str::trim)
                    .find(|line| !line.is_empty());
                line.map(str::to_owned)
            }
            _ => None,
        };
        probes.push(EnvCommandProbe {
            name: name.to_owned(),
            found: true,
            path: Some(path.display().to_string()),
            version,
        });
    }
    probes
}

async fn host_network_probes() -> Vec<EnvNetworkProbe> {
    let urls = [
        "https://registry.npmmirror.com/",
        "https://pypi.tuna.tsinghua.edu.cn/simple/",
        "https://codeload.github.com/",
        "https://cdn.jsdelivr.net/gh/github/awesome-copilot@main/skills/acquire-codebase-knowledge/SKILL.md",
    ];
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("coomi")
        .build()
    else {
        return Vec::new();
    };
    let probes = urls.into_iter().map(|url| {
        let client = client.clone();
        async move {
            match client.get(url).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    EnvNetworkProbe {
                        url: url.to_owned(),
                        ok: (200..400).contains(&status),
                        status: status.to_string(),
                    }
                }
                Err(error) => EnvNetworkProbe {
                    url: url.to_owned(),
                    ok: false,
                    status: format!("error: {error}"),
                },
            }
        }
    });
    futures_util::future::join_all(probes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termux_resolves_linux_shell_names_inside_prefix() {
        let prefix = Path::new("/data/data/com.coomi.android/files/usr");
        assert_eq!(
            termux_program_path(prefix, "/bin/sh"),
            prefix.join("bin/sh")
        );
        assert_eq!(
            termux_program_path(prefix, "/usr/bin/env"),
            prefix.join("bin/env")
        );
        assert_eq!(termux_program_path(prefix, "bash"), prefix.join("bin/bash"));
    }

    #[test]
    fn termux_layout_is_derived_from_android_coomi_home() {
        let backend = LegacyTermuxBackend::from_coomi_home(Path::new(
            "/data/data/com.monai.coomiplus/files/home/.coomi",
        ));
        assert_eq!(
            backend.prefix,
            PathBuf::from("/data/data/com.monai.coomiplus/files/usr")
        );
        assert_eq!(
            backend.home,
            PathBuf::from("/data/data/com.monai.coomiplus/files/home")
        );
    }

    #[test]
    fn termux_command_uses_android_native_environment() {
        let root = tempfile::tempdir().expect("temporary Termux root");
        let prefix = root.path().join("files/usr");
        let home = root.path().join("files/home");
        fs::create_dir_all(prefix.join("bin")).expect("create bin");
        fs::create_dir_all(prefix.join("lib")).expect("create lib");
        fs::create_dir_all(&home).expect("create home");
        fs::write(prefix.join("bin/sh"), b"shell").expect("create shell");
        let backend = LegacyTermuxBackend {
            prefix,
            home: home.clone(),
        };
        let command = backend
            .command(&home, "/bin/sh", &["-lc".into(), "pwd".into()])
            .expect("Termux command");
        assert_eq!(command.program, backend.prefix.join("bin/sh"));
        assert_eq!(
            command
                .environment
                .get("LD_LIBRARY_PATH")
                .map(String::as_str),
            Some(backend.prefix.join("lib").to_string_lossy().as_ref())
        );
        assert_eq!(
            command
                .environment
                .get("COOMI_RUNTIME_BACKEND")
                .map(String::as_str),
            Some("termux")
        );
    }

    #[tokio::test]
    async fn bounded_runtime_reader_rejects_excess_output() {
        let (mut writer, reader) = tokio::io::duplex(32);
        tokio::spawn(async move {
            writer.write_all(b"12345").await.expect("write output");
        });
        let error = read_limited(reader, 4)
            .await
            .expect_err("output over the limit must fail");
        assert!(error.to_string().contains("exceeded 4 bytes"));
    }

    #[test]
    fn validates_pinned_manifest_and_rejects_unverified_downloads() {
        let artifact = RuntimeArtifact {
            url: "https://example.test/runtime.tar".into(),
            sha256: "a".repeat(64),
            size: 1,
        };
        let manifest = RuntimeManifest {
            version: RUNTIME_STATE_VERSION,
            runtime_version: "debian-13.1-1".into(),
            architecture: "arm64-v8a".into(),
            proot_commit: "b".repeat(40),
            proot_license: "GPL-2.0-or-later".into(),
            host: artifact.clone(),
            rootfs: Some(artifact),
            environment: BTreeMap::new(),
        };
        manifest.validate().expect("valid manifest");
        let mut invalid = manifest;
        invalid.rootfs.as_mut().expect("rootfs").sha256 = "not-a-checksum".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn migrates_home_without_usr_or_existing_files() {
        let home = tempfile::tempdir().expect("temporary home");
        let legacy = home.path().join("legacy");
        fs::create_dir_all(legacy.join("usr/bin")).expect("create legacy usr");
        fs::create_dir_all(legacy.join("project")).expect("create project");
        fs::write(legacy.join("usr/bin/apt"), "old").expect("write apt");
        fs::write(legacy.join("project/main.py"), "print(1)").expect("write project");
        let manager = RuntimeManager::open(home.path()).expect("open runtime");
        manager.migrate_legacy_home(&legacy).expect("migrate");
        assert!(
            home.path()
                .join("runtime-v2/home/project/main.py")
                .is_file()
        );
        assert!(!home.path().join("runtime-v2/home/usr").exists());
    }

    #[test]
    fn persists_install_progress_and_recoverable_failure() {
        let home = tempfile::tempdir().expect("temporary home");
        let manager = RuntimeManager::open(home.path()).expect("open runtime");
        let downloading = manager.begin_install().expect("begin installation");
        assert_eq!(downloading.status, RuntimeInstallStatus::Downloading);
        assert!(manager.begin_install().is_err());

        let failed = manager
            .fail_install("network unavailable")
            .expect("record failure");
        assert_eq!(failed.status, RuntimeInstallStatus::NotInstalled);
        assert_eq!(failed.error.as_deref(), Some("network unavailable"));
    }

    #[test]
    fn proot_command_exposes_only_explicit_mounts() {
        let home = tempfile::tempdir().expect("temporary home");
        let workspace = home.path().join("workspace");
        let version = home.path().join("versions/v1");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(version.join("bin")).expect("create bin");
        fs::create_dir_all(version.join("rootfs/bin")).expect("create rootfs");
        fs::create_dir_all(home.path().join("home")).expect("create home");
        fs::create_dir_all(home.path().join("tmp")).expect("create tmp");
        fs::write(version.join("bin/proot"), "binary").expect("write proot");
        fs::write(version.join("rootfs/bin/sh"), "shell").expect("write shell");
        let backend = ProotLinuxBackend {
            runtime_root: home.path().to_owned(),
            version: "v1".into(),
        };
        let command = backend
            .command(&workspace, "/bin/sh", &["-lc".into(), "true".into()])
            .expect("build command");
        let joined = command.arguments.join(" ");
        assert!(joined.contains(":/workspace"));
        assert!(joined.contains(":/home/coomi"));
        assert!(joined.contains(":/opt/coomi-dev"));
        assert!(joined.contains(":/usr/local/bin/proot"));
        assert!(
            joined.contains("PATH=/opt/coomi-dev/current/bin:/opt/coomi-dev/bin:/usr/local/sbin")
        );
        assert!(command.environment.contains_key("PROOT_TMP_DIR"));
        assert!(!joined.contains("/storage/emulated"));
    }

    #[test]
    fn parses_apt_get_sizes() {
        assert_eq!(
            parse_apt_size("Get:1 http://mirror/debian bookworm/main arm64 pkg [2,728 kB]"),
            Some(2_728 * 1024)
        );
        assert_eq!(
            parse_apt_size("Get:2 http://mirror/debian bookworm/main arm64 pkg [1.5 MB]"),
            Some(1_572_864)
        );
        assert_eq!(parse_apt_size("Reading package lists..."), None);
    }

    #[test]
    fn tracks_guest_install_phase_and_download_bytes() {
        let mut phase = String::new();
        update_guest_phase(&mut phase, "__coomi_phase__ apt-install");
        assert_eq!(phase, "apt-install");
        update_guest_phase(&mut phase, "Get:1 http://mirror/debian pkg [1,024 kB]");
        assert_eq!(phase, "downloading");
        update_guest_phase(&mut phase, "Unpacking pkg (1.0) ...");
        assert_eq!(phase, "installing");

        let mut tail = String::new();
        append_log_tail(&mut tail, &"x".repeat(20 * 1024));
        assert!(tail.len() <= 16 * 1024);
    }
}
