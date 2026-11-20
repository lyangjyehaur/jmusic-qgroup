import {mkdtempSync,mkdirSync,readdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {afterEach,it,expect} from 'vitest';
import {retainedErasureConfig} from '../src/retained-erasure-config';
import Database from 'better-sqlite3';
import {readRollbackErasureAuthority} from '../src/erasure-authority-protocol';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const good={REBUILD_ERASURE_AUTHORITY_ROOT:'/private/authority',REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256:'a'.repeat(64),REBUILD_ERASURE_AUTHORITY_CHECKPOINT:'/private/checkpoint/unified.sqlite3'};
it('requires a retained source in production while retaining isolated development without authority',()=>{
 expect(()=>retainedErasureConfig({},true)).toThrow('Production web requires retained erasure authority and checkpoint');
 expect(retainedErasureConfig({},false)).toBeUndefined();
 expect(retainedErasureConfig(good,true)).toEqual({root:good.REBUILD_ERASURE_AUTHORITY_ROOT,manifestSha256:good.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256,sourceCheckpoint:good.REBUILD_ERASURE_AUTHORITY_CHECKPOINT});
});
it.each(['missing root','missing pin','missing checkpoint','empty root','empty pin','empty checkpoint','relative root','relative checkpoint','mutable pin'])('refuses %s in development and production without downgrading the ledger',change=>{
 const env:NodeJS.ProcessEnv={...good};
 if(change==='missing root')delete env.REBUILD_ERASURE_AUTHORITY_ROOT;
 if(change==='missing pin')delete env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256;
 if(change==='missing checkpoint')delete env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT;
 if(change==='empty root')env.REBUILD_ERASURE_AUTHORITY_ROOT='';
 if(change==='empty pin')env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256='';
 if(change==='empty checkpoint')env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT='';
 if(change==='relative root')env.REBUILD_ERASURE_AUTHORITY_ROOT='authority';
 if(change==='relative checkpoint')env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT='checkpoint.sqlite3';
 if(change==='mutable pin')env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256='main';
 for(const production of [false,true])expect(()=>retainedErasureConfig(env,production)).toThrow();
});
it.each(['absent','partial'])('rejects actual production startup with %s authority before opening storage; --version remains inert',configuration=>{
 const root=mkdtempSync(join(tmpdir(),'qgroup-retained-config-'));roots.push(root);const source=join(root,'source.json'),data=join(root,'data');mkdirSync(data,{mode:0o700});
 writeFileSync(source,JSON.stringify({version:1,commit:'a'.repeat(40),tree:'b'.repeat(40),source:'rehearsal'}),{mode:0o600});
 const env={PATH:process.env.PATH,NODE_ENV:'production',QGROUP_BUILD_INFO:source,REBUILD_DB:join(data,'never-open.sqlite3'),REBUILD_ORIGIN:'http://127.0.0.1:8791',...(configuration==='partial'?{REBUILD_ERASURE_AUTHORITY_ROOT:join(root,'not-created')}: {})};
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx','apps/api/src/start.ts',...args],{env,encoding:'utf8',timeout:10000});
 const stopped=run([]);expect(stopped.status,stopped.stderr).toBe(1);expect(stopped.stderr).toContain(configuration==='absent'?'Production web requires retained erasure authority and checkpoint':'ZodError');expect(readdirSync(data)).toEqual([]);
 const version=run(['--version']);expect(version.status,version.stderr).toBe(0);expect(JSON.parse(version.stdout)).toMatchObject({service:'web',commit:'a'.repeat(40)});expect(readdirSync(data)).toEqual([]);
});
it('builds the exact image rehearsal fixture with a portable checkpoint and refuses reuse before changing its source',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-empty-image-fixture-')));roots.push(root);for(const name of ['data','authority','checkpoint'])mkdirSync(join(root,name),{mode:0o700});
 const {syntheticImageFixture:script}=await import(new URL('../../../tools/rebuild/synthetic-image-fixture.mjs',import.meta.url).href);expect(typeof script).toBe('string');
 expect(readFileSync('tools/rebuild/verify-image.mjs','utf8')).toContain("import { syntheticImageFixture } from './synthetic-image-fixture.mjs'");
 // Only module loading differs locally; the exact image fixture body executes.
 const local=script.replace("import {openDatabase} from './.rebuild-dist/api/database.mjs';","import {openDatabase} from './packages/database/src/index.ts';");
 const database=join(root,'data','unified.sqlite3'),authority=join(root,'authority'),checkpoint=join(root,'checkpoint','unified.sqlite3');
 const run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',local,database,authority,join(root,'checkpoint')],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
 const prepared=run();expect(prepared.status,prepared.stderr).toBe(0);const result=JSON.parse(prepared.stdout),view=readRollbackErasureAuthority(authority,result.manifestSha256);expect(view.head.sequence).toBe(0);expect(view.manifest.checkpointSha256).toBe(result.checkpointSha256);view.assertUnchanged();
 const bytes=readFileSync(checkpoint),memory=new Database(bytes);try{expect(memory.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:15});expect(memory.prepare('SELECT recovery_required FROM rebuild_storage WHERE id=1').get()).toEqual({recovery_required:0});}finally{memory.close();}
 const original=readFileSync(database),again=run();expect(again.status).toBe(1);expect(again.stderr).toContain('private and empty');expect(readFileSync(database)).toEqual(original);expect(readFileSync(checkpoint)).toEqual(bytes);
});
