import Foundation

/// 内嵌 iSH Linux 内核的 Swift 封装 —— **只提供"工作环境"**。
///
/// # 职责边界（这一版重新划分过）
///
/// | 要做的事 | 由谁负责 |
/// |---|---|
/// | 会话/记忆/模型/HTTP/文件 | **Rust 引擎**（原生 aarch64，见 `EngineController`） |
/// | shell / git / python 等命令 | **本文件（iSH）** |
///
/// 也就是说：iSH 在 iOS 上的角色 = **Android 上 proot 的角色**。
/// 引擎不需要它也能跑，只有"要执行外部命令"时才用到。
///
/// # iSH 是什么
/// 它不是「模拟器 App」，而是一个**跑在进程内的 Linux 内核实现**：
///
/// ```c
/// xX_main_Xx(argc, argv, envp);              // 挂 /proc、/dev/pts，建设备节点
/// do_mount(&procfs,   "proc",   "/proc",   "", 0);
/// do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
/// do_execve("/bin/sh", 3, argv, envp);       // 在"Linux"里 exec
/// task_start(current);
/// ```
///
/// 于是 App 进程内就有了 fork/exec 能力 —— iOS 沙箱本身禁止 fork 宿主程序，
/// 但 iSH 的 fork 是**模拟实现**，不触碰系统调用，所以不受限制。
///
/// # 没链接 iSH 时
/// `ish_support.c` 提供桩实现（`ish_available()` 返回 0），
/// 本类会明确报"工作环境不可用"，而不是崩溃。此时引擎仍能正常启动，
/// 只是 shell 工具会失败。
final class ISHBridge {

    static let shared = ISHBridge()

    /// App 沙箱内的「Linux 根」。
    ///
    /// iSH 通过 `fs/real.c` 把这个宿主目录暴露成 Linux 的 `/`，
    /// 所以 `Documents/linux/usr/bin` 在 Linux 眼里就是 `/usr/bin`。
    private let linuxRootName = "linux"

    private var booted = false
    private var lastShellTask: UnsafeMutableRawPointer?

    private init() {}

