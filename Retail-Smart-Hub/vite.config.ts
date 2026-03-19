import fs from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const rootDir = fs.realpathSync(path.resolve(__dirname));
  const env = loadEnv(mode, rootDir, '');

  return {
    root: rootDir,
    base: './',
    clearScreen: false,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: ['**/database/**', '**/*.db', '**/*.db-wal', '**/*.db-shm'],
      },
      proxy: {
        '/api': {
          target: env.VITE_SERVER_PROXY_TARGET || 'http://127.0.0.1:4000',
          changeOrigin: true,
        },
      },
    },
  };
});
