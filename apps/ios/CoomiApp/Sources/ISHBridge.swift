import Foundation

/// 内嵌 iSH Linux 内核的 Swift 封装。
///
/// # 它到底做了什么
/// iSH 不是「模拟器 App」，而是一个**跑在进程内的 Linux 内核实现**：
///
/// ```c
/// int err = xX_main_Xx(argc, argv, envp);   // 挂 /proc、/dev/pts，建设备节点
/// do_mount(&procfs, "proc", "/proc", "", 0);
/// do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
/// do_execve("/usr/local/bin/coomi", ...);   // 在"Linux"里 exec
/// task_start(current);                      // 开始跑那个 task
/// ```
///
/// 也就是说：**App 进程内直接拥有 fork/exec/POSIX 信号**，引擎就是一个普通 Linux 进程。
/// 这正是「跟软件一起拉起」的含义 —— 不需要外部 iSH App，也就没有 iOS 后台挂起问题。
///
/// # 为什么用 Objective-C 桥接而不是 Swift 直接调 C
/// iSH 的 API 大量使用 `struct task *`、`current`、`do_execve(...)` 这类
/// 内核内部类型与宏，Swift 无法直接表达（`current` 是线程局部宏）。
/// 用一个 `.m` 文件把它们包成 `NSObject` 方法最稳，也便于以后替换实现。
///
/// # 当前状态
/// 本文件是**接口契约 + 调用骨架**：它假定工程里已链接了 iSH 的静态库
/// （见 `docs/README.md` 的「集成 iSH 静态库」一节），并声明了所需的 C 符号。
/// 未链接时 `ISHBridge` 会返回明确的错误而不是崩溃。
final class ISHBridge {

    static let shared = ISHBridge()

    /// Linux 侧的挂载点（App 沙箱目录在 iSH 里的映射）。
    ///
    /// iSH 通过 `fs/real.c` 把宿主路径暴露成 Linux 路径；
    /// 我们用 App 的 `Documents/linux` 作为「Linux 根」，
    /// 于是 `Documents/linux/usr/local/bin/coomi` 在 Linux 侧就是 `/usr/local/bin/coomi`。
    private let linuxRootName = "linux"

    private var booted = false
    private var engineTask: UnsafeMutableRawPointer?

    private init() {}

