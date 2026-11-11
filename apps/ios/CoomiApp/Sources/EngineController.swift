import Foundation
import Security

/// 引擎（`coomi serve`）的生命周期管理 —— **进程内**运行。
///
/// # 架构（这一版重写的关键）
/// 引擎跑在 **Coomi App 自己的进程里**，通过内嵌的 iSH Linux 内核
/// （`xX_main_Xx()` 初始化 → `do_execve()` → `task_start()`）执行 `coomi serve`。
///
/// 为什么不能用「拉起外部 iSH App」那套（早期版本的做法）：
///   1. **iOS 会挂起后台 App**。Coomi 在前台时 iSH 必然在后台 → 几秒后被 suspend
///      → 引擎停摆、socket 断开。这不是配置问题，是平台约束，无法绕过。
///   2. 两个 App 之间没有管道/信号，只能靠 `ish://run?cmd=` 盲发命令 + 轮询 HTTP，
///      既无法感知引擎退出，也无法优雅停止。
///   3. 用户还得手动装 iSH、手动拷二进制，体验不可接受。
///
/// 所以正确做法只有一个：**把 iSH 内核作为静态库编进 Coomi App**，
/// 由 App 自己 fork/exec 一个 Linux 进程跑引擎 —— 单进程、单 App、无跨 App 挂起。
///
/// # 与 Rust 的关系
/// Rust 引擎**不参与 iOS 的目标编译**（不需要 `aarch64-apple-ios` 工具链）。
/// App 里跑的是**已经编译好的 i686 Linux 二进制**，由 iSH 模拟执行。
/// 换句话说：`coomi` 二进制是 App 的一个资源文件，不是 App 的一部分。
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

    /// Linux 侧路径（App 沙箱内的映射，见 `ISHBridge`）。
    nonisolated static let enginePathInLinux = "/usr/local/bin/coomi"
    nonisolated static let homePathInLinux = "/root/.coomi"
    nonisolated static let staticPathInLinux = "/root/.coomi/web"

    private var launchTask: Task<Void, Never>?

    func ensureRunning() {
        if case .ready = state { return }
        if case .launching = state { return }

        let port = Self.pickPort()
        let token = Self.makeToken()
        state = .launching

        launchTask?.cancel()
        launchTask = Task { [weak self] in
            guard let self else { return }

            // ① 让 iSH 内核初始化（幂等：只做一次）。
            //    这一步等价于 iSH App 的 main()：挂 proc/devpts、建设备节点。
            if let error = ISHBridge.shared.boot() {
                self.state = .failed("Linux 运行时初始化失败：\(error)")
                return
            }

            // ② 把引擎二进制与前端从 App 资源解包到 Linux 根文件系统（仅首次）。
            if let error = ISHBridge.shared.installRuntimeIfNeeded(
                engineResource: "coomi",
                webResource: "web"
            ) {
                self.state = .failed("运行时安装失败：\(error)")
                return
            }

            // ③ 在 Linux 侧启动 `coomi serve`。
            do {
                try ISHBridge.shared.spawnProbe(port: port, token: token)
            } catch {
                self.state = .failed("启动引擎失败：\(error.localizedDescription)")
                return
            }

            // ④ 健康检查：这是**唯一**可信的就绪判据。
            //    Linux 进程起来了不等于 HTTP 可用（可能还在加载 provider 配置）。
            let ok = await Self.waitForHealth(port: port, token: token, timeout: 90)
            if Task.isCancelled { return }
            if ok {
                self.engineVersion = await Self.fetchVersion(port: port, token: token) ?? ""
                self.state = .ready(port: port, token: token)
            } else {
                self.state = .failed("引擎未在 90 秒内就绪。详见 App 内的引擎日志。")
            }
        }
    }

    func stop() {
        launchTask?.cancel()
        ISHBridge.shared.terminateEngine()
        state = .idle
    }

    // MARK: - 端口 / token

    /// 随机端口：避免与上次残留的引擎冲突（固定端口会「连到旧引擎」）。
    private static func pickPort() -> Int {
        Int.random(in: 20000...40000)
    }

    /// 一次性 token：不落盘、每次不同。
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
            try? await Task.sleep(nanoseconds: 500_000_000)
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
