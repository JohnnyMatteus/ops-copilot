import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vuetify from 'vite-plugin-vuetify';

// O painel fala com o copiloto sempre por /api; o nginx (produção) e o proxy do Vite (dev) tiram o prefixo.
const copilot = process.env['VITE_COPILOT_URL'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: Number(process.env['WEB_PORT'] ?? 5173),
    proxy: { '/api': { target: copilot, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    server: { deps: { inline: ['vuetify'] } },
    setupFiles: ['tests/setup.ts'],
  },
});
