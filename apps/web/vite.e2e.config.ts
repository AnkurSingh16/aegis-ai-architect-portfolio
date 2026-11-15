import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Isolated browser-test server. It never participates in normal development or production builds. */
export default defineConfig({
  envDir: false,
  resolve: {
    alias: { '@auth0/auth0-react': fileURLToPath(new URL('./e2e/auth0-mock.tsx', import.meta.url)) },
  },
  plugins: [react(), {
    name: 'e2e-auth-config-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.endsWith('/src/App.tsx') && source === './auth/config') return fileURLToPath(new URL('./e2e/auth-config-mock.ts', import.meta.url));
      if (importer?.endsWith('/src/auth/DevAuthExperience.tsx') && source === './config') return fileURLToPath(new URL('./e2e/auth-config-mock.ts', import.meta.url));
      return null;
    },
  }],
  server: { host: '127.0.0.1', port: 5174, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
});
