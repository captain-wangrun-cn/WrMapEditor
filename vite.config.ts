import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/wrmapeditor/',
  server: {
    host: '0.0.0.0', // 监听所有网络接口
    port: 8000 // 自定义端口
  },
})
