import SwiftUI

@main
struct CoomiApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(nil)
        }
    }
}

/// 根视图：把「引擎状态」映射成界面。
///
/// # 状态机的设计取舍
/// 只有四条状态（idle → launching → ready / failed），因为 iSH 这一层
/// 观测不到进程，**唯一可信信号是 HTTP 可达**。过度设计的状态机在没有
/// 真实信号时会变成假象。
///
/// # 首次启动为什么要有独立引导页
/// 引擎起不来有且只有三种原因：缺 iSH 运行时、缺 rootfs、缺引擎二进制。
/// 它们都是**打包时漏了产物**，不是"部署过程崩了"——
/// iOS 侧根本没有 proot，也不在运行时部署任何东西。
/// 所以首启页要把这三项逐条列出来，让用户看得懂、修得动，
/// 而不是只给一句"启动失败"。
struct RootView: View {
    @StateObject private var engine = EngineController()
    @State private var loadError: String?
    @State private var readiness: ReadinessReport?
    /// iSH 的启动结果。nil = 还没试过。
    ///
    /// 保留在 `@State` 而不是只 NSLog：iOS 上不能 fork/exec，用户也很难
    /// 连电脑看 Console.app，所以 `ish_embed_boot` 到底成没成，
    /// 必须能在屏幕上直接看到 —— 这是整个 iSH 集成唯一没验证过的一环。
    @State private var ishReport: ISHBootReport?
    /// iSH 是否正在启动（用于界面提示）。
    @State private var ishStarting = false
    @Environment(\.scenePhase) private var scenePhase

    /// 起 iSH 工作环境（可选路径，失败不影响引擎）。
    ///
    /// # 为什么放后台
    /// 首次运行要解包 856 个文件的 fakefs，随后 `ish_embed_boot` 起来、
    /// 再跑一条带 20s 超时的自检命令 —— 最坏情况会在主线程上卡二十几秒。
    /// 在 `onAppear` 里同步做，界面会整个冻住，还有触发 watchdog 的风险。
    /// 所以丢到后台队列，结果回主线程更新 `@State`。
    ///
    /// # 为什么用串行队列而不是 Task.detached
    /// iSH 的 `ish_embed_*` 是同步 C 接口，内部自己管线程；调用方只需保证
    /// **不并发调**（重复 boot 会返回 -10）。串行队列天然满足这一点，
    /// 而且 `ISHBridge` 内部还有 NSLock 兜底。
    private func startUserland() {
        guard !ishStarting, ishReport == nil else { return }  // 只试一次
        ishStarting = true

        DispatchQueue(label: "coomi.ish.boot", qos: .userInitiated).async {
            let report = ISHBridge.shared.bootWithReport()
            DispatchQueue.main.async {
                ishStarting = false
                ishReport = report
                // 诊断项里的「Linux 内核启动（实测）」要读 lastBootReport，
                // boot 完成后必须重跑一次，否则界面停在「尚未尝试」。
                readiness = ReadinessChecker.check()
                NSLog("[iSH] boot 结果: %@", report.summary)
            }
        }
    }

