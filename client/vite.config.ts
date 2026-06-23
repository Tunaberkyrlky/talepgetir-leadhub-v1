import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('../package.json', 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: '../',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // Tiptap paketleri başlangıçta pre-bundle edilsin; aksi halde ilk lazy import'ta
    // Vite yeniden optimize edip dinamik import'u düşürebiliyor ("Failed to fetch...").
    include: [
      'react-simple-maps',
      // @tiptap/pm bare olarak EKLENMEZ — kök export'u yok (yalnız @tiptap/pm/* alt yolları).
      '@mantine/tiptap', '@tiptap/core', '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-link', '@tiptap/suggestion',
      '@xyflow/react', // görsel karar ağacı editörü (React Flow) — kök export'u var, bare eklenebilir
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          mantine: ['@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/modals', '@mantine/dropzone'],
          query: ['@tanstack/react-query'],
          flow: ['@xyflow/react'],
        },
      },
    },
  },
})
