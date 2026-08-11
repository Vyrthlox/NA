import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => {
  // dev 模式下 command 为 'serve'，build/preview 为 'build'
  const isDev = command === 'serve'

  return {
    main: {
      // electron-vite v5 默认已开启 externalizeDeps，无需额外插件
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'electron/main/index.ts') }
        }
      }
    },

    preload: {
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'electron/preload/index.ts') },
          // sandbox: true 时 preload 只能是 CJS
          output: { format: 'cjs', entryFileNames: '[name].js' }
        }
      }
    },

    renderer: {
      // 自定义布局：renderer root 指向 src/（非默认的 src/renderer）
      root: 'src',
      publicDir: resolve(__dirname, 'img'),
      resolve: {
        alias: { '@renderer': resolve(__dirname, 'src') }
      },
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/index.html') }
        }
      },
      plugins: [
        react(),
        tailwindcss(),
        // dev-only：放宽 CSP，让 react-refresh 内联脚本与 HMR WebSocket 通过
        isDev && {
          name: 'dev-csp-relax',
          transformIndexHtml(html: string): string {
            return html
              .replace(
                "script-src 'self'",
                "script-src 'self' 'unsafe-inline'"
              )
              .replace(
                "connect-src 'self'",
                "connect-src 'self' ws://localhost:* http://localhost:*"
              )
          }
        }
      ].filter(Boolean)
    }
  }
})
