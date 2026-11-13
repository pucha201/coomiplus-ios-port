import Foundation

/// 内嵌 Linux 工作环境（iSH）的 Swift 封装。
///
/// # 架构定位（重要，别搞错）
/// 这里**只负责工作环境**，不跑引擎。
///
/// ```
/// 安卓：原生引擎(libcoomi_engine.so, JNI) + proot 工作环境
/// iOS ：原生引擎(libcoomi_ui.a, C ABI) + iSH 工作环境   ← 本文件是右半边
/// ```
///
/// 引擎由 `EngineController.swift` 通过 `coomi_start()` 在 App 进程内直接跑，
/// **与 iSH 完全解耦**：引擎先起（原生，秒级），iSH 后起（可选）。
/// iSH 起不来时引擎照常工作，只是 AI 不能执行 shell 命令。
///
/// 本文件负责的是「给 AI 一个能执行 shell 命令的 Linux」——
/// 也就是安卓上 proot 的角色。
///
/// # 为什么不直接调 ish_embed_*
/// `ish_embed_*` 的结构体（`ish_embed_boot_opts_t` / `ish_embed_oneshot_result_t`）
/// 字段较多且含 `const char *const *`、`size_t *` 输出参数。若在 Swift 里
/// 手抄一份布局，一旦与 C 头不一致就是**静默的内存踩踏**（不报错、随机崩）。
///
/// 所以 C 侧（`ish_support.c`）提供 4 个扁平函数 `coomi_ish_*`，
/// Swift 只碰 `void *` 和 `char *`。附带好处：桩实现（未链接 libish.a）
/// 与真实现共用**同一份** Swift 代码，不需要 `#if`。
final class ISHBridge {

    static let shared = ISHBridge()

    /// fakefs 根目录名（App 沙箱内）。
    ///
    /// iSH 的 fakefs 是一个**普通宿主目录**，里面放 `data/` 和 `meta.db`。
    /// 换句话说：Linux 的 `/` 就是 `Documents/linux/`，双向可见。
    private let linuxRootName = "linux"

    private var instance: UnsafeMutableRawPointer?
    private let lock = NSLock()

    /// 最近一次解包写入了多少条目（0 = 复用了已有 fakefs，没解包）。
    /// 供诊断界面显示 —— 「856 个条目」是 fakefs 铺好的直接证据。
    private(set) var lastExtractCount = 0

    /// 最近一次 `bootWithReport()` 的结果，供 Readiness 复用（不重复 boot）。
    private(set) var lastBootReport: ISHBootReport?

    private init() {}

