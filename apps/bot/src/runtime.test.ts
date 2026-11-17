import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { defaultBotPolicy } from '@qgroup/domain';
import { fixture } from '../../api/testsupport/fixture';
import { localPlatform, until } from '../testsupport/platform';
import { runBot } from './runtime';
import { BotOwnership } from './ownership';
import { loadBotConfig } from './config';
import { BotMaintenance } from './maintenance';
import { createBotObserver, type LogFields } from './observability';
let root:string,dispatchWorkerURL:URL,maintenanceWorkerURL:URL;
const cleanup:(()=>void|Promise<void>)[]=[];
beforeAll(async()=>{
  root=mkdtempSync(resolve('.runtime-test-'));
  for(const name of ['dispatch-task','maintenance-task'])await build({entryPoints:[`apps/bot/src/${name}.ts`],outfile:join(root,name+'.mjs'),bundle:true,platform:'node',format:'esm',external:['better-sqlite3'],logLevel:'silent'});
  dispatchWorkerURL=pathToFileURL(join(root,'dispatch-task.mjs'));maintenanceWorkerURL=pathToFileURL(join(root,'maintenance-task.mjs'));
});
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
async function setup(options:{dryRun?:boolean;panels?:boolean;holdToken?:boolean;holdMessage?:boolean}={}){
  const folder=mkdtempSync(join(root,'data-')),path=join(folder,'state.sqlite3'),db=openDatabase(path);fixture(db);db.exec("UPDATE events SET bot_enabled=1 WHERE id='listen'");
  const policy=defaultBotPolicy({enabled:true,dry_run:options.dryRun??false,groups:[{id:'group',name:'',replies:true,broadcast:true}]});
  const setPolicy=(patch:Partial<typeof policy>)=>db.prepare('UPDATE bot_settings SET revision=revision+1,config_json=?').run(JSON.stringify({...policy,...patch}));setPolicy({});
  const rows:LogFields[]=[],posts:Record<string,unknown>[]=[],timeline:string[]=[],held:ServerResponse[]=[];
  let tokenRequested=false,panels=0,requests=0;
  const platform=await localPlatform((request,response)=>{
    requests++;let raw='';request.on('data',chunk=>{raw+=chunk;});request.on('end',()=>{
      response.setHeader('Content-Type','application/json');
      if(request.url==='/app/getAppAccessToken'){
        tokenRequested=true;if(options.holdToken){held.push(response);return;}
        response.end('{"access_token":"synthetic","expires_in":7200}');return;
      }
      if(request.url==='/gateway'){response.end(JSON.stringify({url:platform.ws}));return;}
      if(request.url?.startsWith('/v2/panels?')){response.end('{"records":[]}');return;}
      if(request.url==='/v2/panels'){panels++;timeline.push('panels');response.end('{"panel_id":"synthetic"}');return;}
      if(request.url==='/interactions/interaction'){timeline.push('ack');response.end('{}');return;}
      if(request.url==='/v2/groups/group/messages'){
        const body=JSON.parse(raw);posts.push(body);timeline.push(body.msg_id||body.event_id?'reply':'outbox');
        if(options.holdMessage){held.push(response);return;}response.end('{"id":"synthetic-sent"}');return;
      }
      response.statusCode=404;response.end('{}');
    });
  });
  cleanup.push(async()=>{for(const response of held)if(!response.writableEnded)response.end('{}');await platform.close();db.close();rmSync(folder,{recursive:true,force:true});});
  const config={...loadBotConfig({QQBOT_APP_ID:'synthetic-app',QQBOT_APP_SECRET:'SYNTHETIC-SECRET',KANBAN_DB:path,KANBAN_BOT_GROUP:'group',KANBAN_BOT_DRY_RUN:'0',KANBAN_BOT_SETUP_PANELS:options.panels?'1':'0',KANBAN_BOT_API_BASE:platform.base,KANBAN_BOT_BASE_URL:platform.base}),legacyApiBase:platform.base,pollInterval:.04};
  const queue=(key:string,status='pending',text='合成 outbox '+key)=>db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES('listen','activity_published',?,'group','group',?,?,'2026-11-17T00:00:00+00:00')").run(key,JSON.stringify({text}),status);
  const health=()=>JSON.parse(readFileSync(join(config.logDirectory,'bot-health.json'),'utf8')) as Record<string,unknown>;
  const stop=new AbortController();let running:Promise<void>|undefined;
  const start=(extra:Parameters<typeof runBot>[2]={})=>{
    running=runBot(config,stop.signal,{observer:createBotObserver(row=>rows.push(row)),dispatchWorkerURL,maintenanceWorkerURL,tokenHosts:[platform.base],gateway:{allowLoopback:true},...extra});void running.catch(()=>{});
    cleanup.push(async()=>{stop.abort();for(const response of held)if(!response.writableEnded)response.end('{}');await running?.catch(()=>{});});return running;
  };
  async function ready(){
    await until(()=>platform.peers.length===1,5000);const peer=platform.peers[0]!;peer.send({op:10,d:{heartbeat_interval:1000}});await until(()=>peer.frames.some(frame=>frame.op===2));peer.send({op:0,t:'READY',s:1,d:{session_id:'synthetic-session',user:{id:'BOT'}}});peer.send({op:1});await until(()=>peer.frames.some(frame=>frame.op===1));peer.send({op:11});return peer;
  }
  return {path,folder,db,config,policy,setPolicy,rows,posts,timeline,queue,health,platform,start,stop,ready,held,get tokenRequested(){return tokenRequested;},get panels(){return panels;},get requests(){return requests;}};
}
describe('native bot runtime lifecycle',()=>{
  it('refreshes and records the latest policy after an existing WAL writer commits, without a stale upgrade',async()=>{
    const s=await setup(),rows:LogFields[]=[],signal=new AbortController().signal;
    const maintenance=new BotMaintenance(s.config,{workerURL:maintenanceWorkerURL,observer:createBotObserver(row=>rows.push(row)),api:{post:async()=>{throw Error('No network expected');}}});cleanup.push(async()=>{await maintenance.close();});
    await maintenance.init(signal);
    s.db.exec('BEGIN IMMEDIATE');s.setPolicy({dry_run:true});
    let completed=false;
    const checked=maintenance.policy(signal).then(value=>({ok:true,value}),()=>({ok:false,value:null})).finally(()=>{completed=true;});
    let completedWhileLocked:boolean;
    try{await new Promise(resolve=>setTimeout(resolve,150));completedWhileLocked=completed;}
    finally{s.db.exec('COMMIT');}
    expect(await checked).toEqual({ok:true,value:{revision:2,dryRun:true,group:'group'}});expect(completedWhileLocked).toBe(false);
    expect(s.db.prepare('SELECT applied_revision FROM bot_runtime').get()).toEqual({applied_revision:2});
    expect(rows.some(row=>row.event==='maintenance_failed')).toBe(false);expect(s.requests).toBe(0);
  });
  it('consumes outbox while gateway is offline, handles messages/buttons, records applied policy and stops cleanly',async()=>{
    const s=await setup({panels:true});s.queue('first');const work=s.start();
    s.db.exec("INSERT INTO external_identities VALUES('qq','synthetic-app','synthetic-openid','alice','合成名','before'); INSERT INTO external_unionids VALUES('qq','synthetic-app','synthetic-openid','SITE-UNION-SECRET','before')");
    await until(()=>s.posts.some(body=>!body.msg_id&&!body.event_id)&&(s.db.prepare('SELECT status FROM bot_outbox').get() as {status:string}).status==='sent',5000);
    expect(s.rows.some(row=>row.event==='websocket_ready')).toBe(false);
    expect(s.db.prepare('SELECT status FROM bot_outbox').get()).toEqual({status:'sent'});
    const peer=await s.ready();
    const message={op:0,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{id:'message',group_openid:'group',content:'<@BOT> /帮助',author:{id:'person',union_openid:'SITE-UNION-SECRET',union_user_account:'PRIVATE-QQ-ACCOUNT'}}};peer.send(message);peer.send({...message,t:'GROUP_MESSAGE_CREATE',s:3});
    peer.send({op:0,t:'INTERACTION_CREATE',s:4,id:'outer-event',d:{id:'interaction',type:11,group_openid:'group',data:{resolved:{button_data:'/我的'}}}});
    try{await until(()=>s.posts.length===3&&s.panels===1&&s.health().last_ack!==null,5000);}
    catch{throw Error(JSON.stringify({n:s.posts.length,panels:s.panels,health:s.health(),acks:s.rows.filter(r=>r.event==='heartbeat_ack'),events:s.rows.filter(r=>r.event!=='poll_completed').slice(-10)}));}
    expect(s.posts.filter(body=>body.msg_id==='message')).toHaveLength(1);expect(s.posts.some(body=>body.event_id==='outer-event')).toBe(true);expect(s.timeline).toContain('ack');
    await until(()=>s.rows.filter(row=>row.event==='message_received').length===2);expect(s.rows.filter(row=>row.event==='message_received').every(row=>row.unionid_matches_site===true&&row.union_user_account_present===true)).toBe(true);
    const settings=s.db.prepare('SELECT revision FROM bot_settings').get() as {revision:number},runtime=s.db.prepare('SELECT applied_revision,deployment_group FROM bot_runtime').get();expect(runtime).toEqual({applied_revision:settings.revision,deployment_group:'group'});
    expect(s.health()).toMatchObject({runtime_state:'running',dry_run:false,deployment_dry_run:false,policy_resolved:true,gateway_connected:true});
    s.stop.abort();await work;expect(s.health()).toMatchObject({runtime_state:'stopped',gateway_connected:false});expect(s.health().last_poll).not.toBeNull();
    expect(statSync(join(s.config.logDirectory,'bot-health.json')).mode&0o777).toBe(0o600);
    const owner=new BotOwnership(s.path);owner.close();expect(JSON.stringify(s.rows)).not.toMatch(/SYNTHETIC-SECRET|SITE-UNION-SECRET|PRIVATE-QQ-ACCOUNT/);
  },15000);
  it('uses current dry-run for panels and broadcasts, rearms panels on real mode, and never replays simulated work',async()=>{
    const s=await setup({dryRun:true,panels:true});s.queue('simulated');const work=s.start();await s.ready();
    await until(()=>s.rows.some(row=>row.event==='outbox_simulated'),5000);expect(s.posts).toEqual([]);expect(s.panels).toBe(0);expect(s.health()).toMatchObject({dry_run:true,deployment_dry_run:false,policy_resolved:true});
    s.setPolicy({dry_run:false});s.queue('real');await until(()=>s.posts.length===1&&s.panels===1,5000);
    s.setPolicy({dry_run:true});await until(()=>s.health().dry_run===true);s.setPolicy({dry_run:false});try{await until(()=>s.panels===2);}catch{throw Error(JSON.stringify({panels:s.panels,health:s.health(),events:s.rows.filter(r=>r.event!=='poll_completed').slice(-10)}));}
    expect(s.posts).toHaveLength(1);expect(s.db.prepare('SELECT status,simulated_at FROM bot_outbox WHERE dedupe_key=?').get('simulated')).toMatchObject({status:'skipped'});
    s.stop.abort();await work;
  },15000);
  it('rejects recovery candidates and ambiguous prior sending work before any network or claim',async()=>{
    const s=await setup();s.queue('unknown','sending');const before=s.db.prepare('SELECT * FROM bot_outbox').all();await expect(s.start()).rejects.toThrow();expect(s.requests).toBe(0);expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(before);expect(s.health().runtime_state).toBe('failed');
    // Separate runtime, same existing DB; no action was taken to resolve delivery.
    s.db.exec("UPDATE bot_outbox SET status='pending'; UPDATE rebuild_storage SET recovery_required=1");
    const stop=new AbortController();await expect(runBot(s.config,stop.signal,{dispatchWorkerURL,maintenanceWorkerURL,observer:createBotObserver()})).rejects.toThrow();expect(s.requests).toBe(0);expect(s.db.prepare('SELECT status FROM bot_outbox').get()).toEqual({status:'pending'});
  });
  it('checks outbox policy after slow token acquisition instead of sending stale prepared content',async()=>{
    const s=await setup({holdToken:true});s.queue('before-token');const work=s.start();
    await until(()=>s.tokenRequested&&(s.db.prepare("SELECT status FROM bot_outbox").get() as {status:string}).status==='sending',5000);
    s.setPolicy({dry_run:true});for(const response of s.held.splice(0))response.end('{"access_token":"synthetic","expires_in":7200}');
    try{await until(()=>s.rows.some(row=>row.event==='outbox_simulated'),5000);}
    catch{throw Error(JSON.stringify({held:s.held.length,posts:s.posts.length,outbox:s.db.prepare('SELECT status,attempts,last_error FROM bot_outbox').all(),events:s.rows.filter(row=>row.event!=='poll_completed').slice(-20)}));}
    expect(s.posts).toEqual([]);expect(s.db.prepare('SELECT status,attempts FROM bot_outbox').get()).toEqual({status:'skipped',attempts:0});s.stop.abort();await work;
  },10000);
  it('preserves in-flight uncertainty, releases untouched claims and does not start another send during shutdown',async()=>{
    const s=await setup({holdMessage:true});s.queue('inflight');s.queue('untouched');const work=s.start();await until(()=>s.posts.length===1,5000);s.stop.abort();await work;
    expect(s.posts).toHaveLength(1);expect(s.db.prepare('SELECT dedupe_key,status FROM bot_outbox ORDER BY id').all()).toEqual([{dedupe_key:'inflight',status:'skipped'},{dedupe_key:'untouched',status:'pending'}]);
    expect((s.db.prepare('SELECT last_error FROM bot_outbox ORDER BY id').get() as {last_error:string}).last_error).toContain('未确认');expect(s.health().runtime_state).toBe('stopped');
  },10000);
  it('redacts the QQ secret from opt-in child-worker content diagnostics',async()=>{
    const s=await setup();s.config.logContent=true;s.config.logContentLimit=80;s.queue('redaction','pending','synthetic '+s.config.appSecret);s.queue('cutoff','pending','x'.repeat(75)+s.config.appSecret);
    const work=s.start();await until(()=>s.rows.filter(row=>row.event==='outbox_sent').length===2,5000);s.stop.abort();await work;
    expect(s.posts[0]!.content).toContain('SYNTHETIC-SECRET');expect(JSON.stringify(s.rows)).not.toContain('SYNTHETIC-SECRET');expect(s.rows.some(row=>typeof row.text_preview==='string'&&row.text_preview.includes('[redacted]'))).toBe(true);
    expect(s.rows.some(row=>row.text_preview==='x'.repeat(75)+'[redacted]')).toBe(true);expect(JSON.stringify(s.rows)).not.toContain('SYNTH');
  });
  it('stops the full runtime if a public/abbreviation worker exits',async()=>{
    const s=await setup(),crash=join(root,'dispatch-crash.mjs');writeFileSync(crash,"throw Error('PRIVATE worker crash');");
    await expect(s.start({dispatchWorkerURL:pathToFileURL(crash)})).rejects.toThrow();expect(s.posts).toEqual([]);expect(s.health().runtime_state).toBe('failed');
    const owner=new BotOwnership(s.path);owner.close();expect(JSON.stringify(s.rows)).not.toContain('PRIVATE worker crash');
  });
  it('fails closed on worker boot failure and releases ownership after termination',async()=>{
    const s=await setup(),crash=join(root,'crash.mjs');writeFileSync(crash,"throw Error('PRIVATE synthetic failure');");
    await expect(s.start({maintenanceWorkerURL:pathToFileURL(crash)})).rejects.toThrow();expect(s.requests).toBe(0);expect(s.health().runtime_state).toBe('failed');expect(JSON.stringify(s.rows)).not.toContain('PRIVATE synthetic failure');
    const owner=new BotOwnership(s.path);owner.close();
  });
});
