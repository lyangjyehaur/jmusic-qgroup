import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { defaultBotPolicy } from '@qgroup/domain';
import { BotDispatcher } from './dispatch';
import { BotDispatchWorkers } from './dispatch-workers';
import { loadBotConfig } from './config';
import { QQBotAPI, type BotAPIResult } from './api';
import { QQGateway } from './gateway';
import { createBotObserver, type LogFields } from './observability';
import { localPlatform, until } from '../testsupport/platform';
const cleanup:(()=>void|Promise<void>)[]=[];
let root:string,workerURL:URL;
beforeAll(async()=>{
  // Keep external native dependency resolution inside the repository.
  root=mkdtempSync(resolve('.dispatch-test-'));
  await build({entryPoints:['apps/bot/testsupport/dispatch-worker.ts'],outfile:join(root,'fixture.mjs'),bundle:true,platform:'node',format:'esm',external:['better-sqlite3'],logLevel:'silent'});
  workerURL=pathToFileURL(join(root,'fixture.mjs'));
});
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const ok:BotAPIResult={ok:true,code:0,data:{},status:200,kind:'ok',platformTrace:null};
function setup(){
  const folder=mkdtempSync(join(root,'data-')),path=join(folder,'isolated.sqlite3'),db=openDatabase(path);
  const policy=defaultBotPolicy({enabled:false,dry_run:false,groups:[{id:'group',name:'',replies:true,broadcast:false}]});
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(policy));
  const config=loadBotConfig({KANBAN_DB:path,KANBAN_BOT_DRY_RUN:'0'});cleanup.push(()=>{db.close();rmSync(folder,{recursive:true,force:true});});return {config,db,policy};
}
describe('isolated bot dispatch workers',()=>{
  it('keeps gateway heartbeat, button ACK and public replies running while the abbreviation worker occupies CPU',async()=>{
    const s=setup(),rows:LogFields[]=[],observer=createBotObserver(row=>rows.push(row));
    const timeline:string[]=[],posts:Record<string,unknown>[]=[],lookups:unknown[]=[];
    let cpu=false;
    const platform=await localPlatform((request,response)=>{
      let data='';request.on('data',chunk=>{data+=chunk;});request.on('end',()=>{
        response.setHeader('Content-Type','application/json');
        if(request.url==='/app/getAppAccessToken'){response.end('{"access_token":"synthetic","expires_in":7200}');return;}
        if(request.url==='/lookup'){lookups.push(JSON.parse(data));expect(request.headers.authorization).toBeUndefined();response.end('[{"name":"yyds","trans":["正常释义"]}]');return;}
        if(request.url==='/cpu-start'){cpu=true;timeline.push('cpu-start');response.end('{}');return;}
        if(request.url==='/cpu-end'){timeline.push('cpu-end');response.end('{}');return;}
        if(request.url==='/interactions/interaction'){timeline.push('ack');response.end('{}');return;}
        if(request.url==='/v2/groups/group/messages'){const body=JSON.parse(data);posts.push(body);timeline.push(String(body.content).includes('缩写查询')?'abbreviation':'public');response.end('{"id":"sent"}');return;}
        response.statusCode=404;response.end('{}');
      });
    });cleanup.push(()=>platform.close());
    const api=new QQBotAPI({...s.config,apiBase:platform.base},{tokenHosts:[platform.base]});cleanup.push(()=>api.close());
    const workers=new BotDispatchWorkers({...s.config,baseURL:platform.base},{api,workerURL,observer});
    const dispatcher=new BotDispatcher({api,business:workers,observer});cleanup.push(()=>dispatcher.close());
    const stop=new AbortController(),gateway=new QQGateway({api:{gateway:async()=>platform.ws,auth:signal=>api.auth(signal)},intents:100663296,onDispatch:(event,signal)=>dispatcher.onDispatch(event,signal),allowLoopback:true,observer});
    const running=gateway.run(stop.signal);cleanup.push(async()=>{stop.abort();await running;});
    await until(()=>platform.peers.length===1);const peer=platform.peers[0]!;
    peer.send({op:10,d:{heartbeat_interval:100}});await until(()=>peer.frames.some(frame=>frame.op===2));
    peer.send({op:0,t:'READY',s:1,d:{session_id:'session',user:{id:'BOT'}}});await until(()=>gateway.state().connected);
    peer.send({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{id:'slow',group_openid:'group',content:'<@BOT> /缩写 yyds',author:{id:'person'}}});
    await until(()=>cpu,5000);
    const beats=peer.frames.filter(frame=>frame.op===1).length;
    peer.send({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:3,d:{id:'fast',group_openid:'group',content:'<@BOT> /帮助',author:{id:'person'}}});
    peer.send({op:0,t:'INTERACTION_CREATE',s:4,id:'outer-event',d:{id:'interaction',type:11,group_openid:'group',data:{resolved:{button_data:'/我的'}}}});
    // Server asks for an immediate heartbeat while the worker is CPU-bound.
    peer.send({op:1,d:null});
    await until(()=>timeline.includes('ack')&&timeline.includes('public')&&peer.frames.filter(frame=>frame.op===1).length>beats,1000);
    expect(timeline).not.toContain('cpu-end');expect(gateway.state().sequence).toBe(4);
    peer.send({op:11});await dispatcher.drain();
    expect(timeline.indexOf('ack')).toBeLessThan(timeline.indexOf('cpu-end'));
    expect(timeline.indexOf('public')).toBeLessThan(timeline.indexOf('cpu-end'));
    expect(lookups).toEqual([{text:'yyds'}]);expect(posts).toHaveLength(3);
    expect(posts.find(body=>body.event_id==='outer-event')).not.toHaveProperty('msg_id');
    expect(posts.find(body=>body.msg_id==='slow')?.content).toContain('正常释义');expect(gateway.state().connected).toBe(true);
  },15000);
  it('gates main-thread sends after cancellation even when a worker cannot process cancellation during CPU work',async()=>{
    const s=setup();let cpu=false,sends=0;
    const platform=await localPlatform((request,response)=>{
      if(request.url==='/cpu-start')cpu=true;
      response.end(request.url==='/lookup'?'[{"name":"yyds","trans":["正常"]}]':'{}');
    });cleanup.push(()=>platform.close());
    const workers=new BotDispatchWorkers({...s.config,baseURL:platform.base},{workerURL,api:{replyGroup:async()=>{sends++;return ok;}}});cleanup.push(()=>workers.close());
    const stop=new AbortController(),work=workers.reply({group:'group',command:'缩写',argument:'yyds',msgId:'message'},stop.signal);
    void work.catch(()=>{});await until(()=>cpu,5000);stop.abort();await expect(work).rejects.toThrow();
    // Cancelled work continues to occupy bounded capacity until the worker ACKs completion.
    const publicReply=workers.reply({group:'group',command:'帮助',argument:'',msgId:'other'},new AbortController().signal);await publicReply;expect(sends).toBe(1);
    await new Promise(resolve=>setTimeout(resolve,1400));expect(sends).toBe(1);
  },10000);
  it('revalidates after slow token acquisition before the actual platform POST',async()=>{
    const s=setup();let tokenRequested=false,release!:()=>void,posts=0;
    const tokenWait=new Promise<void>(resolve=>{release=resolve;});
    const platform=await localPlatform((request,response)=>{
      if(request.url==='/app/getAppAccessToken'){
        tokenRequested=true;void tokenWait.then(()=>response.end('{"access_token":"synthetic","expires_in":7200}'));return;
      }
      if(request.url==='/v2/groups/group/messages')posts++;
      response.end('{}');
    });cleanup.push(()=>platform.close());
    const api=new QQBotAPI({...s.config,apiBase:platform.base},{tokenHosts:[platform.base]});cleanup.push(()=>api.close());
    const workers=new BotDispatchWorkers(s.config,{workerURL,api,maxPerLane:1});cleanup.push(()=>workers.close());
    const work=workers.reply({group:'group',command:'帮助',argument:'',msgId:'message'},new AbortController().signal);
    await until(()=>tokenRequested,5000);
    s.db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({...s.policy,dry_run:true}));release();await work;
    expect(posts).toBe(0);expect(s.db.prepare('SELECT reason FROM bot_group_ignores ORDER BY id').all()).toEqual([{reason:'dry_run'}]);
  },10000);
  it('ACKs buttons while SQLite is locked, then obeys connection shutdown',async()=>{
    const s=setup();s.db.exec('BEGIN EXCLUSIVE');
    const workers=new BotDispatchWorkers(s.config,{workerURL,api:{replyGroup:async()=>{throw Error('Must not send');}}});
    let ack=0;const dispatcher=new BotDispatcher({business:workers,api:{ackInteraction:async()=>{ack++;return ok;}}});cleanup.push(()=>dispatcher.close());
    const stop=new AbortController();await dispatcher.onDispatch({op:0,t:'INTERACTION_CREATE',s:1,id:'event',d:{id:'button',type:11,group_openid:'group',data:{resolved:{button_data:'/帮助'}}}},stop.signal);
    await until(()=>ack===1);expect(dispatcher.pending).toBe(1);stop.abort();await dispatcher.drain();s.db.exec('ROLLBACK');
    // This is a callback/lifetime check; the full gateway heartbeat proof is above.
  });
  it('fails closed when a business isolate exits and reports no raw exception text',async()=>{
    const s=setup(),rows:LogFields[]=[],crash=join(root,'crash.mjs');writeFileSync(crash,"throw Error('PRIVATE synthetic failure');");
    const workers=new BotDispatchWorkers(s.config,{workerURL:pathToFileURL(crash),observer:createBotObserver(row=>rows.push(row)),api:{replyGroup:async()=>{throw Error('Must not send');}}});cleanup.push(()=>workers.close());
    await expect(workers.reply({group:'group',command:'帮助',argument:'',msgId:'message'},new AbortController().signal)).rejects.toThrow();
    expect(rows.some(row=>row.event==='business_worker_unavailable')).toBe(true);expect(JSON.stringify(rows)).not.toContain('PRIVATE synthetic failure');
    await expect(workers.observe('group','GROUP_ADD_ROBOT',undefined,new AbortController().signal)).rejects.toThrow();
  });
  it('holds cancelled worker queue slots until completion and refuses requests after shutdown',async()=>{
    const s=setup();s.db.exec('BEGIN EXCLUSIVE');
    const workers=new BotDispatchWorkers(s.config,{workerURL,maxPerLane:1,api:{replyGroup:async()=>ok}});cleanup.push(()=>workers.close());
    const stop=new AbortController(),work=workers.observe('group','GROUP_ADD_ROBOT',undefined,stop.signal);void work.catch(()=>{});stop.abort();await expect(work).rejects.toThrow();
    await expect(workers.observe('other','GROUP_ADD_ROBOT',undefined,new AbortController().signal)).rejects.toThrow('queue full');s.db.exec('ROLLBACK');
    await workers.close();await expect(workers.reply({group:'group',command:'帮助',argument:'',msgId:'x'},new AbortController().signal)).rejects.toThrow('aborted');
  });
});
