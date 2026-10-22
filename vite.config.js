import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_PUBLIC_GIT_SHA': JSON.stringify(process.env.VITE_PUBLIC_GIT_SHA || execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()) },
  server: { proxy: { '/__updates': { target: 'https://vamos.asius.ai', changeOrigin: true, rewrite: path => path.replace(/^\/__updates/, '') } } },
  build: { target: 'esnext' },
  test: { environment: 'node' },
})
