import Foundation
import Security

/// 引擎生命周期管理 —— **原生**运行在 App 进程内。
///
/// # 架构（与安卓对齐）
/// ```
/// 安卓：libcoomi_engine.so  (JNI)  + proot 工作环境
/// iOS ：libcoomi_ui.a      (C ABI) + iSH   工作环境   ← 引擎这一半是本文件
/// ```
///
/// 引擎是 **aarch64-apple-ios 静态库**，通过 `coomi_start()` 在进程内起 tokio
/// 多线程运行时并监听 127.0.0.1:<port>。**没有**模拟、**没有**子进程、
/// **没有**「把 Linux 二进制当资源」那一套。
///
/// # 早期错误架构（已废弃，留作教训）
/// 曾把引擎编成 i686 Linux ELF，塞进 iSH 里 `do_execve` 拉起。两个致命问题：
///   1. 引擎全程跑在 x86 解释器里 —— 性能损失一个数量级；
///   2. 引擎与 iSH 内核强耦合，iSH 起不来引擎就完全不可用。
/// 而 iSH 本是 proot 的替代品（只提供 shell 工具），不该承担跑引擎的职责。
///
/// # 与 iSH 的关系
/// **完全解耦**：引擎先起（原生，秒级），iSH 后起（可选）。
/// iSH 起不来时引擎照常工作，只是 AI 不能执行 shell 命令。
@MainActor
final class EngineController: ObservableObject {

    enum State: Equatable {
        case idle
        case launching
        case ready(port: Int, token: String)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var engineVersion: String = ""

    /// 引擎 home 目录（配置、记忆、会话都在这）。
    nonisolated static var homeURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("coomi-home", isDirectory: true)
    }

    /// 工作目录（AI 读写文件、执行命令的默认位置）。
    nonisolated static var workspaceURL: URL {
        homeURL.appendingPathComponent("workspace", isDirectory: true)
    }

    private var launchTask: Task<Void, Never>?
    /// 已用过的 token。
    ///
    /// 必须留住：引擎用 `coomi_start` 时的那个 token 校验所有请求，
    /// 重启路径若重新生成，健康检查会一直 401（看起来像"引擎起不来"，极难查）。
    private var issuedToken: String?

    /// 是否已经成功调过 `coomi_start`。
    ///
    /// 进程内引擎只能起一次：重复 `coomi_start` 会返回 -3（已启动）。
    /// 所以重入时走 `coomi_port()` 取回端口，而不是再起一遍。
    /// 与 `issuedToken` 配套 —— 端口和 token 必须成对复用，
    /// 否则健康检查会一直 401。
    private var didStartEngine = false

    init() {
        // 进程内只需启动一次；重复调用 coomi_start 会返回 -3。
    }