    /// 宿主侧 fakefs 根目录。
    ///
    /// 注意这不是「一个普通的 Linux 根文件系统目录」。iSH 的 fakefs 在根下
    /// 放三样东西：`meta.db`（SQLite，记 inode/权限/时间戳）、`meta.db-shm`、
    /// `meta.db-wal`，真实文件内容在 `data/` 下。`ish_embed_boot` 的头文件
    /// 注释就是 "the dir that has data/ + meta.db"，所以必须先把 fakefs
    /// 镜像铺到这里，再 boot。
    var linuxRootURL: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(linuxRootName, isDirectory: true)
    }

    /// 打包进 App 的 fakefs rootfs（由 scripts/fetch-ish.sh 从上游 release 取）。
    ///
    /// 早期这里带的是 alpine-minirootfs 的 tar，格式不对 —— 没有 meta.db
    /// 也没有 /sbin/ishsv，boot 会挂在 ISH_ERR_MOUNT(-2) 或
    /// ISH_ERR_EXECVE(-6)。现在换成官方用 fakefsify 生成好的 fs.tar.gz。
    var bundledRootfsURL: URL? {
        Bundle.main.url(forResource: "linux-rootfs", withExtension: "tar.gz")
    }

    /// 是否已成功起内核。
    var isBooted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return instance != nil
    }

    /// 工作环境是否可用（静态库已链接 且 已 boot）。
    var isUserlandReady: Bool {
        return ISHRuntime.available() && isBooted
    }

    // MARK: - 启动 / 关闭
    //
    // 顺序很关键，别调换：
    //   ① 先在**宿主侧**把 fakefs 镜像铺到 linuxRootURL（要有 meta.db + data/）
    //   ② 再调 ish_embed_boot —— 它会挂载 meta.db 并把 /sbin/ishsv 拉成 PID1
    //
    // 曾经这里是反的：先拿空目录 boot，boot 完再想用 guest 的 /bin/tar 解包。
    // 但空目录连挂载都过不去（没有 meta.db），更不会有 /bin/tar，
    // 于是必然死在 ISH_ERR_MOUNT(-2)，而错误又被当成「不算致命」吞掉。
    //
    // 启动入口只有 `bootWithReport()` 一个。旧版另有一个只回错误字符串的
    // `boot()`，和它并行了 prepareFakefs + boot + 自检三件事，却从未被调用 ——
    // 两份实现并存的结果是改了一份、另一份静默漂移。已删除。

    /// 把 bundled fakefs 镜像铺到 linuxRootURL。幂等（靠哨兵）。
    ///
    /// 镜像结构是 `fs/{meta.db, meta.db-shm, meta.db-wal, data/...}`，
    /// 而 ish_embed_boot 要的根是「含 meta.db 的目录」，也就是 `fs/` 的内容，
    /// 所以解包后要**把 fs/ 里的东西提到根上**，不能留一层 fs/。
    private func prepareFakefs() -> String? {
        let root = linuxRootURL
        let metaDB = root.appendingPathComponent("meta.db")
        let dataDir = root.appendingPathComponent("data", isDirectory: true)

        // 已有 fakefs：必须**连关键文件一起验**才算完整。
        //
        // 老写法只查 meta.db 与 data/ 两个路径就 return nil，于是：
        // 首次解包若中途失败（留下 meta.db + 空 data/），第二次启动会判「已就绪」，
        // 直接跳过下面 L182 起的硬断言 —— 损坏的 fakefs 被当成好的，
        // boot 挂在 -2/-6 而原因看不出来。这里补上 supervisor 与 shell 的检查，
        // 不完整就落到重新解包分支。
        let supervisor = root.appendingPathComponent("data/sbin/ishsv")
        let shell = root.appendingPathComponent("data/bin/sh")
        if FileManager.default.fileExists(atPath: metaDB.path),
           FileManager.default.fileExists(atPath: dataDir.path),
           FileManager.default.fileExists(atPath: supervisor.path),
           FileManager.default.fileExists(atPath: shell.path) {
            return nil
        }

        guard let archive = bundledRootfsURL else {
            return "App 包里没有 linux-rootfs.tar.gz（构建时 fetch-ish.sh 没跑？）"
        }

        // 清掉上次残留的半成品，避免 meta.db 与 data/ 来自不同版本。
        if FileManager.default.fileExists(atPath: root.path) {
            try? FileManager.default.removeItem(at: root)
        }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            return "无法创建 fakefs 根目录：\(error.localizedDescription)"
        }

        // iOS 不能 fork/exec，但解 tar 是纯宿主操作。
        // 用自带的 TarGzExtractor（纯 Swift，Compression framework 解 gzip），
        // 不依赖 guest，也不依赖系统 tar —— 那正是之前的死结。
        do {
            let n = try TarGzExtractor.extract(fileAt: archive, into: root)
            lastExtractCount = n
            NSLog("[iSH] fakefs 解包完成，%d 个条目", n)
        } catch {
            return "解包 fakefs 失败：\(error.localizedDescription)"
        }

        // 若镜像里带一层 fs/，把它的内容提上来。
        let nested = root.appendingPathComponent("fs", isDirectory: true)
        if FileManager.default.fileExists(atPath: nested.appendingPathComponent("meta.db").path) {
            if let err = promoteChildren(of: nested, to: root) {
                return err
            }
            try? FileManager.default.removeItem(at: nested)
        }

        // 硬断言：少了这两个，boot 一定失败。
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("meta.db").path) else {
            return "fakefs 缺 meta.db —— 打包的 rootfs 不是 fakefs 格式"
        }
        let ishsv = root.appendingPathComponent("data/sbin/ishsv")
        guard FileManager.default.fileExists(atPath: ishsv.path) else {
            return "fakefs 缺 data/sbin/ishsv —— PID1 supervisor 不在，boot 会挂在 -6"
        }
        return nil
    }

    /// 把 dir 下的所有条目移动到 parent（用于消掉多余的一层 fs/）。
    private func promoteChildren(of dir: URL, to parent: URL) -> String? {
        let fm = FileManager.default
        guard let kids = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return "无法列出 \(dir.lastPathComponent)"
        }
        for kid in kids {
            let dest = parent.appendingPathComponent(kid.lastPathComponent)
            try? fm.removeItem(at: dest)
            do {
                try fm.moveItem(at: kid, to: dest)
            } catch {
                return "移动 \(kid.lastPathComponent) 失败：\(error.localizedDescription)"
            }
        }
        return nil
    }

    /// 真跑一条命令确认 userland 能用。
    /// 起 iSH 内核并返回**结构化**结果（幂等）。
    ///
    /// 这是**唯一**的启动入口。它返回 `ISHBootReport` 而不是一个错误字符串，
    /// 因为 iOS 上不能 fork/exec，用户也很难连电脑看 Console.app ——
    /// 「走到哪一步、boot 返回码是多少、自检输出是什么」必须能显示在屏幕上。
    ///
    /// 流程：① 铺 fakefs（boot 前必须）→ ② 起内核 → ③ 跑 userland 自检。
    func bootWithReport() -> ISHBootReport {
        var report = ISHBootReport()
        // 结果存下来：Readiness 会读它，避免为了显示诊断而重复 boot
        // （重复 boot 会返回 -10 已启动，反而让诊断看起来像失败）。
        defer { lastBootReport = report }
        report.runtimeLinked = ISHRuntime.available()

        guard report.runtimeLinked else {
            report.stage = .notLinked
            report.failureReason = "未链接 iSH 运行时（libIshKernel.a）"
            return report
        }

        // ① 铺 fakefs（必须在 boot 之前）。
        let t0 = Date()
        if let prepErr = prepareFakefs() {
            report.stage = .prepareFailed
            report.failureReason = prepErr
            return report
        }
        report.prepareMs = Int(Date().timeIntervalSince(t0) * 1000)
        report.extractedEntries = lastExtractCount
        report.fakefsReady = true
        report.rootPath = linuxRootURL.path

        // ② 若已 boot，复用实例，但**自检照样重跑**。
        //
        //    老写法在这里硬写 `probePassed = true` —— 那是**谎报**：
        //    「已 boot」只说明内核实例在，不代表自检过了（自检可能因 /bin/sh 缺失失败）。
        //    诊断界面存在的意义就是把这种情况暴露出来，不能在这里抹平。
        //    重跑而不是复用旧结论：用户点「重新检查」时正是想知道「现在还行不行」。
        if isBooted {
            report.stage = .booted
            runProbe(into: &report)
            return report
        }

        // ③ 起内核。
        var inst: UnsafeMutableRawPointer?
        let rc: Int32 = linuxRootURL.path.withCString { rootPtr in
            "/".withCString { wdPtr in
                coomi_ish_boot(rootPtr, wdPtr, &inst)
            }
        }

        report.bootStatus = rc
        guard rc == 0, let inst else {
            report.stage = .bootFailed
            report.failureReason = "启动 Linux 内核失败：\(ISHStatus.describe(rc))"
            return report
        }

        lock.lock()
        instance = inst
        lock.unlock()
        report.stage = .booted

        // ④ 自检：真跑一条命令。boot 返回 0 只说明内核起来了，
        //    不代表能执行命令 —— supervisor 没起来 / /bin/sh 缺失都在这一步暴露。
        //    这是整个 iSH 集成里唯一没有被验证过的一环，所以输出要留着给人看。
        runProbe(into: &report)
        return report
    }

    /// 跑 userland 自检并把结果写进 [report]。
    ///
    /// 抽成方法是为了让幂等路径也能重跑：首次自检若失败（比如 fakefs 当时残缺），
    /// 用户补好后再点「重新检查」，必须能重新得到结论 —— 而不是永远停在旧失败上。
    private func runProbe(into report: inout ISHBootReport) {
        let probe = run(["/bin/sh", "-c", "echo coomi-ok; uname -s"],
                        cwd: "/", timeoutMS: 20_000)
        guard let probe else {
            report.stage = .probeFailed
            report.probePassed = false
            report.failureReason = "无法发起自检命令（内核实例不可用）"
            NSLog("[iSH] userland 自检失败: 无法发起命令")
            return
        }

        report.probeExitCode = probe.exitCode
        report.probeStdout = probe.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
        report.probeStderr = probe.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
        report.probePassed = probe.exitCode == 0 && probe.stdoutText.contains("coomi-ok")

        if report.probePassed {
            NSLog("[iSH] userland 自检通过: %@", report.probeStdout)
        } else {
            report.stage = .probeFailed
            report.failureReason = probe.exitCode != 0
                ? "自检退出码 \(probe.exitCode)：\(probe.stderrText.prefix(200))"
                : "stdout 不含探针串：\(probe.stdoutText.prefix(200))"
            NSLog("[iSH] userland 自检失败: %@", report.failureReason ?? "")
        }
    }

    /// 关闭内核（App 进后台或退出时调用）。
    func shutdown() {
        lock.lock()
        let inst = instance
        instance = nil
        lock.unlock()

        guard let inst else { return }
        _ = coomi_ish_shutdown(inst, 2000)
    }

    /// 内核路径无法启动时的静态文案（供 Readiness 用）。
    static var unavailableReason: String {
        "未链接 iSH 运行时（libish.a）。引擎不受影响，只是 AI 不能执行 shell 命令。"
    }

    // MARK: - 安装 userland

    /// 把 bundled fakefs 镜像铺到 fakefs 根目录。
    ///
    /// 曾经这里是把 tar 复制进 guest 再调 `/bin/tar xzf` —— 死结：
    /// 空 fakefs 里没有 /bin/tar，而没有 rootfs 又 boot 不起来。
    /// 现在改成纯宿主侧解开（TarGzExtractor），boot 之前就能铺好。
    /// 具体流程见 prepareFakefs()。
    @discardableResult
    func installUserlandIfNeeded() -> String? {
        prepareFakefs()
    }

    // MARK: - 执行命令

    struct CommandResult {
        let exitCode: Int32
        let stdout: Data
        let stderr: Data
        let timedOut: Bool

        var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
        var stderrText: String { String(decoding: stderr, as: UTF8.self) }
    }

    /// 在 Linux 里跑一条命令，同步等结果。
    ///
    /// 这是引擎 shell 工具的底层实现（对应安卓 proot 的 run_oneshot）。
    ///
    /// - Parameters:
    ///   - argv: 命令与参数，**不要**自己加 `/bin/sh -c`；
    ///           需要 shell 语义时显式传 `["/bin/sh","-c", cmd]`。
    ///   - cwd: guest 内工作目录，nil = `/`。
    ///   - timeoutMS: 超时毫秒；0 = 不限（不推荐，命令卡死会拖住线程）。
    func run(_ argv: [String], cwd: String? = nil, timeoutMS: UInt32 = 60_000) -> CommandResult? {
        lock.lock()
        let inst = instance
        lock.unlock()
        guard let inst else { return nil }

        // ① argv 转 C 字符串数组（NULL 结尾）。
        //    每个 CString 必须活到调用结束，所以先用数组持有、再取指针。
        let cstrings: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        defer { cstrings.forEach { free($0) } }

        var argvPtrs: [UnsafePointer<CChar>?] = cstrings.map { $0.map { UnsafePointer($0) } }
        argvPtrs.append(nil)

        var exitCode: Int32 = 0
        var signal: Int32 = 0
        var timedOut: Int32 = 0
        var outBuf: UnsafeMutablePointer<CChar>?
        var outLen: Int = 0
        var errBuf: UnsafeMutablePointer<CChar>?
        var errLen: Int = 0

        let run: (UnsafePointer<CChar>?) -> Int32 = { cwdPtr in
            argvPtrs.withUnsafeBufferPointer { argvBuf in
                coomi_ish_run(
                    inst,
                    argvBuf.baseAddress,
                    cwdPtr,
                    timeoutMS,
                    &exitCode,
                    &signal,
                    &timedOut,
                    &outBuf,
                    &outLen,
                    &errBuf,
                    &errLen
                )
            }
        }

        let rc: Int32 = cwd.map { $0.withCString { run($0) } } ?? run(nil)

        defer {
            coomi_ish_free(outBuf)
            coomi_ish_free(errBuf)
        }

        guard rc == 0 else {
            NSLog("[iSH] run 失败: %@ argv=%@", ISHStatus.describe(rc), argv.joined(separator: " "))
            return CommandResult(
                exitCode: -1,
                stdout: Data(),
                stderr: Data(("iSH error: " + ISHStatus.describe(rc)).utf8),
                timedOut: rc == ISHStatus.ERR_TIMEOUT
            )
        }

        let out = outBuf.map { Data(bytes: $0, count: outLen) } ?? Data()
        let err = errBuf.map { Data(bytes: $0, count: errLen) } ?? Data()
        return CommandResult(
            exitCode: exitCode,
            stdout: out,
            stderr: err,
            timedOut: timedOut != 0
        )
    }

    /// 用 `/bin/sh -c` 跑一串 shell 命令（需要管道/重定向时用）。
    func runShell(_ command: String, cwd: String? = nil, timeoutMS: UInt32 = 60_000) -> CommandResult? {
        return run(["/bin/sh", "-c", command], cwd: cwd, timeoutMS: timeoutMS)
    }

    /// guest 路径 → 宿主 URL。
    ///
    /// fakefs 根就是宿主 `Documents/linux`，所以 `/usr/bin/git` → `<root>/usr/bin/git`。
    /// 需要直接读写 guest 文件（不走 shell）时用。
    func hostURL(forGuestPath path: String) -> URL {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return linuxRootURL.appendingPathComponent(trimmed)
    }
}

