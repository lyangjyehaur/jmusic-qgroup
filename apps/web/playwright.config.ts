import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const channel = process.env.REBUILD_BROWSER_CHANNEL ?? (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, retries: 0,
  outputDir: fileURLToPath(new URL('../../test-results/', import.meta.url)),
  use: { baseURL: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, headless: true, trace: 'retain-on-failure',
    ...(channel ? { channel } : {}) },
  // Each test's preview fixture owns its DB and real rate-limit counters.
});
