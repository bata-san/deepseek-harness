import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 相対パスで出力し、ゲートウェイの公開パス（/harness/ など）配下でそのまま動くようにする
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3090', ws: true },
      '/auth': 'http://127.0.0.1:3090',
    },
  },
})
