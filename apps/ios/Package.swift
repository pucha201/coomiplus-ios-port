// swift-tools-version:5.9
import PackageDescription

// 用 SwiftPM 描述 iOS App 的源码组织，便于在没有 Xcode 工程文件时也能校验编译单元。
//
// 注意：SwiftPM 本身不产出 .app，最终仍需 Xcode（或 xcodebuild）打包。
// 提供 Package.swift 的目的是：
//   1. 源码结构可被 `swift build`（macOS 上）或 Xcode 直接打开识别；
//   2. CI 里可以用 `swiftc -typecheck` 快速验证语法与类型。
let package = Package(
    name: "CoomiIOS",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "CoomiAppCore", targets: ["CoomiAppCore"]),
    ],
    targets: [
        .target(
            name: "CoomiAppCore",
            path: "CoomiApp/Sources"
        ),
    ]
)