    var body: some View {
        ZStack {
            switch engine.state {
            case .idle:
                // 先做就绪诊断：缺阻塞项就进引导页，不盲目启动。
                // 可选项缺失（如 iSH）不拦启动 —— 引擎是原生的，不依赖它。
                if let readiness, !readiness.canStart {
                    OnboardingView(report: readiness) {
                        self.readiness = ReadinessChecker.check()
                        if self.readiness?.canStart == true {
                            engine.ensureRunning()
                        }
                    }
                } else {
                    LaunchView(
                        title: "准备引擎",
                        detail: "即将在进程内启动 Coomi 引擎（原生 aarch64）",
                        actionTitle: "开始",
                        action: { engine.ensureRunning() }
                    )
                    // iSH 结果直接摆在启动页：侧载后不用连电脑看日志，
                    // 屏幕上就有「内核到底起没起来 + 自检输出是什么」。
                    .overlay(alignment: .bottom) {
                        if let ishReport {
                            ISHReportCard(report: ishReport)
                                .padding(.horizontal, 16)
                                .padding(.bottom, 24)
                        } else if ishStarting {
                            // 后台在解包 fakefs + 起内核，这里给个可见信号，
                            // 否则用户只看到一个静止页面，不知道有没有在做事。
                            HStack(spacing: 8) {
                                ProgressView().scaleEffect(0.8)
                                Text("正在准备 Linux 工作环境…")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.bottom, 24)
                        }
                    }
                }
            case .launching:
                LaunchView(
                    title: "正在启动引擎…",
                    detail: "首次启动需要几秒。",
                    actionTitle: nil,
                    action: nil
                )
                .overlay(alignment: .bottom) {
                    ProgressView().padding(.bottom, 60)
                }

            case let .ready(port, token):
                EngineWebView(
                    port: port,
                    token: token,
                    onReady: { loadError = nil },
                    onFailure: { loadError = $0 }
                )
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    if let loadError {
                        ErrorBanner(text: loadError) { self.loadError = nil }
                            .padding(.top, 8)
                    }
                }
                // 引擎跑起来之后仍能看到 iSH 的结论：进主界面了才想知道
                // 「shell 工具到底能不能用」，这时翻回去看启动页不现实。
                .overlay(alignment: .bottom) {
                    if let ishReport, !ishReport.isFullyWorking {
                        ISHReportCard(report: ishReport, compact: true)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 16)
                    }
                }

            case let .failed(message):
                // 失败时重跑诊断：如果确实是缺产物，直接给出可执行指引。
                if let readiness, !readiness.canStart {
                    OnboardingView(report: readiness) {
                        self.readiness = ReadinessChecker.check()
                        if self.readiness?.canStart == true {
                            engine.ensureRunning()
                        }
                    }
                } else {
                    LaunchView(
                        title: "引擎启动失败",
                        detail: message,
                        actionTitle: "重试",
                        action: { engine.ensureRunning() }
                    )
                }
            }
        }
        .onAppear {
            // iSH 是可选路径（等价于安卓的 proot），失败也不拦引擎。
            // 它自己会异步跑，回主线程时再刷新 readiness
            // （诊断项里的「Linux 内核启动（实测）」要读 lastBootReport）。
            startUserland()
            readiness = ReadinessChecker.check()
            if readiness?.canStart == true, case .idle = engine.state {
                engine.ensureRunning()
            }
        }
        // 单参数 onChange：双参数是 iOS 17 API，本工程部署目标是 iOS 16。
        .onChange(of: scenePhase) { phase in
            guard phase == .active else { return }
            if case .ready = engine.state, loadError != nil {
                loadError = nil
            }
            // 回前台重新诊断：用户可能在 iSH 里刚补完东西。
            if case .idle = engine.state {
                readiness = ReadinessChecker.check()
            }
        }
    }
}

/// 首次启动引导页：逐项列出缺什么、怎么补。
struct OnboardingView: View {
    let report: ReadinessReport
    let onRecheck: () -> Void