    /// 宿主侧 Linux 根目录。
    var linuxRootURL: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(linuxRootName, isDirectory: true)
    }

    /// rootfs 是否就绪（`/bin/sh` 存在）。
    ///
    /// 这是"工作环境可用"的唯一判据 —— 没有 shell 什么都跑不了。
    var isUserlandReady: Bool {
        FileManager.default.fileExists(
            atPath: linuxRootURL.appendingPathComponent("bin/sh").path
        )
    }

    /// 把宿主路径换算成 iSH 里的 Linux 绝对路径。
    static func guestPath(for hostURL: URL) -> String {
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("linux", isDirectory: true).path
        let full = hostURL.standardizedFileURL.path
        if full.hasPrefix(root) {
            let rest = String(full.dropFirst(root.count))
            return rest.isEmpty ? "/" : rest
        }
        return full
    }

    // MARK: - 启动 Linux 运行时

    /// 初始化 iSH 内核（等价于 iSH App 的 `main()`），幂等。
    ///
    /// 返回 nil 表示成功；否则是可展示的错误文本。
    func boot() -> String? {
        if booted { return nil }

        guard ISHRuntime.available() else {
            return """
            未链接 iSH 运行时（libish.a）。
            工作环境（shell / git / python）将不可用；
            引擎本身仍可正常运行（对话、记忆、文件读写都不受影响）。
            """
        }

        do {
            try FileManager.default.createDirectory(
                at: linuxRootURL, withIntermediateDirectories: true)
        } catch {
            return "无法创建 Linux 根目录：\(error.localizedDescription)"
        }

        // ① 告知 iSH 根在哪（必须在 boot 之前）。
        let rootPath = linuxRootURL.path
        let rootErr = rootPath.withCString { ish_set_root($0) }
        if rootErr != 0 {
            return "设置 Linux 根失败（errno=\(rootErr)）"
        }

        // ② 初始化内核：挂 /proc、/dev/pts，建设备节点。
        let bootErr = ish_boot()
        if bootErr != 0 {
            return "初始化 Linux 内核失败（errno=\(bootErr)）"
        }

        booted = true
        return nil
    }

    /// 解包 rootfs（`linux-rootfs.tar.gz` → Linux 根）。
    ///
    /// 返回 nil 表示成功或无需解包。
    func installUserlandIfNeeded() -> String? {
        let marker = linuxRootURL.appendingPathComponent(".rootfs-ok")
        if FileManager.default.fileExists(atPath: marker.path) {
            return nil
        }
        guard let archive = Bundle.main.url(forResource: "linux-rootfs", withExtension: "tar.gz") else {
            return """
            App 资源里没有 `linux-rootfs.tar.gz`。
            工作环境（shell / git / python）将不可用；
            引擎本身仍可正常运行。
            """
        }

        guard boot() == nil else { return "Linux 运行时未就绪，无法解包 rootfs" }

        let fm = FileManager.default
        let linuxArchive = linuxRootURL.appendingPathComponent("rootfs.tar.gz")
        try? fm.removeItem(at: linuxArchive)
        do {
            try fm.copyItem(at: archive, to: linuxArchive)
        } catch {
            return "拷贝 rootfs 失败：\(error.localizedDescription)"
        }

        let guestArchive = Self.guestPath(for: linuxArchive)
        let guestRoot = Self.guestPath(for: linuxRootURL)
        let errnoCode: Int32 = guestArchive.withCString { archivePtr in
            guestRoot.withCString { rootPtr in
                ishtool_extract_tar(archivePtr, rootPtr)
            }
        }
        try? fm.removeItem(at: linuxArchive)
        if errnoCode != 0 {
            return "解包 rootfs 失败（iSH tar 返回 errno=\(errnoCode)）"
        }

        FileManager.default.createFile(atPath: marker.path, contents: Data())
        return nil
    }

    // MARK: - 执行命令（引擎的 shell 工具会调这里）

    /// 在 Linux 侧执行一条命令。
    ///
    /// 注意这是**异步**的：`do_execve` 之后 tar/命令还在跑，
    /// 调用方需要自己等结果（或只看副作用）。真正的"同步返回输出"
    /// 需要等 iSH 侧的 PTY 集成完成，目前阶段先保证命令能跑起来。
    @discardableResult
    func run(command: String) throws -> UnsafeMutableRawPointer {
        guard booted else { throw ISHError.notBooted }
        var errorCode: Int32 = 0
        let task = command.withCString { cmd -> UnsafeMutableRawPointer? in
            ish_spawn_shell(cmd, &errorCode)
        }
        guard let task else {
            throw ISHError.spawnFailed(code: errorCode)
        }
        lastShellTask = task
        return task
    }

    /// 中止最近一次命令（SIGTERM）。
    func terminateLastCommand() {
        guard let task = lastShellTask else { return }
        ish_kill_task(task, 15)
        lastShellTask = nil
    }
}

enum ISHError: LocalizedError {
    case notBooted
    case spawnFailed(code: Int32)

    var errorDescription: String? {
        switch self {
        case .notBooted:
            return "Linux 工作环境尚未初始化"
        case let .spawnFailed(code):
            return "启动命令失败（errno=\(code)）"
        }
    }
}

// MARK: - iSH C 接口声明
//
// 由 `ish_support.c` 提供。集中在这里，便于核对签名。
// 返回值约定：0 = 成功，非 0 = errno。

@_silgen_name("ish_set_root")
private func ish_set_root(_ path: UnsafePointer<CChar>) -> Int32

@_silgen_name("ish_boot")
private func ish_boot() -> Int32

@_silgen_name("ish_mount_pseudo_filesystems")
private func ish_mount_pseudo_filesystems() -> Int32

@_silgen_name("ish_spawn_shell")
private func ish_spawn_shell(
    _ command: UnsafePointer<CChar>,
    _ errorOut: UnsafeMutablePointer<Int32>
) -> UnsafeMutableRawPointer?

@_silgen_name("ish_kill_task")
private func ish_kill_task(_ task: UnsafeMutableRawPointer, _ signal: Int32)

@_silgen_name("ishtool_extract_tar")
private func ishtool_extract_tar(
    _ archive: UnsafePointer<CChar>,
    _ destination: UnsafePointer<CChar>
) -> Int32

/// iSH 可用性的共享入口（供 Readiness 等多处调用）。
enum ISHRuntime {
    @_silgen_name("ish_available")
    static func available() -> Bool
}
