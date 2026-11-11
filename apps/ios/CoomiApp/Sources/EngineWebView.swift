import SwiftUI
import UIKit
import WebKit

/// 承载前端页面的 WebView。
///
/// # 安全边界（与 Android 对齐）
/// 只允许加载 `http://127.0.0.1:<port>`。其它任何 URL（包括外链、`file://`、
/// 其它 host）一律交给系统打开或直接拒绝 —— 否则一个被注入的页面就能借
/// WebView 的上下文访问本机引擎（token 在 URL 里）。
///
/// # 为什么 token 放在 URL 上
/// 前端的 `transport` 会从 `location.search` 读 `token` 并在 WS/HTTP 上带 Bearer。
/// 这是既有协议（Android 也是这样），不引入新的注入路径。
struct EngineWebView: UIViewRepresentable {
    let port: Int
    let token: String
    /// 加载完成回调（用于隐藏启动遮罩）。
    var onReady: () -> Void = {}
    var onFailure: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(onReady: onReady, onFailure: onFailure, port: port)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // 与 Android WebView 对齐：允许自动播放（语音播报要用）。
        config.mediaTypesRequiringUserActionForPlayback = []

        let controller = WKUserContentController()
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        context.coordinator.webView = webView
        load(in: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // 端口/token 变了（引擎重启）就重载。
        if context.coordinator.port != port {
            context.coordinator.port = port
            load(in: webView, coordinator: context.coordinator)
        }
    }

    private func load(in webView: WKWebView, coordinator: Coordinator) {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else {
            onFailure("无法构造页面地址")
            return
        }
        webView.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let onReady: () -> Void
        let onFailure: (String) -> Void
        var port: Int
        weak var webView: WKWebView?

        init(onReady: @escaping () -> Void, onFailure: @escaping (String) -> Void, port: Int) {
            self.onReady = onReady
            self.onFailure = onFailure
            self.port = port
        }

        /// 只放行 loopback。
        private func isAllowed(_ url: URL?) -> Bool {
            guard let url else { return false }
            return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let url = navigationAction.request.url
            if isAllowed(url) {
                decisionHandler(.allow)
                return
            }
            // 非 loopback：交给系统（例如用户点了文档里的外链）。
            decisionHandler(.cancel)
            if let url, url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onReady()
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            onFailure(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            // 引擎可能还在启动：把原始错误交给上层决定是否重试。
            onFailure(error.localizedDescription)
        }

        /// 支持 `target="_blank"`：新窗口也用同一个 WebView 打开（避免丢 token）。
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                if isAllowed(url) {
                    webView.load(navigationAction.request)
                } else {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }

        /// 文件选择（图片/音频输入）：给一个最小可用的实现，避免点了没反应。
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
            topViewController()?.present(alert, animated: true)
        }

        private func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            while let presented = controller?.presentedViewController {
                controller = presented
            }
            return controller
        }
    }
}