    func ensureRunning() {
        if case .ready = state { return }
        if case .launching = state { return }

        state = .launching
        launchTask?.cancel()
        launchTask = Task { [weak self] in
            guard let self else { return }

            // ① 准备 home / workspace。
            for dir in [Self.homeURL, Self.workspaceURL] {
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                } catch {
                    self.state = .failed("无法创建目录 \(dir.lastPathComponent)：\(error.localizedDescription)")
                    return
                }
            }

            // ② 把打进 Bundle 的前端产物同步到 home/web。
            //
            // 引擎用 `ServeDir::new(home/web)` 提供页面（见 ios_ffi.rs 的
            // `static_dir = home.join("web")`），它只认这个**可写**路径 ——
            // 不能直接让 ServeDir 指向 Bundle：App 沙盒里的 Bundle 是只读的，
            // 而引擎还会往静态目录旁写运行时文件。
            //
            // 首次启动必然要拷；升级后也要拷 —— 否则用户一直看到旧壳
            // （Vite 产物的 /assets/* 带内容 hash，旧 index.html 会引用已删文件）。
            // 所以判据是「Bundle 里的构建比 home 里的新」，不是「home 里没有」。
            if let syncError = Self.syncWebAssets() {
                self.state = .failed(syncError)
                return
            }

            // ③ 起引擎（原生 C ABI，阻塞到 tokio 起来即返回端口）。
            //
            // 已启动过时要复用**同一个 token**：引擎只认启动时那个。
            let token = self.issuedToken ?? Self.makeToken()
            self.issuedToken = token

            let port: Int32
            if self.didStartEngine {
                // 已启动过：直接问端口，不重复起。
                port = Int32(coomi_port())
            } else {
                port = coomi_start(
                    Self.homeURL.path,
                    Self.workspaceURL.path,
                    token
                )
                if port > 0 { self.didStartEngine = true }
            }

            guard port > 0 else {
                self.state = .failed(Self.describeStartFailure(port))
                return
            }

            // ④ 健康检查：进程起来了不等于 HTTP 可用（可能还在加载 provider 配置）。
            let ok = await Self.waitForHealth(port: Int(port), token: token, timeout: 60)
            if Task.isCancelled { return }

            if ok {
                self.engineVersion = await Self.fetchVersion(port: Int(port), token: token) ?? ""
                self.state = .ready(port: Int(port), token: token)
            } else {
                self.state = .failed("引擎未在 60 秒内就绪（端口 \(port)）。详见 App 日志。")
            }
        }
    }

    func stop() {
        // 原位停止：tokio 运行时随进程退出，这里只清 UI 状态。
        // 真要停止需引擎侧提供 C ABI，当前不做（iOS 生命周期由系统管理）。
        launchTask?.cancel()
        state = .idle
    }

    /// 把 `coomi_start` 的负返回值翻成人话。
    private static func describeStartFailure(_ code: Int32) -> String {
        switch code {
        case -1: return "引擎启动失败：参数非法（home 目录不可写？）"
        case -2: return "引擎启动失败：端口分配失败"
        case -3: return "引擎已在启动中"
        default: return "引擎启动失败（coomi_start 返回 \(code)）"
        }
    }

    // MARK: - 前端资源

    /// 把 App 包里的前端产物同步到 `home/web`，返回错误描述（成功返回 nil）。
    ///
    /// 引擎的 `ServeDir` 指向 `home/web`，所以这个目录必须真实存在且是最新的。
    /// Bundle 里放在 `web/` 子目录（见 project.yml 的 Resources 映射）；
    /// 老包里前端是**平铺**的，所以两种布局都兜一下。
    private static func syncWebAssets() -> String? {
        let fm = FileManager.default
        let dest = homeURL.appendingPathComponent("web", isDirectory: true)

        // 找出 Bundle 里的前端根目录。
        // 优先 `web/`（当前 project.yml 的布局），退而求其次用 Bundle 根
        // （老布局把 index.html 平铺在 .app 里）。
        let bundled: URL?
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            bundled = url.deletingLastPathComponent()
        } else if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            bundled = url.deletingLastPathComponent()
        } else {
            bundled = nil
        }

        guard let source = bundled else {
            // 没打包前端时不要伪装成功：给出可诊断的说法。
            // 本地开发（只编 Swift）会遇到这个，属于预期。
            return "App 包内缺少前端产物（index.html）。"
                + "请在 apps/web 跑 `npm run build` 后重新打包。"
        }

        // 版本判据：比较 Bundle 与 home 里 index.html 的**内容**。
        //
        // 不能用修改时间：.app 里的资源时间戳在打包/安装过程中会被归一化
        // （同一构建内经常全变成同一时刻），拿它比较会导致「前端升级了但
        // 用户看到旧壳」—— 而 Vite 的 /assets/* 带内容 hash，旧 index.html
        // 引用的文件已经不存在，表现就是白屏。
        //
        // index.html 很小（约 1 KB），读进来比哈希的开销可以忽略。
        let srcIndex = source.appendingPathComponent("index.html")
        let dstIndex = dest.appendingPathComponent("index.html")
        if let srcData = try? Data(contentsOf: srcIndex),
           let dstData = try? Data(contentsOf: dstIndex),
           srcData == dstData {
            return nil  // 内容一致，不必重拷
        }

        do {
            if fm.fileExists(atPath: dest.path) {
                try fm.removeItem(at: dest)
            }
            try fm.createDirectory(at: dest, withIntermediateDirectories: true)
            for item in try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) {
                try fm.copyItem(at: item, to: dest.appendingPathComponent(item.lastPathComponent))
            }
        } catch {
            return "无法准备前端资源：\(error.localizedDescription)"
        }
        return nil
    }

    // MARK: - token

    /// 一次性 token：不落盘、每次不同。
    ///
    /// 引擎监听 127.0.0.1，同机其它 App 理论上也能连；
    /// 有 token 才能保证「只有本 App 能调」。
    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            let stamp = String(Int(Date().timeIntervalSince1970 * 1000))
            bytes = Array(stamp.utf8)
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - 健康检查

    nonisolated static func waitForHealth(
        port: Int,
        token: String,
        timeout: TimeInterval
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if await probeHealth(port: port, token: token) { return true }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return false
    }

    nonisolated static func probeHealth(port: Int, token: String) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/runtime/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    nonisolated static func fetchVersion(port: Int, token: String) async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/runtime/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["version"] as? String
    }
}

// MARK: - 引擎 C ABI
//
// 由 `apps/coomi-rs/ui/src/ios_ffi.rs` 导出（`#[unsafe(no_mangle)] pub extern "C"`）。
// 静态库 `libcoomi_ui.a` 在 `apps/ios/ThirdParty/engine/`。
//
// 集中放在 `EngineRuntime` 里而不是散落成 private 顶层函数：
// `Readiness.swift` 也要判断「引擎有没有链进来」，
// private 顶层函数跨文件不可见（CI 上踩过 "cannot find xxx in scope"）。

enum EngineRuntime {
    /// 引擎静态库是否已链接。
    ///
    /// 判据是 `coomi_version()` 能调到 —— 静态库是编译期产物，
    /// 运行期没有文件可查，只能看符号在不在。
    static var isLinked: Bool {
        return version() != nil
    }

    /// 引擎版本号（未链接返回 nil）。
    static func version() -> String? {
        let ptr = coomi_version()
        guard let ptr else { return nil }
        let str = String(cString: ptr)
        return str.isEmpty ? nil : str
    }
}

/// 启动引擎，返回监听端口；负数表示失败。
@_silgen_name("coomi_start")
func coomi_start(
    _ home: UnsafePointer<CChar>,
    _ cwd: UnsafePointer<CChar>,
    _ token: UnsafePointer<CChar>
) -> Int32

/// 已监听端口（未启动返回 0）。
@_silgen_name("coomi_port")
func coomi_port() -> UInt16

/// 引擎版本号（C 字符串，静态生命周期）。
@_silgen_name("coomi_version")
func coomi_version() -> UnsafePointer<CChar>?
