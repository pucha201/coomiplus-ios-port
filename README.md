# CoomiPlus 鎵嬫満鐗堟簮鐮?路 1.6.8锛堝畬鏁村彲鏋勫缓锛?
**鐩爣锛氳В鍘嬪悗涓夋潯鍛戒护鐩存帴鍑?APK銆?*

```
# 鈶?鍓嶇锛堜骇鐗?web.zip 鐢?Gradle 鑷姩鎵撳寘杩?assets锛?cd apps/web
npm install
npm run build

# 鈶?Rust锛圓ndroid arm64 浜ゅ弶缂栬瘧鐢?Gradle 浠诲姟椹卞姩锛涙湰鏈哄厛璺戜竴娆℃鏌ワ級
cd apps/coomi-rs
cargo check

# 鈶?Android 64 浣?cd apps/coomi-app
./gradlew :app:assembleRelease
# 浜х墿: apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk
```

## 宸插寘鍚殑浜岃繘鍒朵緷璧栵紙鏃犻渶鍙︿笅锛?
| 璺緞 | 浣撶Н | 鐢ㄩ€?|
|---|---|---|
| `apps/coomi-app/app/libs/sherpa-onnx.aar` | 47.8 MB | 璇煶璇嗗埆 |
| `apps/coomi-app/app/src/main/assets/asr/*.onnx` | 24 MB | ASR 妯″瀷 |
| `runtime-v2-dist/debian-bookworm-arm64.tar.gz` | 150.9 MB | Debian rootfs锛?4 浣嶅唴缃級 |
| `runtime-v2-dist/debian-bookworm-armhf.tar.gz` | 113.1 MB | Debian rootfs锛?2 浣嶅唴缃級 |
| `runtime-v2-dist/proot-host-arm64/armhf.tar.gz` | ~0.2 MB | PRoot 瀹夸富 |
| `apps/coomi-app/app/coomi-debug.jks` | 2.6 KB | 璋冭瘯绛惧悕 |

## 闇€瑕佺殑鐜

- Node.js 鈮?18銆乶pm
- Rust锛堝惈 `aarch64-linux-android` target锛歚rustup target add aarch64-linux-android`锛?- Android SDK 35 + NDK 29锛坄ANDROID_HOME`/`ANDROID_SDK_ROOT` 鎸囧悜 SDK锛?- JDK 21锛坄JAVA_HOME`锛?
## 鐗堟湰

versionCode 211 / versionName 1.6.8
