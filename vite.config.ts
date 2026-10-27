import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-only proxy to the local daemon. The daemon enforces exact Host/Origin, so both are rewritten to the daemon address.
const daemon = process.env.AGENT_OFFICE_DAEMON_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    proxy: {
      '/v1': {
        target: daemon, changeOrigin: true, ws: true,
        configure: proxy => {
          proxy.on('proxyReq', request => request.setHeader('origin', daemon));
          proxy.on('proxyReqWs', request => request.setHeader('origin', daemon));
        },
      },
    },
  },
});
