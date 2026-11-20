import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const args=process.argv.slice(2);
assert(args.length===4&&args[0]==='--source'&&args[2]==='--output',
  'Use --source <archived context> --output <new absolute harness directory>');
const source=resolve(args[1]),output=args[3];
assert(isAbsolute(output)&&!existsSync(output),'A new absolute harness directory is required');
const metadata=JSON.parse(readFileSync(join(source,'release-source.json'),'utf8'));
assert(metadata.version===1&&metadata.source==='rehearsal'&&/^[a-f0-9]{40}$/.test(metadata.commit));
const inputs=['tools/rebuild/smoke-bot.ts','apps/bot/testsupport/platform.ts'];
mkdirSync(output,{mode:0o755});
// Keep the existing smoke assertions. Only its database import is redirected to
// the actual image bundle; the readonly mount retains tools/rebuild/ URL depth.
const result=await build({absWorkingDir:source,entryPoints:[inputs[0]],bundle:true,
  platform:'node',target:'node22',format:'esm',outfile:join(output,'smoke-bot.mjs'),
  metafile:true,plugins:[{name:'actual-image-database',setup(builder){
    builder.onResolve({filter:/^\.\.\/\.\.\/packages\/database\/src\/index$/},()=>
      ({path:'/app/.rebuild-dist/api/database.mjs',external:true}));
  }}]});
assert.deepEqual(Object.keys(result.metafile.inputs).sort(),inputs.toSorted(),
  'The harness must not bundle source API/database/bot implementations');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest={version:1,commit:metadata.commit,sourceTree:metadata.tree,
  database:'/app/.rebuild-dist/api/database.mjs',
  inputs:inputs.map(path=>({path,sha256:digest(readFileSync(join(source,path)))})),
  harnessSha256:digest(readFileSync(join(output,'smoke-bot.mjs'))),
  runtimeFromImage:true,externalTransport:false,releaseEligible:false};
writeFileSync(join(output,'harness-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644,flag:'wx'});
process.stdout.write(JSON.stringify(manifest)+'\n');
