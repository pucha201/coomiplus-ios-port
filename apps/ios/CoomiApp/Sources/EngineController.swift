import Foundation
import Security

/// Coomi 引擎的 iOS 原生控制器。
///
/// # 架构（这一版是**正确**的分层）
///
/// | 层 | 谁 | 说明 |
/// |---|---|---|
/// | **引擎** | Rust 原生（`libcoomi_ui.a`，aarch64） | 会话/记忆/模型/文件/HTTP，全部原生 |
/// | **工作环境** | iSH（`ISHBridge`） | 只在需要 shell/git/python 时使用 |
///
/// 这与 Android 完全同构：安卓是「原生引擎 + proot 工作环境」，
/// iOS 是「原生引擎 + iSH 工作环境」。
///
/// # 之前错在哪
/// 早期版本把**引擎也塞进 iSH**：
/// ```
/// App → ISHBridge → do_execve("coomi serve") → iSH 里跑 i686 引擎
/// ```
/// 代价是：需要 i686 rootfs、22MB 引擎塞进 IPA、性能只剩 10–20%。
/// 现在引擎是**原生 ARM64**，直接链接进 App，进程内运行。
///
/// # 为什么引擎要在独立线程
/// `coomi_start` 内部会建 tokio 多线程运行时并 `block_on(serve(...))`。
/// 若在 SwiftUI 主线程调用，会立刻卡住 UI 并触发 watchdog。
/// 所以 Rust 侧负责起线程，Swift 侧只拿端口、然后轮询健康检查。
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

    /// 一次性令牌：不落盘、每次启动都不同。
    ///
    /// 即使引擎只监听 127.0.0.1，同设备上的其它进程也能访问那个端口；
    /// 用随机令牌把「本机任意 App 都能调引擎」变成「只有知道令牌的才能调」。
    private var token: String = ""
    private var launchTask: Task<Void, Never>?

    /// 数据目录：`<Documents>/coomi-home`。
    ///
    /// 用 Documents 而不是 Caches：会话与记忆是用户资产，
    /// Caches 会被系统在空间紧张时清掉。
    static var homeURL: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("coomi-home", isDirectory: true)
    }

    /// 工作目录：让模型的相对路径落在一个可预期的位置。
    static var cwdURL: URL {
        homeURL.appendingPathComponent("workspace", isDirectory: true)
    }

    // MARK: - 启动

    func ensureRunning() {
        if case .ready = state { return }
        if case .launching = state { return }

        state = .launching
        token = Self.makeToken()

        launchTask?.cancel()
        launchTask = Task { [weak self] in
            guard let self else { return }

            // ① 目录就位：Rust 侧会往里写 config/sessions/memory，
            //    但目录本身要先存在（否则首次启动的 create_dir_all 在
            //    iOS 沙箱里可能因父目录不存在而失败）。
            do {
                try FileManager.default.createDirectory(
                    at: Self.homeURL, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(
                    at: Self.cwdURL, withIntermediateDirectories: true)
            } catch {
                self.state = .failed("无法创建数据目录：\(error.localizedDescription)")
                return
            }

            // ② 调 Rust 启动引擎，拿端口。
            let port = Self.startEngine(
                home: Self.homeURL.path,
                cwd: Self.cwdURL.path,
                token: self.token
            )
            guard port > 0 else {
                self.state = .failed(Self.describeStartFailure(port))
                return
            }

            // ③ 健康检查：端口拿到 ≠ HTTP 可用。
            //    Rust 侧是先占端口再起服务，两者之间有个窗口。
            let ok = await Self.waitForHealth(port: port, token: self.token, timeout: 60)
            if Task.isCancelled { return }
            if ok {
                self.engineVersion = await Self.fetchVersion(port: port, token: self.token) ?? ""
                self.state = .ready(port: port, token: self.token)
            } else {
                self.state = .failed("引擎未在 60 秒内就绪（端口 \(port)）")
            }
        }
    }

    func stop() {
        launchTask?.cancel()
        // Rust 侧的引擎线程随进程退出而结束；iOS 没有"停服务"的公开接口，
        // 且 App 被系统回收时整进程都在，所以这里只重置状态。
        state = .idle
    }

    private static func describeStartFailure(_ code: Int32) -> String {
        switch code {
        case -1: return "引擎启动失败：参数非法（路径或令牌含非法字符）"
        case -2: return "引擎启动失败：无法分配本地端口"
        case -3: return "引擎已在启动中；若长时间无响应请重启 App"
        default: return "引擎启动失败（错误码 \(code)）"
        }
    }

    // MARK: - 令牌

    /// 32 字节随机 → base64url。不落盘。
    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            // 极端回退：仍然每次不同，只是熵低一些。
            bytes = Array(String(Int(Date().timeIntervalSince1970 * 1000)).utf8)
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Rust FFI

    /// 调 `coomi_start` 启动引擎，返回端口（>0）或错误码（<0）。
    private static func startEngine(home: String, cwd: String, token: String) -> Int32 {
        home.withCString { homePtr in
            cwd.withCString { cwdPtr in
                token.withCString { tokenPtr in
                    coomi_start(homePtr, cwdPtr, tokenPtr)
                }
            }
        }
    }

    // MARK: - 健康检查

    static func waitForHealth(port: Int, token: String, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if await probeHealth(port: port, token: token) { return true }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return false
    }

    static func probeHealth(port: Int, token: String) async -> Bool {
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

    static func fetchVersion(port: Int, token: String) async -> String? {
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

// MARK: - Rust C ABI 声明
//
// 这些符号由 `apps/coomi-rs/ui/src/ios_ffi.rs` 提供，
// 通过 `libcoomi_ui.a` 静态链接进来。
//
// 返回值约定：
//   coomi_start  > 0 = 端口，-1 参数非法，-2 端口分配失败，-3 已在启动
//   coomi_port   当前端口（0 = 未就绪/已退出）

@_silgen_name("coomi_start")
private func coomi_start(
    _ home: UnsafePointer<CChar>,
    _ cwd: UnsafePointer<CChar>,
    _ token: UnsafePointer<CChar>
) -> Int32

@_silgen_name("coomi_port")
private func coomi_port() -> UInt16

@_silgen_name("coomi_version")
private func coomi_version() -> UnsafePointer<CChar>
