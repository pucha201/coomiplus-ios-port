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
    @Environment(\.scenePhase) private var scenePhase

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
            // 先诊断再启动：缺产物时不要让启动流程白跑一遍、
            // 也不要让用户看到一句没法行动的失败提示。
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
