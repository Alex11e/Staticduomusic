import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      watch: {
        ignored: ['**/music/**'],
      },
      proxy: {
        '/api': {
          target: env.MUSIC_SERVER_URL || 'http://localhost:4000',
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest, request) => {
              proxyRequest.setHeader('X-Forwarded-Host', request.headers.host || 'localhost')
              proxyRequest.setHeader('X-Forwarded-Proto', request.headers['x-forwarded-proto'] || 'http')
            })
          },
        },
      },
    },
  }
})