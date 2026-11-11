import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

/**
 * 安卓 9（API 28）兼容开关。
 *
 * 只在构建 32 位包时打开：设 `COOMI_ANDROID9_COMPAT=1`。
 * 64 位主干保持现代特性，不做任何降级 —— 降级本身有视觉代价
 * （color-mix 变成静态色、clamp 变成固定值），没必要让新设备一起承担。
 *
 * 降级策略（实测 lightningcss 1.33 对 Chrome 70 的能力）：
 *   能自动处理：color-mix / inset / clamp / min / max / :is 前缀
 *   不能处理：flex gap / dvh / :has / overflow:clip / aspect-ratio
 *             → 这几类由 scripts/compat-android9.py 在产物上二次处理
 */
const ANDROID9 = process.env.COOMI_ANDROID9_COMPAT === '1'

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    base: '/',
    // Keep development diagnostics available, but never ship console/debugger calls
    // in the WebView bundle embedded in release APKs.
    esbuild: isProduction ? { drop: ['console', 'debugger'] } : undefined,
    css: ANDROID9
      ? {
          transformer: 'lightningcss',
          lightningcss: {
            // Chrome 70 = 安卓 9 自带 WebView 的下限
            targets: { chrome: 70 << 16 },
          },
        }
      : undefined,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      minify: 'esbuild',
      cssMinify: ANDROID9 ? 'lightningcss' : 'esbuild',
      ...(ANDROID9 ? { cssTarget: 'chrome70' } : {}),
    },
  }
})
