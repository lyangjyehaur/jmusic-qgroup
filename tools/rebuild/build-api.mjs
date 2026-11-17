import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const result = await build({ entryPoints: ['apps/api/src/start.ts'], outfile: '.rebuild-dist/api/start.mjs', bundle: true, platform: 'node', format: 'esm', metafile: true,
  // Bundle our TS workspace; keep native modules and server dependencies external.
  external: Object.keys(pkg.dependencies), logLevel: 'info' });
for (const path of Object.keys(result.metafile.inputs)) {
  if (path.includes('/testsupport/') || path.endsWith('.test.ts')) throw new Error(`Test-only code in runtime bundle: ${path}`);
}

await build({ entryPoints: ['apps/api/src/music-room-task.ts'], outfile: '.rebuild-dist/api/music-room-worker.mjs',
  bundle: true, platform: 'node', format: 'esm', external: Object.keys(pkg.dependencies), logLevel: 'info' });

const bot = await build({ entryPoints: ['apps/bot/src/index.ts'], outfile: '.rebuild-dist/bot/transport.mjs',
  bundle: true, platform: 'node', format: 'esm', external: Object.keys(pkg.dependencies), metafile: true, logLevel: 'info' });
for (const path of Object.keys(bot.metafile.inputs)) {
  if (path.includes('/testsupport/') || path.endsWith('.test.ts')) throw new Error(`Test-only code in bot bundle: ${path}`);
}

const outbox = await build({ entryPoints: ['apps/bot/src/worker.ts'], outfile: '.rebuild-dist/bot/outbox.mjs',
  bundle: true, platform: 'node', format: 'esm', external: Object.keys(pkg.dependencies), metafile: true, logLevel: 'info' });
for (const path of Object.keys(outbox.metafile.inputs)) {
  if (path.includes('/testsupport/') || path.endsWith('.test.ts') || path.endsWith('/start.ts')) throw new Error(`Invalid dependency in bot outbox bundle: ${path}`);
}

const replies = await build({ entryPoints: ['apps/bot/src/public.ts'], outfile: '.rebuild-dist/bot/public.mjs',
  bundle: true, platform: 'node', format: 'esm', external: Object.keys(pkg.dependencies), metafile: true, logLevel: 'info' });
for (const path of Object.keys(replies.metafile.inputs)) {
  if (path.includes('/testsupport/') || path.endsWith('.test.ts') || path.endsWith('/start.ts')) throw new Error(`Invalid dependency in bot public reply bundle: ${path}`);
}

const abbreviations = await build({ entryPoints: ['apps/bot/src/abbreviation-service.ts'], outfile: '.rebuild-dist/bot/abbreviations.mjs',
  bundle: true, platform: 'node', format: 'esm', external: Object.keys(pkg.dependencies), metafile: true, logLevel: 'info' });
for (const path of Object.keys(abbreviations.metafile.inputs)) {
  if (path.includes('/testsupport/') || path.endsWith('.test.ts') || path.endsWith('/start.ts') || path.startsWith('qgroup_bot/')) throw new Error(`Invalid dependency in bot abbreviation bundle: ${path}`);
}
