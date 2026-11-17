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
