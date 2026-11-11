import Foundation

/// 首次启动的就绪诊断。
///
/// # 检查项随架构调整过
///
/// **旧**（引擎跑在 iSH 里）：需要 libish.a + rootfs + i686 引擎三样。
///
/// **新**（引擎原生）：
/// - **引擎**：编译期链接进主二进制，**运行时不可能缺失** —— 所以不再检查；
/// - **前端产物**：需要在 bundle 里（决定界面能否显示）；
/// - **工作环境（iSH + rootfs）**：**可选**，缺了只是 shell 工具不可用，
///   对话/记忆/文件读写全部照常。
///
/// 这个区分很重要：早期版本把「工作环境缺失」当成致命错误拦在启动前，
/// 但引擎根本不依赖它 —— 那会让一个本可正常使用的 App 卡在引导页。
struct ReadinessReport {
    struct Item {
        let id: String
        let title: String
        let detail: String
        let isReady: Bool
        /// 缺失时怎么补；nil 表示无需操作。
        let remedy: String?
        /// 是否是**致命**项（缺失则引擎起不来）。
        /// 非致命项只影响部分能力，不该拦住启动。
        let isBlocking: Bool
    }

    let items: [Item]

    /// 致命项全部就绪即可启动。
    var canStart: Bool {
        items.filter(\.isBlocking).allSatisfy(\.isReady)
    }

    /// 全部就绪（含可选项）。
    var allReady: Bool { items.allSatisfy(\.isReady) }

    /// 一句话摘要。
    var summary: String {
        if allReady { return "全部就绪，可以启动引擎。" }
        if canStart { return "引擎可以启动；工作环境（shell 等）暂不可用。" }
        let missing = items.filter { $0.isBlocking && !$0.isReady }
        return "缺少 \(missing.count) 项必要组件，无法启动引擎。"
    }
}

enum ReadinessChecker {

    /// 逐项检查。纯本地判断，不发网络请求。
    static func check() -> ReadinessReport {
        var items: [ReadinessReport.Item] = []

        // ① 引擎：编译期链接。
        //
        // 这里**没有运行时文件可查** —— 符号在启动时就已链接进主二进制。
        // 若真的没链接，App 根本起不来（缺符号会在 dyld 阶段报错），
        // 不会走到这个界面。所以固定为就绪，只把版本号显示出来供诊断。
        let version = String(cString: coomi_version())
        items.append(.init(
            id: "engine",
            title: "Coomi 引擎（原生 ARM64）",
            detail: "已链接进 App，版本 \(version)。随 App 启动，无需额外部署。",
            isReady: true,
            remedy: nil,
            isBlocking: true
        ))

        // ② 前端产物：决定界面能否显示。
        let webIndex = EngineController.homeURL.appendingPathComponent("web/index.html")
        let bundledWeb = Bundle.main.url(forResource: "web", withExtension: nil)
        let webReady = bundledWeb != nil
            || FileManager.default.fileExists(atPath: webIndex.path)
        items.append(.init(
            id: "web",
            title: "界面资源",
            detail: webReady
                ? "前端产物已打包进 App。"
                : "App 里没有前端产物，界面将无法显示。",
            isReady: webReady,
            remedy: webReady ? nil :
                "在 CI/本地执行：\n"
                + "  cd apps/web && npm ci && npx vite build\n"
                + "  cp -R dist/. ../ios/CoomiApp/Resources/web/",
            isBlocking: true
        ))

        // ③ iSH 运行时：**可选**。
        let ishReady = ISHRuntime.available()
        items.append(.init(
            id: "ish",
            title: "Linux 工作环境（iSH）",
            detail: ishReady
                ? "iSH 内核已链接。"
                : "未链接 iSH。shell / git / python 类工具不可用，其余功能正常。",
            isReady: ishReady,
            remedy: ishReady ? nil :
                "这是**可选**组件（对应安卓的 proot）。\n"
                + "需要 shell 工具时：在 Mac 上编出 libish.a，\n"
                + "放进 ThirdParty/ish/build/ 并在 project.yml 里打开 -lish。",
            isBlocking: false
        ))

        // ④ rootfs：同样**可选**，且只有链接了 iSH 才有意义。
        let userlandReady = ISHBridge.shared.isUserlandReady
        items.append(.init(
            id: "userland",
            title: "Linux 用户态（rootfs）",
            detail: userlandReady
                ? "rootfs 已就绪，/bin/sh 存在。"
                : "未安装 rootfs。工作环境不可用。",
            isReady: userlandReady,
            remedy: userlandReady ? nil :
                "可选组件。需要时把 linux-rootfs.tar.gz 放进 CoomiApp/Resources/。\n"
                + "运行 Scripts/build-ios-runtime.sh 可产出（只需 sh/git/python，不含引擎）。",
            isBlocking: false
        ))

        return ReadinessReport(items: items)
    }
}

// 引擎版本符号来自 Rust FFI。
@_silgen_name("coomi_version")
private func coomi_version() -> UnsafePointer<CChar>