    /// 宿主侧 Linux 根目录（App 沙箱内）。
    var linuxRootURL: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(linuxRootName, isDirectory: true)
    }

    /// 引擎二进制在宿主上的落点。
    ///
    /// 单独抽成属性是为了让**就绪诊断**与**实际安装**共用同一条路径定义 ——
    /// 两处各写一遍 "usr/local/bin/coomi" 迟早会漂移，
    /// 届时诊断说"就绪"而启动却找不到文件，那种 bug 很难查。
    var engineBinaryURL: URL {
        linuxRootURL
            .appendingPathComponent("usr/local/bin", isDirectory: true)
            .appendingPathComponent("coomi")
    }

    /// iOS 侧引擎在 Linux 里的路径（供启动命令使用）。
    static let enginePathInLinux = "/usr/local/bin/coomi"

    // MARK: - 启动 Linux 运行时

    /// 初始化 iSH 内核（等价于 iSH App 的 `main()`），幂等。
    ///
    /// 返回 nil 表示成功；否则是可展示的错误文本。
    func boot() -> String? {
        if booted { return nil }

        do {
            try FileManager.default.createDirectory(
                at: linuxRootURL, withIntermediateDirectories: true)
        } catch {
            return "无法创建 Linux 根目录：\(error.localizedDescription)"
        }

        // ① 把宿主目录变成 iSH 的根。
        //    iSH 的 `iOSFS` 负责这件事：它把 App 沙箱里的一个目录作为 `/` 暴露给 Linux。
        guard ish_available() else {
            return """
            未链接 iSH 运行时（libish.a）。
            请按 docs/README.md「集成 iSH 静态库」把 iSH 编成静态库并加入本工程。
            """
        }
        let rootPath = linuxRootURL.path
        let err = rootPath.withCString { ish_set_root($0) }
        if err != 0 {
            return "设置 Linux 根失败（errno=\(err)）"
        }

        // ② 初始化内核：挂 /proc、/dev/pts，建设备节点。
        //    这些在 iSH 里是必须的 —— 没有 /proc，很多工具（含 Rust 的 std::env）行为异常。
        var bootErr = ish_boot()
        if bootErr != 0 {
            return "初始化 Linux 内核失败（errno=\(bootErr)）"
        }
        bootErr = ish_mount_pseudo_filesystems()
        if bootErr != 0 {
            return "挂载 /proc 与 /dev/pts 失败（errno=\(bootErr)）"
        }

        booted = true
        return nil
    }

    // MARK: - 安装运行时（引擎二进制 + 前端）

    /// 把 App 资源里的引擎与前端、以及 rootfs 解包到 Linux 根（幂等）。
    ///
    /// 顺序很重要：**先铺 rootfs，再放引擎**。
    /// 反过来的话，`/bin/sh` 还不存在时引擎就算起来了也 exec 不了任何命令
    /// —— 表现为「健康检查一直失败」，而日志里只有一句模糊的 spawn 错误。
    func installRuntimeIfNeeded(engineResource: String, webResource: String) -> String? {
        // ① rootfs（首次或版本变化时解包）。
        if let error = unpackRootfsIfNeeded() {
            return error
        }

        let fm = FileManager.default
        let binDir = linuxRootURL.appendingPathComponent("usr/local/bin", isDirectory: true)
        let webDir = linuxRootURL.appendingPathComponent("root/.coomi/web", isDirectory: true)
        // 用统一属性，避免与就绪诊断各写一份路径。
        let engineDst = engineBinaryURL

        do {
            try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
            try fm.createDirectory(at: webDir, withIntermediateDirectories: true)
        } catch {
            return "创建目录失败：\(error.localizedDescription)"
        }

        // ② 引擎二进制：只在缺失时拷贝（省掉每次启动几 MB 的拷贝）。
        if !fm.fileExists(atPath: engineDst.path),
           let src = Bundle.main.url(forResource: engineResource, withExtension: nil) {
            do {
                try fm.copyItem(at: src, to: engineDst)
                // 关键：Linux 侧要可执行。
                try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engineDst.path)
            } catch {
                return "解包引擎失败：\(error.localizedDescription)"
            }
        }
        if !fm.fileExists(atPath: engineDst.path) {
            return """
            App 资源里找不到引擎二进制 `\(engineResource)`（i686 Linux 版）。
            请用 Scripts/build-ios-runtime.sh 产出后放进 CoomiApp/Resources/。
            """
        }

        // ③ 前端：整目录替换（内容小，简单可靠）。
        if let webSrc = Bundle.main.url(forResource: webResource, withExtension: nil) {
            if let items = try? fm.contentsOfDirectory(at: webSrc, includingPropertiesForKeys: nil) {
                for item in items {
                    let dst = webDir.appendingPathComponent(item.lastPathComponent)
                    try? fm.removeItem(at: dst)
                    try? fm.copyItem(at: item, to: dst)
                }
            }
        }
        return nil
    }

    /// 解包 `linux-rootfs.tar.gz` 到 Linux 根（已解包则跳过）。
    ///
    /// 为什么用 tar.gz 而不是把几万个文件塞进 App bundle：
    ///   · App bundle 里每个文件都是一个 inode，几万个小文件会显著拖慢安装与首次启动；
    ///   · 单个归档在首次解包后即可删除（运行时只用解包结果）。
    private func unpackRootfsIfNeeded() -> String? {
        let fm = FileManager.default
        let marker = linuxRootURL.appendingPathComponent(".rootfs-ok")
        if fm.fileExists(atPath: marker.path) {
            return nil
        }
        guard let archive = Bundle.main.url(forResource: "linux-rootfs", withExtension: "tar.gz") else {
            return """
            App 资源里找不到 `linux-rootfs.tar.gz`。
            请用 Scripts/build-ios-runtime.sh 产出后放进 CoomiApp/Resources/。
            """
        }
        do {
            try fm.createDirectory(at: linuxRootURL, withIntermediateDirectories: true)
        } catch {
            return "创建 Linux 根目录失败：\(error.localizedDescription)"
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = [
            "-xzf", archive.path,
            "-C", linuxRootURL.path,
            // 恢复权限位（/bin/sh 必须可执行）。
            "--preserve-permissions",
        ]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return "解包 rootfs 失败：\(error.localizedDescription)"
        }
        if process.terminationStatus != 0 {
            return "解包 rootfs 失败（tar 退出码 \(process.terminationStatus)）"
        }
        // 标记完成：下次直接跳过。
        FileManager.default.createFile(atPath: marker.path, contents: Data())
        return nil
    }

    // MARK: - 启动引擎

    /// 在 Linux 侧 exec `coomi serve`。
    ///
    /// 之所以叫 `spawnProbe` 而不是 `spawnEngine`：它**只负责拉起**，
    /// 是否真的就绪由调用方的健康检查判断（Linux 进程活着 ≠ HTTP 可用）。
    func spawnProbe(port: Int, token: String) throws {
        guard booted else {
            throw ISHError.notBooted
        }
        let command = Self.serveCommand(port: port, token: token)
        var errorCode: Int32 = 0
        let task = command.withCString { cmd -> UnsafeMutableRawPointer? in
            ish_spawn_shell(cmd, &errorCode)
        }
        guard let task else {
            throw ISHError.spawnFailed(code: errorCode)
        }
        engineTask = task
    }

    /// 停止引擎（Linux 侧发 SIGTERM）。
    func terminateEngine() {
        guard let task = engineTask else { return }
        ish_kill_task(task, 15 /* SIGTERM */)
        engineTask = nil
    }

    /// 构造启动命令。
    ///
    /// `COOMI_DISABLE_IROH=1`：iSH 是 32 位模拟，QUIC/TLS 又慢又不稳，显式关掉
    /// （编译时也可能已经 `--no-default-features`）。
    /// `nohup ... &` 不需要 —— 这个 Linux 进程由 App 进程持有，App 活着它就在。
    nonisolated static func serveCommand(port: Int, token: String) -> String {
        """
        COOMI_DISABLE_IROH=1 exec /usr/local/bin/coomi serve \
          --home /root/.coomi --cwd /root \
          --port \(port) --token \(token) \
          --static-dir /root/.coomi/web
        """
    }
}

enum ISHError: LocalizedError {
    case notBooted
    case spawnFailed(code: Int32)

    var errorDescription: String? {
        switch self {
        case .notBooted:
            return "Linux 运行时尚未初始化"
        case let .spawnFailed(code):
            return "启动引擎进程失败（errno=\(code)）"
        }
    }
}

// MARK: - iSH C 接口声明
//
// 这些符号由 iSH 静态库提供。声明集中放在这里，便于核对签名与替换实现。
// 返回值约定：0 = 成功，非 0 = errno（与 iSH 内部一致）。

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

@_silgen_name("ish_available")
private func ish_available() -> Bool
