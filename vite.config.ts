import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [svelte()],
  server: {
    // In development, forward API calls to `npm run worker:dev` so the app on :5173 shares the Worker's cookies and routes.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./tests/support/cloudflare-workers.ts', import.meta.url)),
    },
  },
})
