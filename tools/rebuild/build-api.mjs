import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
await build({ entryPoints: ['apps/api/src/start.ts'], outfile: '.rebuild-dist/api/start.mjs', bundle: true, platform: 'node', format: 'esm',
  // Bundle our TS workspace; keep native modules and server dependencies external.
  external: Object.keys(pkg.dependencies), logLevel: 'info' });
