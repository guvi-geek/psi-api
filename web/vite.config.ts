import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = `http://127.0.0.1:${process.env.PORT ?? 3939}`;

// Every API route the server owns. In dev, Vite forwards these to `npm run dev`.
const API_PATHS = ['/health', '/report', '/reports', '/compare', '/reanalyze', '/targets', '/jobs', '/insights'];

export default defineConfig({
  root,
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(API_PATHS.map((path) => [path, api])),
  },
});
