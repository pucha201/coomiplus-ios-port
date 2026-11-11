# CoomiPlus 手机版源码 · 1.6.8（完整可构建）

**目标：解压后三条命令直接出 APK。**

```
# ① 前端（产物 web.zip 由 Gradle 自动打包进 assets）
cd apps/web
npm install
npm run build

# ② Rust（Android arm64 交叉编译由 Gradle 任务驱动；本机先跑一次检查）
cd apps/coomi-rs
cargo check

# ③ Android 64 位
cd apps/coomi-app
./gradlew :app:assembleRelease
# 产物: apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk
```

## 已包含的二进制依赖（无需另下）

| 路径 | 体积 | 用途 |
|---|---|---|
| `apps/coomi-app/app/libs/sherpa-onnx.aar` | 47.8 MB | 语音识别 |
| `apps/coomi-app/app/src/main/assets/asr/*.onnx` | 24 MB | ASR 模型 |
| `runtime-v2-dist/debian-bookworm-arm64.tar.gz` | 150.9 MB | Debian rootfs（64 位内置） |
| `runtime-v2-dist/debian-bookworm-armhf.tar.gz` | 113.1 MB | Debian rootfs（32 位内置） |
| `runtime-v2-dist/proot-host-arm64/armhf.tar.gz` | ~0.2 MB | PRoot 宿主 |
| `apps/coomi-app/app/coomi-debug.jks` | 2.6 KB | 调试签名 |

## 需要的环境

- Node.js ≥ 18、npm
- Rust（含 `aarch64-linux-android` target：`rustup target add aarch64-linux-android`）
- Android SDK 35 + NDK 29（`ANDROID_HOME`/`ANDROID_SDK_ROOT` 指向 SDK）
- JDK 21（`JAVA_HOME`）

## 版本

versionCode 211 / versionName 1.6.8
