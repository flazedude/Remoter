import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true }, build: { outDir: 'dist/renderer', emptyOutDir: true }, esbuild: { jsx: 'automatic' } });
