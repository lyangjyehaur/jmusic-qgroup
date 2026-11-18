import { mkdtempSync,rmSync,writeFileSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,describe,it,expect } from 'vitest';
import { runtimeInfo,webRuntimeConfig,healthyBot,readBuildSource } from './index';
const paths:string[]=[];afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
describe('explicit compiled runtime source and configuration',()=>{
 it('requires immutable baked metadata in production and never takes source identity from an environment SHA',()=>{
  expect(()=>runtimeInfo('web',{NODE_ENV:'production',QGROUP_COMMIT:'a'.repeat(40)})).toThrow();expect(runtimeInfo('bot',{})).toMatchObject({source:'development',commit:null});
  const root=mkdtempSync(join(tmpdir(),'qgroup-runtime-'));paths.push(root);const path=join(root,'source.json'),source={version:1,commit:'a'.repeat(40),tree:'b'.repeat(40),source:'rehearsal'};writeFileSync(path,JSON.stringify(source));
  expect(runtimeInfo('web',{NODE_ENV:'production',QGROUP_BUILD_INFO:path})).toEqual({...source,service:'web',runtime:'typescript'});symlinkSync(path,join(root,'link'));expect(()=>readBuildSource(join(root,'link'))).toThrow();
  for(const bad of [{...source,commit:'main'},{...source,secret:'must not be returned'},{...source,source:'deployed'},[]]){writeFileSync(path,JSON.stringify(bad));expect(()=>readBuildSource(path)).toThrow();}
 });
 it('rejects missing production paths, non-origin URLs and invalid bind/port values before opening a database',()=>{
  expect(webRuntimeConfig({})).toMatchObject({host:'127.0.0.1',port:5081,production:false});const good={NODE_ENV:'production',REBUILD_ORIGIN:'https://fixture.example',REBUILD_DB:'/isolated/data.sqlite3'};expect(webRuntimeConfig(good)).toMatchObject({production:true,port:8791});
  for(const patch of [{REBUILD_DB:''},{REBUILD_DB:'relative.sqlite3'},{REBUILD_ORIGIN:'https://fixture.example/'},{REBUILD_ORIGIN:'https://fixture.example/path'},{REBUILD_ORIGIN:'http://fixture.example'},{REBUILD_ORIGIN:'https://user:secret@fixture.example'},{REBUILD_PORT:'0'},{REBUILD_PORT:'65536'},{REBUILD_PORT:'1e3'},{REBUILD_HOST:'public-host'}])expect(()=>webRuntimeConfig({...good,...patch})).toThrow();
  expect(webRuntimeConfig({...good,REBUILD_ORIGIN:'http://127.0.0.1:8791',REBUILD_HOST:'0.0.0.0'}).host).toBe('0.0.0.0');
 });
 it('requires fresh worker polls, active policy/gateway and ACK or initial READY; stale, future and terminal states fail',()=>{
  const now=1000,h={runtime_state:'running',gateway_connected:true,policy_resolved:true,updated_at:999,last_poll:999,last_ack:998,last_ready:997};expect(healthyBot(h,now)).toBe(true);expect(healthyBot({...h,last_ack:null},now)).toBe(true);
  for(const patch of [{runtime_state:'stopped'},{runtime_state:'starting'},{gateway_connected:false},{policy_resolved:false},{updated_at:880},{last_poll:880},{last_ack:760},{last_ack:1006},{last_ack:null,last_ready:879},{last_poll:Infinity},{last_poll:'999'}])expect(healthyBot({...h,...patch},now)).toBe(false);
 });
});
