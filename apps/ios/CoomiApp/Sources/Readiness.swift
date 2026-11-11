import Foundation

/// 首次启动的就绪诊断。
///
/// # 为什么需要它
/// iOS 侧要跑起来，必须凑齐三样东西：
///   1. **iSH 运行时**（内嵌静态库 `libish.a`，编译期决定）
///   2. **Linux rootfs**（`linux-rootfs.tar.gz`，App 资源）
///   3. **引擎二进制**（`coomi`，i686 Linux ELF，App 资源）
///
/// 任何一样缺失，引擎都起不来。原来的实现只会在失败时抛一句模糊的话
/// （"找不到引擎二进制"），用户不知道该干什么。
///
/// 这个诊断器把"缺什么、怎么补"逐项列出来，让首启页能直接显示可执行的指引 ——
/// **iOS 没有 proot，也不会在首次启动时部署什么**，所以这里的失败都是
/// "产物没打进 App"，而不是"部署过程崩了"。
struct ReadinessReport {
    struct Item {
        let id: String
        let title: String
        let detail: String
        let isReady: Bool
        /// 缺失时怎么补（为空表示无需操作）。
        let remedy: String?
    }

    let items: [Item]

    /// 全部就绪才允许启动引擎。
    var isReady: Bool { items.allSatisfy(\.isReady) }
    var missing: [Item] { items.filter { !$0.isReady } }

    /// 一句话摘要，供首启页顶部显示。
    var summary: String {
        if isReady { return "运行时已就绪，可以启动引擎。" }
        return "缺少 \(missing.count) 项运行时组件，引擎暂时无法启动。"
    }
}

enum ReadinessChecker {

    /// 逐项检查。纯本地文件/符号判断，不发网络请求，可在 `onAppear` 直接调用。
    static func check() -> ReadinessReport {
        var items: [ReadinessReport.Item] = []

        // ① iSH 运行时：由 C 桥接层告诉我们有没有链接进来。
        //    `ish_available()` 在未链接 libish 时返回 false（桩实现）。
        let ishReady = ISHRuntime.available()
        items.append(.init(
            id: "ish",
            title: "iSH 运行时",
            detail: ishReady
                ? "已链接 libish，进程内 Linux 内核可用。"
                : "未链接 libish。App 能启动，但无法执行任何 Linux 程序。",
            isReady: ishReady,
            remedy: ishReady ? nil :
                "需要把 iSH 编成静态库并加入工程：\n"
                + "① 在 Mac 上 `git clone --recursive` iSH\n"
                + "② `xcodebuild -target libish -sdk iphoneos`\n"
                + "③ 把 libish.a 加入 target，并把 build setting 里的 "
                + "COOMI_HAS_ISH 设为 1"
        ))

        // ② Linux rootfs：解包后目录里要有 /bin/sh。
        let rootfsReady = FileManager.default.fileExists(
            atPath: ISHBridge.shared.linuxRootURL
                .appendingPathComponent("bin/sh").path
        )
        items.append(.init(
            id: "rootfs",
            title: "Linux 用户态（rootfs）",
            detail: rootfsReady
                ? "rootfs 已解包，/bin/sh 存在。"
                : "尚未解包 rootfs，或解包不完整（缺少 /bin/sh）。",
            isReady: rootfsReady,
            remedy: rootfsReady ? nil :
                "需要把 `linux-rootfs.tar.gz` 放进 App 资源：\n"
                + "运行 apps/ios/CoomiApp/Scripts/build-ios-runtime.sh，"
                + "把产出的 linux-rootfs.tar.gz 拖进 Xcode 的 CoomiApp/Resources。"
        ))

        // ③ 引擎二进制。
        let enginePath = ISHBridge.shared.engineBinaryURL
        let engineReady = FileManager.default.fileExists(atPath: enginePath.path)
        items.append(.init(
            id: "engine",
            title: "Coomi 引擎（i686 Linux）",
            detail: engineReady
                ? "引擎二进制已就位。"
                : "App 资源里没有 `coomi`。",
            isReady: engineReady,
            remedy: engineReady ? nil :
                "同一个脚本会一并产出 coomi：\n"
                + "sh build-ios-runtime.sh  →  把 coomi 拖进 CoomiApp/Resources。\n"
                + "（这个二进制是 i686 Linux ELF，由 iSH 模拟执行，"
                + "不是 iOS 原生二进制。）"
        ))

        return ReadinessReport(items: items)
    }
}
