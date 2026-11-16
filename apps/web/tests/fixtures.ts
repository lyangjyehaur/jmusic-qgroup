import { test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// A fresh process per test prevents one scenario consuming another's real IP quotas
// or leaving mutable synthetic accounts/settings behind. Runtime limits stay enabled.
export const test = base.extend<{ preview: void; musicHistory: boolean; rosterExamples: boolean }>({
  musicHistory: [false, { option: true }],
  rosterExamples: [false, { option: true }],
  preview: [async ({ musicHistory, rosterExamples }, use) => {
    const preview = spawn(process.execPath, ['--import', 'tsx', 'apps/api/testsupport/preview.ts'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, REBUILD_TEST_MUSIC_HISTORY: musicHistory ? '1' : '0', REBUILD_TEST_ROSTER: rosterExamples ? '1' : '0' },
    });
    let output = '';
    preview.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-4000); });
    preview.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-4000); });
    const stopped = once(preview, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Synthetic preview did not start: ' + output)), 10000);
        preview.once('message', message => { clearTimeout(timer); message === 'ready' ? resolve() : reject(new Error('Unexpected preview readiness')); });
        preview.once('error', error => { clearTimeout(timer); reject(error); });
        preview.once('exit', code => { clearTimeout(timer); reject(new Error('Synthetic preview exited ' + code + ': ' + output)); });
      });
      await use();
    } finally {
      if (preview.exitCode === null && preview.signalCode === null) preview.kill('SIGTERM');
      await stopped;
    }
  }, { auto: true }],
});
export { expect } from '@playwright/test';
