import Foundation

/// 首次启动的就绪诊断。
///
/// # 为什么需要它
/// iOS 侧要跑起来，需要的东西分两类：
///
/// **阻塞项**（缺了引擎就起不来）
///   1. **引擎静态库** —— `libcoomi_ui.a`，编译期链接，运行期用 `coomi_start()` 起
///   2. **可写的 home / workspace 目录**
///
/// **可选·缺失**（缺了照样能用，只是功能变少）
///   3. **iSH 运行时** —— `libish.a` + rootfs，决定 AI 能不能执行 shell 命令
///
/// # 为什么这么分
/// 早期版本把 iSH 也当阻塞项，导致「没链接 libish 就完全不可用」。
/// 但 iSH 在架构里等价于安卓的 **proot** —— 它只是**工作环境**，
/// 而引擎（`EngineController`）是原生 aarch64，压根不依赖它。
/// 把它们分成两条独立路径后：iSH 缺失 → 只剩 shell 工具不可用，对话/记忆/联网全正常。
///
/// # 关于「引擎二进制」
/// 旧版这里检查的是一个 i686 Linux ELF 资源文件 —— 那是「把引擎塞进 iSH 跑」的
/// 错误架构留下的。正确做法是引擎编成 aarch64-apple-ios 静态库**链进 App**，
/// 所以这里改成检查 C 符号是否可用（`coomi_start` 存在 = 静态库链进来了）。
struct ReadinessReport {
    struct Item {
        let id: String
        let title: String
        let detail: String
        let isReady: Bool
        /// 缺失是否阻止启动。
        ///
        /// `false` 的项在界面上显示成「可选·缺失」，且不参与 `canStart` 判定。
        let isBlocking: Bool
        /// 缺失时怎么补（为空表示无需操作）。
        let remedy: String?
    }

    let items: [Item]

    /// 全部**阻塞项**就绪才允许启动引擎。
    var canStart: Bool { items.filter(\.isBlocking).allSatisfy(\.isReady) }

    /// 可选但缺失的项。
    var degraded: [Item] { items.filter { !$0.isBlocking && !$0.isReady } }

    /// 一句话摘要，供首启页顶部显示。
    var summary: String {
        if canStart {
            if degraded.isEmpty { return "运行时已就绪，可以启动引擎。" }
            let names = degraded.map(\.title).joined(separator: "、")
            return "可以启动引擎；另有可选组件缺失（\(names)）。"
        }
        let n = items.filter(\.isBlocking).filter { !$0.isReady }.count
        return "缺少 \(n) 项必需组件，引擎暂时无法启动。"
    }
}

enum ReadinessChecker {