    @State private var expanded: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                ForEach(report.items, id: \.id) { item in
                    itemCard(item)
                }
                footer
            }
            .padding(20)
        }
        .background(Color(.systemBackground))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "shippingbox.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("首次启动需要准备").font(.title3.weight(.semibold))
                    Text(report.summary).font(.footnote).foregroundStyle(.secondary)
                }
            }
            // 说清两件事：引擎是原生的；只有 shell 环境才需要额外产物。
            Text("引擎以 aarch64 原生静态库链进 App，不需要模拟器、也不是 Linux 二进制。"
                 + "标「可选·缺失」的项不拦启动 —— 只影响 AI 能否执行 shell 命令。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
        }
    }

    private func itemCard(_ item: ReadinessReport.Item) -> some View {
        let isExpanded = expanded.contains(item.id)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: item.isReady
                      ? "checkmark.circle.fill"
                      : (item.isBlocking ? "exclamationmark.circle.fill" : "minus.circle.fill"))
                    .foregroundStyle(item.isReady ? .green : (item.isBlocking ? .orange : .secondary))
                Text(item.title).font(.subheadline.weight(.medium))
                Spacer()
                Text(item.isReady ? "就绪" : (item.isBlocking ? "缺失" : "可选·缺失"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(item.isReady ? .green : (item.isBlocking ? .orange : .secondary))
            }
            Text(item.detail).font(.caption).foregroundStyle(.secondary)

            if let remedy = item.remedy {
                Button {
                    if isExpanded { expanded.remove(item.id) } else { expanded.insert(item.id) }
                } label: {
                    HStack(spacing: 4) {
                        Text(isExpanded ? "收起修复步骤" : "查看修复步骤")
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    }
                    .font(.caption.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)

                if isExpanded {
                    Text(remedy)
                        .font(.caption.monospaced())
                        .foregroundStyle(.primary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground).opacity(0.5),
                    in: RoundedRectangle(cornerRadius: 12))
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Button(action: onRecheck) {
                Text("重新检查").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Text("提示：补齐产物后需要重新安装 App（资源在打包时写入）。")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 4)
    }
}

struct LaunchView: View {
    let title: String
    let detail: String
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.tint)
            Text(title).font(.title3.weight(.semibold))
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

struct ErrorBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text).font(.caption).lineLimit(3)
            Spacer(minLength: 0)
            Button("关闭", action: onDismiss).font(.caption)
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 12)
    }
}

/// iSH 启动结果卡片。
///
/// # 为什么要把这些数字显示出来
/// 《iSH集成验证.md》把「运行时执行命令」列为**唯一未实测**的一环。
/// 在此之前 `ISHBridge.boot()` 定义了却从未被调用，所以那一环永远不会有输出。
/// 现在把它接上，并把每一步的中间结果（解包条目数、boot 返回码、自检 stdout/stderr）
/// 全部摊开 —— 真机上跑一次，屏幕上直接给答案，不需要连电脑看 Console.app。
struct ISHReportCard: View {
    let report: ISHBootReport
    var compact = false

    @State private var expanded = false

    private var ok: Bool { report.isFullyWorking }
    private var icon: String {
        if ok { return "checkmark.seal.fill" }
        return report.runtimeLinked ? "exclamationmark.triangle.fill" : "minus.circle.fill"
    }
    private var tint: Color {
        if ok { return .green }
        return report.runtimeLinked ? .orange : .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundStyle(tint)
                Text(ok ? "Linux 工作环境就绪" : "Linux 工作环境不可用")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Button(expanded ? "收起" : "详情") { expanded.toggle() }
                    .font(.caption2)
            }
            Text(report.summary)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? nil : 2)

            if expanded {
                VStack(alignment: .leading, spacing: 3) {
                    row("阶段", report.stage.label)
                    row("已链接静态库", report.runtimeLinked ? "是" : "否")
                    row("fakefs", report.fakefsReady
                        ? "已铺好" + (report.extractedEntries > 0
                            ? "（解包 \(report.extractedEntries) 条目，\(report.prepareMs)ms）"
                            : "（复用已有）")
                        : "未就绪")
                    row("boot 返回码", "\(report.bootStatus)")
                    if report.probeExitCode != 0 || !report.probeStdout.isEmpty {
                        row("自检退出码", "\(report.probeExitCode)")
                    }
                    if !report.probeStdout.isEmpty {
                        monoBlock("自检 stdout", report.probeStdout)
                    }
                    if !report.probeStderr.isEmpty {
                        monoBlock("自检 stderr", String(report.probeStderr.prefix(400)))
                    }
                    if let reason = report.failureReason {
                        monoBlock("失败原因", reason)
                    }
                    if !report.rootPath.isEmpty {
                        row("fakefs 根", report.rootPath)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(compact ? 10 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Text(v).font(.caption2.monospaced()).multilineTextAlignment(.trailing)
        }
    }

    private func monoBlock(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(body)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 6))
        }
    }
}
