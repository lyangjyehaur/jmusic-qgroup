import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const channel = process.env.REBUILD_BROWSER_CHANNEL ?? (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, retries: 0,
  outputDir: fileURLToPath(new URL('../../test-results/', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:5082', headless: true, trace: 'retain-on-failure',
    ...(channel ? { channel } : {}) },
  webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)), command: 'node_modules/.bin/tsx apps/api/testsupport/preview.ts', url: 'http://127.0.0.1:5082/api/v2/health', reuseExistingServer: false },
});