    /// 逐项检查。纯本地判断，不发网络请求，可在 `onAppear` 直接调用。
    static func check() -> ReadinessReport {
        var items: [ReadinessReport.Item] = []

        // ① 引擎静态库：`coomi_version()` 能调到就说明链进来了。
        //
        //    直接调而不是查文件：静态库是编译期产物，运行期无文件可查。
        //    这个函数极轻（返回一个常量指针），不会阻塞。
        let engineLinked = EngineRuntime.isLinked
        items.append(.init(
            id: "engine",
            title: "Coomi 引擎（原生静态库）",
            detail: engineLinked
                ? "已链接 libcoomi_ui.a，引擎将在进程内以 aarch64 原生运行。"
                : "未链接 libcoomi_ui.a。App 无法启动引擎。",
            isReady: engineLinked,
            isBlocking: true,
            remedy: engineLinked ? nil :
                "需要把 Rust 引擎编成 iOS 静态库并链进 target：\n"
                + "① 在 macOS 上 `rustup target add aarch64-apple-ios`\n"
                + "② `cargo build -p coomi-ui --target aarch64-apple-ios --release`\n"
                + "③ 把 libcoomi_ui.a 放到 apps/ios/ThirdParty/engine/\n"
                + "（CI 的 engine job 会自动做这三步）"
        ))

        // ② home 目录可写：引擎要建配置、记忆、会话库。
        let homeOK = checkHomeWritable()
        items.append(.init(
            id: "home",
            title: "数据目录",
            detail: homeOK
                ? "Documents/coomi-home 可写。"
                : "无法创建或写入 Documents/coomi-home。",
            isReady: homeOK,
            isBlocking: true,
            remedy: homeOK ? nil : "通常是存储空间不足。清理后重启 App。"
        ))

        // ③ iSH 运行时：可选。
        let ishReady = ISHRuntime.available()
        items.append(.init(
            id: "ish",
            title: "iSH 运行时（shell 工具）",
            detail: ishReady
                ? "已链接 libIshKernel.a，Linux 内核可用。"
                : "未链接 libIshKernel.a。AI 不能执行 shell 命令，其余功能正常。",
            isReady: ishReady,
            isBlocking: false,
            remedy: ishReady ? nil :
                "需要把 iSH 编成静态库并加入工程：\n"
                + "① `git clone --recursive https://github.com/Lolendor/ish-arm64-pkg`\n"
                + "② `xcodebuild -scheme IshEmbed -sdk iphoneos -arch arm64`\n"
                + "③ 把 libIshKernel.xcframework 放入 apps/ios/ThirdParty/ish/，"
                + "并把 build setting 的 COOMI_HAS_ISH 设为 1"
        ))

        // ④ Linux 用户态：可选，且只有链接了 iSH 才有意义。
        if ishReady {
            // 路径换算：fakefs 里 guest 的 `/x` 落在宿主 `<root>/data/x`。
            // （实测归档内部是 `fs/data/bin/sh`，解包提升一层后 = `<root>/data/bin/sh`。）
            //
            // 老写法查的是 `<root>/bin/sh` —— 那个路径**永远不存在**，
            // 于是即使 rootfs 已经完整铺好，这一项也一直报「缺失」。
            let root = ISHBridge.shared.linuxRootURL
            let fm = FileManager.default
            let shell = fm.fileExists(atPath: root.appendingPathComponent("data/bin/sh").path)
            let supervisor = fm.fileExists(atPath: root.appendingPathComponent("data/sbin/ishsv").path)
            let meta = fm.fileExists(atPath: root.appendingPathComponent("meta.db").path)
            let rootfsReady = shell && supervisor && meta

            var missing: [String] = []
            if !meta { missing.append("meta.db") }
            if !supervisor { missing.append("data/sbin/ishsv") }
            if !shell { missing.append("data/bin/sh") }

            items.append(.init(
                id: "rootfs",
                title: "Linux 用户态（rootfs）",
                detail: rootfsReady
                    ? "fakefs 已铺好：meta.db + /sbin/ishsv + /bin/sh 都在。"
                    : "尚未解包，或解包不完整（缺 \(missing.joined(separator: "、"))）。",
                isReady: rootfsReady,
                isBlocking: false,
                remedy: rootfsReady ? nil :
                    "打包时把 `linux-rootfs.tar.gz` 放进 CoomiApp/Resources，"
                    + "App 首次启动会在宿主侧解包（boot 之前必须铺好）。"
            ))

            // ⑤ boot 的实测结果：这是整个集成里唯一无法靠静态检查证明的一环。
            let report = ISHBridge.shared.lastBootReport
            items.append(.init(
                id: "ish-boot",
                title: "Linux 内核启动（实测）",
                detail: report?.summary ?? "尚未尝试启动（App 启动时会自动跑一次）。",
                isReady: report?.isFullyWorking ?? false,
                isBlocking: false,
                remedy: (report?.isFullyWorking ?? false) ? nil :
                    "在启动页/iSH 诊断卡上展开「详情」可看到 boot 返回码与自检输出；"
                    + "常见：-2 挂载失败(fakefs 格式)、-6 supervisor 起不来、"
                    + "-12 超时、-15 supervisor 报错。"
            ))
        }

        return ReadinessReport(items: items)
    }

    /// 探一下 home 目录能不能写。
    ///
    /// 单纯 `isWritableFile` 在 iOS 上不可靠（沙箱容器可能刚建好），
    /// 直接写一个探针文件更实在。
    private static func checkHomeWritable() -> Bool {
        let home = EngineController.homeURL
        do {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            let probe = home.appendingPathComponent(".write-probe")
            try Data("ok".utf8).write(to: probe)
            try? FileManager.default.removeItem(at: probe)
            return true
        } catch {
            return false
        }
    }
}
