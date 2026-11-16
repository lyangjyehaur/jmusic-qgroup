import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const legacyDirectories = ['../../ui/', '../../music_site/', '../../public/'].map(path => fileURLToPath(new URL(path, import.meta.url)));
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [{ name: 'reject-legacy-ui-runtime', generateBundle() {
    for (const id of this.getModuleIds()) {
      if (legacyDirectories.some(directory => id.startsWith(directory)) || id.includes('/html-react-parser/')) this.error(`Legacy runtime import is forbidden in the unified app: ${id}`);
    }
  } }],
  build: { outDir: '../../.rebuild-dist/web', emptyOutDir: true, rolldownOptions: {
    onwarn(warning, defaultHandler) {
      // This application is entirely client rendered, without an RSC boundary.
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
      defaultHandler(warning);
    },
  } },
  server: { host: '127.0.0.1', port: 5080, strictPort: true, proxy: { '/api': 'http://127.0.0.1:5081' } },
});
