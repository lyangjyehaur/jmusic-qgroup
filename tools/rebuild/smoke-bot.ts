import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/database/src/index';
import { localPlatform, until } from '../../apps/bot/testsupport/platform';

const directory = mkdtempSync(join(tmpdir(), 'qgroup-built-bot-'));
const cwd = process.cwd(),
  nativeFetch = globalThis.fetch,
  nativeSocket = globalThis.WebSocket;
let bot: typeof import('../../apps/bot/src/index');
let outbox: typeof import('../../apps/bot/src/worker');
let replies: typeof import('../../apps/bot/src/public');
let abbreviations: typeof import('../../apps/bot/src/abbreviation-service');
let dispatch: typeof import('../../apps/bot/src/dispatch-service');
let runtime: typeof import('../../apps/bot/src/runtime-service');
try {
  process.chdir(directory);
  globalThis.fetch = async () => {
    throw Error('Bot import must not perform HTTP requests');
  };
  globalThis.WebSocket = class {
    constructor() {
      throw Error('Bot import must not open a gateway');
    }
  } as unknown as typeof WebSocket;
  const environment = JSON.stringify(process.env);
  bot = await import(new URL('../../.rebuild-dist/bot/transport.mjs', import.meta.url).href);
  outbox = await import(new URL('../../.rebuild-dist/bot/outbox.mjs', import.meta.url).href);
  replies = await import(new URL('../../.rebuild-dist/bot/public.mjs', import.meta.url).href);
  abbreviations = await import(new URL('../../.rebuild-dist/bot/abbreviations.mjs', import.meta.url).href);
  dispatch = await import(new URL('../../.rebuild-dist/bot/dispatch.mjs', import.meta.url).href);
  await import(new URL('../../.rebuild-dist/bot/dispatch-task.mjs', import.meta.url).href);
  runtime = await import(new URL('../../.rebuild-dist/bot/runtime.mjs', import.meta.url).href);
  await import(new URL('../../.rebuild-dist/bot/maintenance-task.mjs', import.meta.url).href);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(JSON.stringify(process.env), environment);
} finally {
  process.chdir(cwd);
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = nativeSocket;
  rmSync(directory, { recursive: true, force: true });
}
const replyDirectory=mkdtempSync(join(tmpdir(),'qgroup-built-replies-'));
try {
  const path=join(replyDirectory,'space ? state.sqlite3'),db=openDatabase(path);
  try {
    db.exec("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('synthetic-user','synthetic-hash','synthetic','before'); INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,visibility,lifecycle,timezone,bot_enabled) VALUES('abcdef1234567890','synthetic-user','built public reply','其他','synthetic location','2099-11-19T10:00:00Z','2099-11-18T10:00:00Z',10,'','open','before','public','scheduled','Asia/Taipei',0)");
    assert.deepEqual(replies!.parseBotCommand('<@synthetic> /名額 abcdef12'),['名额','abcdef12']);
    const reply=replies!.readPublicBotReply(path,'名额','abcdef12',{baseURL:'https://example.test'});
    assert.match(reply.text,/built public reply/);assert.match(reply.text,/上限 10/);
    assert.match(reply.markdown!,/## \/名额/);assert.equal(reply.keyboard,null);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM bot_outbox').get(),{n:0});
    db.exec('UPDATE rebuild_storage SET recovery_required=1');
    assert.throws(()=>replies!.readPublicBotReply(path,'帮助'),/Recovery candidate/);
  } finally {db.close();}
} finally {rmSync(replyDirectory,{recursive:true,force:true});}
const dispatchDirectory=mkdtempSync(join(tmpdir(),'qgroup-built-dispatch-'));
try {
  const path=join(dispatchDirectory,'state.sqlite3'),db=openDatabase(path);
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:false,dry_run:false,groups:[{id:'synthetic-group',name:'',replies:true,broadcast:false}]}));
  const config=bot!.loadBotConfig({KANBAN_DB:path,KANBAN_BOT_BASE_URL:'https://example.test',KANBAN_BOT_DRY_RUN:'0'});
  const calls:string[]=[],api={replyGroup:async(_group:string,text:string)=>{calls.push(text);return {ok:true,code:0,data:{},status:200,kind:'ok' as const,platformTrace:null};}};
  const workers=new dispatch!.BotDispatchWorkers(config,{api});
  const router=new dispatch!.BotDispatcher({business:workers,api:{ackInteraction:async()=>{calls.push('ACK');return {ok:true,code:0,data:{},status:200,kind:'ok' as const,platformTrace:null};}}});
  try {
    const signal=new AbortController().signal;
    await router.onDispatch({op:0,t:'READY',s:1,d:{user:{id:'SYNTHETIC'}}},signal);
    const message={op:0 as const,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{id:'message',group_openid:'synthetic-group',content:'<@SYNTHETIC> /帮助'}};
    await router.onDispatch(message,signal);await router.onDispatch({...message,t:'GROUP_MESSAGE_CREATE',s:3},signal);
    await router.onDispatch({op:0,t:'INTERACTION_CREATE',s:4,id:'outer-event',d:{id:'interaction',type:11,group_openid:'synthetic-group',data:{resolved:{button_data:'/我的'}}}},signal);
    await router.drain();assert.equal(calls.length,3);assert(calls.includes('ACK'));assert(calls.some(text=>text.includes('机器人尚未绑定')));
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM bot_outbox').get(),{n:0});
    db.exec('UPDATE rebuild_storage SET recovery_required=1');
    await assert.rejects(workers.reply({group:'synthetic-group',command:'帮助',argument:'',msgId:'blocked'},signal));
  } finally {await router.close();db.close();}
} finally {rmSync(dispatchDirectory,{recursive:true,force:true});}
const abbreviationDirectory=mkdtempSync(join(tmpdir(),'qgroup-built-abbreviations-'));
try {
  assert.deepEqual(abbreviations!.groupBotCommand({content:'<@synthetic>',message_type:103,msg_elements:[{content:'這也太YYDS了 https://private.test/awsl'}]}),['缩写','yyds']);
  let upstream=0;
  const lookup=new abbreviations!.AbbreviationLookup({request:async terms=>{
    upstream++;assert.equal(terms,'yyds');return Buffer.from(JSON.stringify([{name:'yyds',trans:['正常释义','傻逼']} ]));
  }});
  try {
    const answer=await lookup.answer('YYDS');assert.match(String(answer),/正常释义、\[已遮蔽\]/);await lookup.answer('yyds');assert.equal(upstream,1);
  } finally {lookup.close();}
  const root=join(abbreviationDirectory,'results'),empty=new abbreviations!.BotWordMask([]),accepted:string[]=[],notices:string[]=[];
  const delivery=new abbreviations!.AbbreviationDelivery(root,{pageBytes:200,loadMask:()=>empty});
  const synthetic={replyGroup:async(_group:string,text:string)=>{
    const ok=Buffer.byteLength(text)<=220;
    if(ok)(text.includes('/缩写 继续 ')?notices:accepted).push(text);
    return {ok,code:ok?0:40054007,data:{},status:200,kind:ok?'ok' as const:'permanent' as const,platformTrace:null};
  }};
  const full='完整释义、'.repeat(150)+'🙂末尾';await delivery.send(synthetic,'synthetic',{text:full},{msgId:'first'});
  const token=/[0-9a-f]{24}$/.exec(notices.at(-1)!)![0];
  for(let round=0;round<20&&readdirSync(root).length;round++){
    const restarted=new abbreviations!.AbbreviationDelivery(root,{pageBytes:200,loadMask:()=>empty});
    const page=await restarted.continuation('synthetic','继续 '+token);assert.equal(page?.token,token);await restarted.send(synthetic,'synthetic',page!,{msgId:'next-'+round});
  }
  assert.equal(accepted.join(''),full);assert.deepEqual(readdirSync(root),[]);assert.equal(upstream,1);
} finally {rmSync(abbreviationDirectory,{recursive:true,force:true});}
const runtimeDirectory=mkdtempSync(join(tmpdir(),'qgroup-built-runtime-'));
const runtimePath=join(runtimeDirectory,'state.sqlite3'),runtimeDB=openDatabase(runtimePath);
let nativePosts=0;
const nativePlatform=await localPlatform((request,response)=>{
  let raw='';request.on('data',chunk=>{raw+=chunk;});request.on('end',()=>{
    response.setHeader('Content-Type','application/json');
    if(request.url==='/app/getAppAccessToken')response.end('{"access_token":"synthetic","expires_in":7200}');
    else if(request.url==='/gateway')response.end(JSON.stringify({url:nativePlatform.ws}));
    else if(request.url==='/v2/groups/native-group/messages'){nativePosts++;assert.equal(JSON.parse(raw).content,'built native runtime');response.end('{"id":"synthetic-sent"}');}
    else {response.statusCode=404;response.end('{}');}
  });
});
const guardPath=join(runtimeDirectory,'network-guard.mjs');
writeFileSync(guardPath,`const original=globalThis.fetch;globalThis.fetch=(url,options)=>{
  const target=new URL(url);
  if(['https://api.bot.qq.com','https://bots.qq.com'].includes(target.origin)&&target.pathname==='/app/getAppAccessToken')url=${JSON.stringify(nativePlatform.base)}+target.pathname;
  else if(target.hostname!=='127.0.0.1')throw Error('External network forbidden');
  return original(url,options);
};`);
let nativeChild:ReturnType<typeof spawn>|undefined,nativeExit:Promise<unknown>|undefined,childErrors='';
try {
  runtimeDB.exec("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('synthetic','hash','name','before'); INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,bot_enabled) VALUES('event','synthetic','title','其他','place','2099-01-01','2098-12-31',1,'','open','before',1)");
  runtimeDB.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,dry_run:false,groups:[{id:'native-group',name:'',replies:true,broadcast:true}]}));
  runtimeDB.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,created_at) VALUES('event','activity_published','native','native-group',?,'pending','before')").run(JSON.stringify({text:'built native runtime'}));
  nativeChild=spawn(process.execPath,['--import',guardPath,new URL('../../.rebuild-dist/bot/start.mjs',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,QQBOT_APP_ID:'synthetic',QQBOT_APP_SECRET:'synthetic',KANBAN_DB:runtimePath,KANBAN_BOT_GROUP:'native-group',KANBAN_BOT_API_BASE:nativePlatform.base,KANBAN_BOT_DRY_RUN:'0'},stdio:['ignore','ignore','pipe']});
  nativeChild.stderr!.on('data',chunk=>{childErrors+=chunk;});nativeExit=once(nativeChild,'exit');
  await until(()=>{if(nativeChild!.exitCode!==null)throw Error(childErrors);return (runtimeDB.prepare('SELECT status FROM bot_outbox').get() as {status:string}).status==='sent';},5000);
  assert.equal(nativePosts,1);assert.throws(()=>new runtime!.BotOwnership(runtimePath));
  nativeChild.kill('SIGTERM');const [code]=await nativeExit as [number];assert.equal(code,0,childErrors);
  const finalHealth=JSON.parse((await import('node:fs')).readFileSync(join(runtimeDirectory,'bot-logs','bot-health.json'),'utf8'));
  assert.equal(finalHealth.runtime_state,'stopped');assert(finalHealth.last_poll);assert.equal(finalHealth.gateway_connected,false);
  const owner=new runtime!.BotOwnership(runtimePath);owner.close();
} finally {
  if(nativeChild&&nativeChild.exitCode===null&&nativeChild.signalCode===null){nativeChild.kill('SIGKILL');await nativeExit;}
  await nativePlatform.close();runtimeDB.close();rmSync(runtimeDirectory,{recursive:true,force:true});
}
let posts = 0;
let outboxPosts = 0;
const platform = await localPlatform((request, response) => {
  let text = '';
  request.on('data', (chunk) => {
    text += chunk;
  });
  request.on('end', () => {
    const body = text ? JSON.parse(text) : null;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/app/getAppAccessToken') {
      assert.deepEqual(body, { appId: 'synthetic-app', clientSecret: 'synthetic-secret' });
      response.end(JSON.stringify({ access_token: 'synthetic-token', expires_in: 7200 }));
    } else if (request.url === '/gateway') response.end(JSON.stringify({ url: platform.ws }));
    else if (request.url === '/v2/groups/synthetic-group/messages') {
      posts++;
      assert.equal(request.headers.authorization, 'QQBot synthetic-token');
      assert.deepEqual(body, { msg_type: 0, content: 'synthetic', msg_id: 'synthetic-message', msg_seq: 1 });
      response.writeHead(202);
      response.end('{"id":"unconfirmed"}');
    } else if (request.url === '/v2/groups/outbox-group/messages') {
      outboxPosts++;
      assert.deepEqual(body, { msg_type: 0, content: 'built outbox synthetic' });
      response.writeHead(202);
      response.end('{"id":"unconfirmed-outbox"}');
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
});
const config = bot!.loadBotConfig({
  QQBOT_APP_ID: 'synthetic-app',
  QQBOT_APP_SECRET: 'synthetic-secret',
  KANBAN_BOT_API_BASE: platform.base,
});
const api = new bot!.QQBotAPI(config, { tokenHosts: [platform.base] });
const stop = new AbortController(),
  events: string[] = [];
const gateway = new bot!.QQGateway({
  api,
  intents: 0,
  allowLoopback: true,
  onDispatch: async (event) => {
    events.push(event.t);
  },
});
const work = gateway.run(stop.signal);
void work.catch(() => {});
try {
  await until(() => platform.peers.length === 1);
  platform.peers[0]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
  await until(() => platform.peers[0]!.frames.length === 1);
  assert.equal(platform.peers[0]!.frames[0]!.op, 2);
  platform.peers[0]!.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session' } });
  await until(() => gateway.state().connected);
  platform.peers[0]!.send({ op: 1 });
  await until(() => platform.peers[0]!.frames.some((frame) => frame.op === 1));
  platform.peers[0]!.send({ op: 11 });
  await until(() => gateway.state().last_ack !== null);
  assert.equal(
    (await api.replyGroup('synthetic-group', 'synthetic', { msgId: 'synthetic-message' })).kind,
    'unconfirmed',
  );
  assert.equal(posts, 1);
  platform.peers[0]!.close(4009);
  await until(() => platform.peers.length === 2, 5000);
  platform.peers[1]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
  await until(() => platform.peers[1]!.frames.length === 1);
  assert.deepEqual(platform.peers[1]!.frames[0], {
    op: 6,
    d: { token: 'QQBot synthetic-token', session_id: 'synthetic-session', seq: 1 },
  });
  platform.peers[1]!.send({ op: 0, t: 'RESUMED', s: 2, d: {} });
  await until(() => gateway.state().sequence === 2);
  assert.deepEqual(events, ['READY', 'RESUMED']);
  const outboxDirectory = mkdtempSync(join(tmpdir(), 'qgroup-built-outbox-'));
  const db = openDatabase(join(outboxDirectory, 'synthetic.sqlite3'));
  try {
    db.exec(`INSERT INTO users(id,token_hash,nickname,created_at) VALUES('owner','synthetic-token','合成使用者','before');
      INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,bot_enabled)
      VALUES('event','owner','合成活動','其他','合成地點','2099-01-01','2098-12-31',10,'','open','before',1)`);
    const policy = {
      enabled: true,
      groups: [{ id: 'outbox-group', name: '', replies: true, broadcast: true }],
    };
    db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(policy));
    const enqueue = db.prepare(
      "INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES('event','activity_published',?,'group','outbox-group',?,'pending','before')",
    );
    enqueue.run('real', JSON.stringify({ text: 'built outbox synthetic' }));
    const consumer = new outbox!.BotOutboxWorker(
      db,
      { ...config, group: 'outbox-group', dryRun: false, logDirectory: join(outboxDirectory, 'logs') },
      api,
    );
    assert.equal((await consumer.pollOnce()).skipped, 1);
    assert.equal((await consumer.pollOnce()).claimed, 0);
    assert.equal(outboxPosts, 1);
    assert.match(
      (db.prepare('SELECT last_error FROM bot_outbox').get() as { last_error: string }).last_error,
      /未确认/,
    );
    db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({ ...policy, dry_run: true }));
    enqueue.run('simulation', JSON.stringify({ text: 'built outbox synthetic' }));
    assert.equal((await consumer.pollOnce()).simulated, 1);
    assert.equal(outboxPosts, 1);
    const simulation = db
      .prepare(
        "SELECT status,sent_at,simulated_at,delivered_payload_json FROM bot_outbox WHERE dedupe_key='simulation'",
      )
      .get() as {
      status: string;
      sent_at: string | null;
      simulated_at: string | null;
      delivered_payload_json: string;
    };
    assert.equal(simulation.status, 'skipped');
    assert.equal(simulation.sent_at, null);
    assert(simulation.simulated_at);
    assert.equal(JSON.parse(simulation.delivered_payload_json).content, 'built outbox synthetic');
    db.exec('UPDATE rebuild_storage SET recovery_required=1');
    await assert.rejects(consumer.pollOnce(), /Recovery candidate requires offline review/);
  } finally {
    db.close();
    rmSync(outboxDirectory, { recursive: true, force: true });
  }
  console.log(
    'Built TS bot transport/outbox/public replies/abbreviations/isolated dispatch/native runtime: inert imports + local native HTTP/WebSocket + ACK + Resume + durable unconfirmed/simulation + read-only public query + complete masked lookup/continuation + recovery block passed; native CLI ownership/outbox/SIGTERM passed; no production worker or QQ delivery started',
  );
} finally {
  stop.abort();
  await work;
  api.close();
  await platform.close();
}
