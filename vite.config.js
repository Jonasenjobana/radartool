import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = process.env.PORT ?? env.PORT ?? '3100';
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  const targetHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  return {
    plugins: [vue()],
    server: { port: 5173, strictPort: true, proxy: { '/api': `http://${targetHost}:${port}` } },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