// MARK: - C ABI 声明
//
// 与 `include/ishembed.h`（ABI v1）对应的扁平包装，实现在 `ish_support.c`。
// 刻意保持「指针进、指针出」，不让 Swift 看见 iSH 的结构体。

@_silgen_name("coomi_ish_boot")
private func coomi_ish_boot(
    _ rootfs: UnsafePointer<CChar>,
    _ workdir: UnsafePointer<CChar>?,
    _ outInstance: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) -> Int32

@_silgen_name("coomi_ish_run")
private func coomi_ish_run(
    _ instance: UnsafeMutableRawPointer,
    _ argv: UnsafePointer<UnsafePointer<CChar>?>?,
    _ cwd: UnsafePointer<CChar>?,
    _ timeoutMS: UInt32,
    _ outExitCode: UnsafeMutablePointer<Int32>,
    _ outSignal: UnsafeMutablePointer<Int32>,
    _ outTimedOut: UnsafeMutablePointer<Int32>,
    _ outStdout: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
    _ outStdoutLen: UnsafeMutablePointer<Int>,
    _ outStderr: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
    _ outStderrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("coomi_ish_free")
private func coomi_ish_free(_ p: UnsafeMutableRawPointer?)

@_silgen_name("coomi_ish_shutdown")
private func coomi_ish_shutdown(_ instance: UnsafeMutableRawPointer, _ graceMS: UInt32) -> Int32

/// iSH C 接口的共享声明。
///
/// 集中放这里的原因：`ish_available()` 被**多个** Swift 文件用
/// （ISHBridge 启动、Readiness 就绪诊断）。声明散落且标 private 时，
/// 另一个文件会 "cannot find xxx in scope" —— CI 上真实踩过这个坑。
enum ISHRuntime {
    /// 是否链接了 iSH 运行时（未链接时 C 侧桩实现返回 false）。
    @_silgen_name("ish_available")
    static func available() -> Bool
}

/// iSH 启动诊断报告。
///
/// # 为什么需要它
/// `boot()` 只回一个错误串，看不出「走到哪一步」。iOS 又不能 fork/exec，
/// 用户很难连电脑看 Console.app —— 所以每一步的结果都要能显示在屏幕上。
///
/// # 每一步都在验证什么
/// | 阶段 | 验证的事实 |
/// |---|---|
/// | `.notLinked` | 静态库没链进来（`COOMI_HAS_ISH=0` 或漏了产物） |
/// | `.prepareFailed` | fakefs 没铺好（缺 meta.db / ishsv / 解包失败） |
/// | `.bootFailed` | `ish_embed_boot` 返回非 0，见 `bootStatus` |
/// | `.probeFailed` | 内核起来了但命令跑不通（supervisor / /bin/sh 问题） |
/// | `.booted` && `probePassed` | **全链路打通**：内核 + fakefs + userland 都能用 |
struct ISHBootReport {
    enum Stage: String {
        case notLinked = "未链接 iSH"
        case prepareFailed = "fakefs 准备失败"
        case bootFailed = "内核启动失败"
        case probeFailed = "userland 自检失败"
        case booted = "内核已启动"

        var label: String { rawValue }
    }

    var stage: Stage = .notLinked
    var runtimeLinked = false
    var fakefsReady = false
    var rootPath = ""

    /// 本次解包的条目数（0 = 复用已有 fakefs）。
    var extractedEntries = 0
    /// 铺 fakefs 耗时（毫秒）。
    var prepareMs = 0

    /// `coomi_ish_boot` 的原始返回码（0 = 成功）。
    var bootStatus: Int32 = 0

    var probeExitCode: Int32 = 0
    var probeStdout = ""
    var probeStderr = ""
    var probePassed = false

    var failureReason: String?

    /// 全链路是否真的打通 —— 这是唯一有意义的成功判据。
    var isFullyWorking: Bool { stage == .booted && probePassed }

    /// 一行摘要，给界面顶部用。
    var summary: String {
        if isFullyWorking {
            return "iSH 已启动，userland 自检通过（这是首次拿到运行时证据）。"
        }
        if let reason = failureReason {
            return "\(stage.label)：\(reason)"
        }
        return stage.label
    }
}

/// 状态码，与 `ishembed.h` 的 `ish_embed_status_t` 一致。
enum ISHStatus {
    static let OK: Int32 = 0
    static let ERR_BOOT: Int32 = -1
    static let ERR_MOUNT: Int32 = -2
    static let ERR_BECOME_INIT: Int32 = -3
    static let ERR_STDIO: Int32 = -4
    static let ERR_CHDIR: Int32 = -5
    static let ERR_EXECVE: Int32 = -6
    static let ERR_PIPE: Int32 = -7
    static let ERR_THREAD: Int32 = -8
    static let ERR_NOT_RUNNING: Int32 = -9
    static let ERR_ALREADY_BOOTED: Int32 = -10
    static let ERR_PROTOCOL: Int32 = -11
    static let ERR_TIMEOUT: Int32 = -12
    static let ERR_INVALID_ARG: Int32 = -13
    static let ERR_NO_SESSION: Int32 = -14
    static let ERR_SUPERVISOR: Int32 = -15
    static let ERR_OOM: Int32 = -16
    static let ERR_BROKEN_PIPE: Int32 = -17
    static let ERR_INTERNAL: Int32 = -99

    static func describe(_ code: Int32) -> String {
        switch code {
        case OK: return "成功"
        case ERR_BOOT: return "内核启动失败(-1)"
        case ERR_MOUNT: return "fakefs 挂载失败(-2)"
        case ERR_BECOME_INIT: return "become_first_process 失败(-3)"
        case ERR_STDIO: return "stdio 安装失败(-4)"
        case ERR_CHDIR: return "切换目录失败(-5)"
        case ERR_EXECVE: return "supervisor exec 失败(-6)"
        case ERR_PIPE: return "管道创建失败(-7)"
        case ERR_THREAD: return "线程创建失败(-8)"
        case ERR_NOT_RUNNING: return "内核未运行(-9)"
        case ERR_ALREADY_BOOTED: return "内核已启动(-10)"
        case ERR_PROTOCOL: return "协议错误(-11)"
        case ERR_TIMEOUT: return "超时(-12)"
        case ERR_INVALID_ARG: return "参数非法(-13)"
        case ERR_NO_SESSION: return "会话不存在(-14)"
        case ERR_SUPERVISOR: return "supervisor 报错(-15)"
        case ERR_OOM: return "内存不足(-16)"
        case ERR_BROKEN_PIPE: return "管道断裂(-17)"
        case ERR_INTERNAL: return "内部错误(-99)"
        default: return "未知错误(\(code))"
        }
    }
}
