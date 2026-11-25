import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { defaultBotPolicy } from '@qgroup/domain';
import { fixture } from '../../api/testsupport/fixture';
import { BotDispatcher, BotDispatchDedup, mentionsEveryone, mentionsThisBot, type BotDispatchBusiness, type BotDispatchReply } from './dispatch';
import { BotDispatchService } from './dispatch-business';
import { AbbreviationSendBlocked } from './send-policy';
import { loadBotConfig } from './config';
import { createBotObserver, type LogFields } from './observability';
import { until } from '../testsupport/platform';
import type { BotAPIResult, QQBotAPI } from './api';
import type { GatewayDispatch } from './gateway';
const ok:BotAPIResult={ok:true,code:0,data:{},status:200,kind:'ok',platformTrace:null};
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const lifetime=()=>new AbortController().signal;
const event=(type='GROUP_AT_MESSAGE_CREATE',payload:Record<string,unknown>={},id='outer'):GatewayDispatch=>({op:0,t:type,s:1,id,d:{group_openid:'group',id:'message',content:'<@BOT> /活动',author:{id:'person'},...payload}});
async function setupRouting(options:Partial<ConstructorParameters<typeof BotDispatcher>[0]>={}) {
  const calls:unknown[][]=[],rows:LogFields[]=[],business:BotDispatchBusiness={
    observe:async(group,type,reason)=>{calls.push(['observe',group,type,reason]);},
    reply:async request=>{calls.push(['reply',request]);},close:async()=>{calls.push(['close']);},
  };
  const dispatch=new BotDispatcher({api:{ackInteraction:async id=>{calls.push(['ack',id]);return ok;}},business,observer:createBotObserver(row=>rows.push(row)),...options});
  cleanup.push(()=>dispatch.close());await dispatch.onDispatch(event('READY',{user:{id:'BOT'}}),lifetime());return {dispatch,calls,rows};
}
function setupService(options:ConstructorParameters<typeof BotDispatchService>[2]={}) {
  const root=mkdtempSync(join(tmpdir(),'bot-dispatch-service-')),path=join(root,'state.sqlite3'),db=openDatabase(path);fixture(db);
  const policy=defaultBotPolicy({enabled:false,dry_run:false,groups:[{id:'group',name:'',replies:true,broadcast:false}]});
  const setPolicy=(patch:Partial<typeof policy>)=>db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({...policy,...patch}));setPolicy({});
  const rows:LogFields[]=[],config=loadBotConfig({KANBAN_DB:path,KANBAN_BOT_DRY_RUN:'0',KANBAN_BOT_BASE_URL:'https://example.test',KANBAN_BOT_MARKDOWN:'1',KANBAN_BOT_ALLOWED_HOSTS:'example.test'});
  const service=new BotDispatchService(config,{}, {observer:createBotObserver(row=>rows.push(row)),...options});
  cleanup.push(()=>{service.close();db.close();rmSync(root,{recursive:true,force:true});});
  const calls:{group:string;text:string;options:Parameters<QQBotAPI['replyGroup']>[2]}[]=[],api:Pick<QQBotAPI,'replyGroup'>={replyGroup:async(group,text,options)=>{calls.push({group,text,options});return ok;}};
  const request:BotDispatchReply={group:'group',command:'活动',argument:'',msgId:'message'};
  return {root,path,db,config,rows,service,calls,api,request,setPolicy};
}
describe('native bot dispatch routing and bounded lifetime',()=>{
  it('matches Python direct/everyone mention decisions, including fullwidth and Unicode boundaries',()=>{
    const values=[{}, {content:'<@BOT>'},{content:'<@!BOT>'},{content:'<@OTHER>'},{mentions:[{is_you:true}]},{mentions:[{id:'BOT'}]},...['<@!all>','<@everyone>','＠全體成員','<qqbot-at-everyone />','@ALL','a@all','中@all','@@all','@all_name'].map(content=>({content:'<@BOT> '+content})),{mention_everyone:true},{mention_everyone:'true'},{mentions:[{id:'everyone'}]},{mentions:'malformed'}];
    // Malformed mention arrays were not accepted by the original regex helper.
    const valid=values.filter(v=>!('mentions' in v)||Array.isArray(v.mentions));
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from qgroup_bot.main import mentions_bot,EVERYONE_MENTION
rows=json.load(sys.stdin)
print(json.dumps([[bool(mentions_bot(v.get('mentions') or [],'BOT',v.get('content'))), v.get('mention_everyone') is True or bool(EVERYONE_MENTION.search(str(v.get('content') or ''))) or any(x.get('id') in ('all','everyone') for x in v.get('mentions',[]) if isinstance(x,dict))] for v in rows]))`],{input:JSON.stringify(valid),encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}}));
    expect(valid.map(v=>[mentionsThisBot((v as Record<string,unknown>).mentions,'BOT',(v as Record<string,unknown>).content),!!mentionsEveryone(v)])).toEqual(expected);
    expect(mentionsThisBot('malformed','BOT','<@BOT>')).toBe(true);
  });
  it('only answers direct mentions, skips bots/everyone, and deduplicates both QQ message event types',async()=>{
    const s=await setupRouting();
    for(const [i,payload] of [{content:'/活动'},{content:'<@BOT> @all /活动'},{author:{id:'person',bot:true}},{}].entries())await s.dispatch.onDispatch(event('GROUP_AT_MESSAGE_CREATE',{...payload,id:'id'+i}),lifetime());
    await s.dispatch.onDispatch(event('GROUP_MESSAGE_CREATE',{id:'id3'}),lifetime());await s.dispatch.drain();
    expect(s.calls.filter(c=>c[0]==='reply')).toEqual([['reply',{group:'group',command:'活动',argument:'',msgId:'id3'}]]);
    expect(s.rows.filter(r=>r.event==='message_ignored').map(r=>r.reason)).toEqual(['not_addressed','everyone_mention','bot_author','duplicate']);
  });
  it('ACKs each command interaction once before business and uses only outer event ID',async()=>{
    const s=await setupRouting(),payload={id:'interaction',type:11,data:{resolved:{button_data:'/名額 2'}}};
    await s.dispatch.onDispatch(event('INTERACTION_CREATE',payload,'event-id'),lifetime());await s.dispatch.onDispatch(event('INTERACTION_CREATE',payload,'event-id'),lifetime());
    for(const type of [18,19,20])await s.dispatch.onDispatch(event('INTERACTION_CREATE',{...payload,id:'auth'+type,type}),lifetime());
    await s.dispatch.drain();expect(s.calls).toEqual([['ack','interaction'],['observe','group','INTERACTION_CREATE',undefined],['reply',{group:'group',command:'名额',argument:'2',eventId:'event-id'}]]);
    await s.dispatch.onDispatch(event('INTERACTION_CREATE',{...payload,id:'second',type:12},''),lifetime());await s.dispatch.drain();expect(s.calls.filter(c=>c[0]==='reply')).toHaveLength(1);
  });
  it('preserves opaque reply tokens and deduplicates long punctuated message IDs across event types',async()=>{
    const s=await setupRouting(),msgId='ROBOT1.0_'+ 'synthetic/+=:'.repeat(20),eventId='event.reply:'+ 'synthetic/+=.'.repeat(20);
    for(const type of ['GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE'])await s.dispatch.onDispatch(event(type,{id:msgId}),lifetime());
    await s.dispatch.onDispatch(event('INTERACTION_CREATE',{id:'interaction',type:11,data:{resolved:{button_data:'/帮助'}}},eventId),lifetime());
    await s.dispatch.drain();
    expect(s.calls.filter(c=>c[0]==='reply')).toEqual([
      ['reply',{group:'group',command:'活动',argument:'',msgId}],
      ['reply',{group:'group',command:'帮助',argument:'',eventId}],
    ]);
    expect(s.rows.filter(r=>r.event==='message_ignored').map(r=>r.reason)).toEqual(['duplicate']);
    expect(JSON.stringify(s.rows)).not.toContain(msgId);expect(JSON.stringify(s.rows)).not.toContain(eventId);
  });
  it('rejects missing, oversized and control-bearing message tokens without logging their values',async()=>{
    const s=await setupRouting();
    for(const id of [undefined,42,'','x'.repeat(4097),'private\ntoken'])await s.dispatch.onDispatch(event('GROUP_MESSAGE_CREATE',{id}),lifetime());
    await s.dispatch.drain();expect(s.calls.filter(c=>c[0]==='reply')).toEqual([]);
    expect(s.rows.filter(r=>r.event==='message_ignored').map(r=>r.reason)).toEqual(Array(5).fill('invalid_message_id'));
    expect(JSON.stringify(s.rows)).not.toContain('private');
  });
  it('continues business after ACK failure but never starts it after cancellation',async()=>{
    let release!:()=>void;const ack=new Promise<void>(resolve=>{release=resolve;});
    const s=await setupRouting({api:{ackInteraction:async()=>{await ack;throw Error('private error');}}}),stop=new AbortController();
    await s.dispatch.onDispatch(event('INTERACTION_CREATE',{type:11,id:'one'}),stop.signal);stop.abort();release();await s.dispatch.drain();expect(s.calls).toEqual([]);
    await s.dispatch.onDispatch(event('INTERACTION_CREATE',{type:12,id:'two'}),lifetime());await s.dispatch.drain();expect(s.calls.map(c=>c[0])).toEqual(['observe','reply']);
    expect(JSON.stringify(s.rows)).not.toContain('private error');
  });
  it('throttles ordinary observation, always records membership changes and sends no unsolicited replies',async()=>{
    let now=0;const s=await setupRouting({now:()=>now});
    for(let i=0;i<5;i++)await s.dispatch.onDispatch(event('GROUP_MESSAGE_CREATE',{content:'chat'}),lifetime());await s.dispatch.drain();expect(s.calls).toHaveLength(1);
    now=60001;await s.dispatch.onDispatch(event('GROUP_MESSAGE_CREATE',{content:'chat'}),lifetime());await s.dispatch.onDispatch(event('GROUP_DEL_ROBOT'),lifetime());await s.dispatch.drain();
    expect(s.calls.map(c=>c[2])).toEqual(['GROUP_MESSAGE_CREATE','GROUP_MESSAGE_CREATE','GROUP_DEL_ROBOT']);
  });
  it('keeps message IDs for ten minutes and quote fingerprints for thirty seconds without collapsing distinct quotes',()=>{
    let now=0;const d=new BotDispatchDedup(()=>now),p={group_openid:'group',content:'<@BOT>',author:{member_openid:'person'},timestamp:'same',message_type:103,msg_elements:[{content:'yyds',msg_idx:'1'}]};
    expect(d.message(p)).toBe('new');expect(d.message({...p,msg_elements:[{msg_idx:'1',content:'yyds'}]})).toBe('duplicate');expect(d.message({...p,msg_elements:[{content:'awsl'}]})).toBe('new');
    now=30001;expect(d.message(p)).toBe('new');expect(d.message({...p,id:'id'})).toBe('duplicate');
    expect(d.message({...p,id:'id',timestamp:'another'})).toBe('new');now=600001;expect(d.message({...p,id:'id',timestamp:'third'})).toBe('duplicate');now=630002;expect(d.message({...p,id:'id'})).toBe('new');
    expect(d.interaction('button')).toBe('new');expect(d.interaction('button')).toBe('duplicate');now+=600001;expect(d.interaction('button')).toBe('new');
    const tiny=new BotDispatchDedup(()=>now,1);expect(tiny.interaction('a')).toBe('new');expect(tiny.interaction('b')).toBe('full');expect(tiny.interaction('a')).toBe('duplicate');
  });
  it('extracts quoted abbreviations without logging original or quote previews',async()=>{
    const s=await setupRouting({verboseEvents:true});await s.dispatch.onDispatch(event('GROUP_AT_MESSAGE_CREATE',{content:'<@BOT>',message_type:103,msg_elements:[{content:'PRIVATE_QUOTE: YYDS https://secret.test'}]}),lifetime());await s.dispatch.drain();
    expect((s.calls.find(c=>c[0]==='reply')![1] as BotDispatchReply).argument).toBe('yyds');expect(JSON.stringify(s.rows)).not.toContain('PRIVATE_QUOTE');expect(JSON.stringify(s.rows)).not.toContain('secret.test');
  });
  it('bounds jobs and links accepted work to connection abort and its own deadline',async()=>{
    const signals:AbortSignal[]=[],business:BotDispatchBusiness={observe:async(_g,_e,_r,signal)=>{signals.push(signal);await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},reply:async()=>{},close:async()=>{}};
    const s=await setupRouting({business,maxJobs:1,jobTimeoutMs:50}),stop=new AbortController();
    await s.dispatch.onDispatch(event(),stop.signal);await until(()=>signals.length===1);await s.dispatch.onDispatch(event('GROUP_AT_MESSAGE_CREATE',{id:'other'}),stop.signal);expect(s.dispatch.pending).toBe(1);expect(s.rows.some(r=>r.event==='business_queue_full')).toBe(true);stop.abort();await s.dispatch.drain();expect(signals[0]!.aborted).toBe(true);
    await s.dispatch.onDispatch(event('GROUP_AT_MESSAGE_CREATE',{id:'third'}),lifetime());await s.dispatch.drain();expect(signals[1]!.aborted).toBe(true);
  });
});
describe('native dispatched replies and current policy',()=>{
  it('passes opaque message/event tokens unchanged to the reply API while keeping group paths strict',async()=>{
    const s=setupService(),msgId='ROBOT1.0_'+ 'synthetic/+=:'.repeat(20),eventId='event.reply:'+ 'synthetic/+=.'.repeat(20);
    await s.service.reply({...s.request,msgId},s.api,lifetime());
    await s.service.reply({...s.request,msgId:undefined,eventId},s.api,lifetime());
    expect(s.calls.map(c=>[c.options?.msgId,c.options?.eventId])).toEqual([[msgId,undefined],[undefined,eventId]]);
    await s.service.reply({...s.request,group:'group/path',msgId},s.api,lifetime());
    await s.service.reply({...s.request,msgId:'invalid\ntoken',eventId},s.api,lifetime());
    expect(s.calls).toHaveLength(2);
  });
  it('uses read-only public commands with broadcasts disabled and rechecks dry-run/groups/replies',async()=>{
    const s=setupService();await s.service.reply(s.request,s.api,lifetime());expect(s.calls).toHaveLength(1);expect(s.calls[0]!.options?.markdown).toContain('## 选择活动');
    for(const patch of [{dry_run:true},{replies_enabled:false},{groups:[]}] as const){s.setPolicy(patch as Parameters<typeof s.setPolicy>[0]);await s.service.reply({...s.request,msgId:'another'},s.api,lifetime());}
    expect(s.calls).toHaveLength(1);expect(s.db.prepare('SELECT reason FROM bot_group_ignores ORDER BY id').all()).toEqual([{reason:'dry_run'},{reason:'replies_disabled'},{reason:'group_not_allowed'}]);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM bot_outbox').get()).toEqual({n:0});
  });
  it('does not send after policy changes while external lookup is pending',async()=>{
    let release!:(raw:Uint8Array)=>void,started=false;
    const s=setupService({abbreviationRequest:async()=>{started=true;return new Promise(resolve=>{release=resolve;});}}),work=s.service.reply({...s.request,command:'缩写',argument:'yyds'},s.api,lifetime());
    await until(()=>started);s.setPolicy({groups:[]});release(Buffer.from('[{"name":"yyds","trans":["正常释义"]}]'));await work;
    expect(s.calls).toEqual([]);expect(s.rows.some(r=>r.event==='abbreviation_result_storage_failed')).toBe(false);
  });
  it('checks policy between every abbreviation segment and persists the uncertain cursor before a suppressed segment',async()=>{
    const s=setupService({abbreviationRequest:async()=>Buffer.from(JSON.stringify([{name:'yyds',trans:['正常释义'.repeat(150)]}]))});
    let sends=0;const api:Pick<QQBotAPI,'replyGroup'>={replyGroup:async()=>{
      sends++;if(sends===1)return {...ok,ok:false,code:40054007};s.setPolicy({replies_enabled:false});return ok;
    }};
    await s.service.reply({...s.request,command:'缩写',argument:'yyds'},api,lifetime());expect(sends).toBe(2);
    const root=join(s.root,'bot-abbreviation-results'),file=readdirSync(root).find(file=>file.endsWith('.json'))!,meta=JSON.parse(readFileSync(join(root,file),'utf8'));
    expect(meta.offset).toBeGreaterThan(0);expect(meta.uncertain).toBe(true);expect(s.rows.some(r=>r.event==='abbreviation_result_storage_failed')).toBe(false);
  });
  it('does not turn a post-token policy suppression into an uncertain result or failure notice',async()=>{
    const s=setupService({abbreviationRequest:async()=>Buffer.from('[{"name":"yyds","trans":["正常释义"]}]')});let requests=0;
    await s.service.reply({...s.request,command:'缩写',argument:'yyds'},{replyGroup:async()=>{requests++;throw new AbbreviationSendBlocked();}},lifetime());
    expect(requests).toBe(1);expect(readdirSync(s.root)).not.toContain('bot-abbreviation-results');expect(s.rows.some(r=>r.event==='abbreviation_send_unconfirmed'||r.event==='abbreviation_result_storage_failed')).toBe(false);
  });
  it('never resends rejected Markdown, rejects unapproved links, and blocks recovery candidates without migration',async()=>{
    const s=setupService();let sends=0;await s.service.reply(s.request,{replyGroup:async()=>{sends++;return {...ok,ok:false,code:40034008};}},lifetime());expect(sends).toBe(1);
    const blocked=new BotDispatchService({...s.config,baseURL:'https://unapproved.test'});cleanup.push(()=>blocked.close());await blocked.reply(s.request,s.api,lifetime());expect(s.calls).toEqual([]);
    s.db.exec('UPDATE rebuild_storage SET recovery_required=1');await expect(s.service.reply(s.request,s.api,lifetime())).rejects.toThrow('Recovery candidate');
    const missing=new BotDispatchService({...s.config,database:join(s.root,'missing.sqlite3')});cleanup.push(()=>missing.close());await expect(missing.reply(s.request,s.api,lifetime())).rejects.toThrow();expect(readdirSync(s.root)).not.toContain('missing.sqlite3');
  });
  it('loads the configured extra wordlist and never returns unmasked output when it is invalid',async()=>{
    const s=setupService(),words=join(s.root,'words.json');writeFileSync(words,JSON.stringify(['特定禁词']));
    const service=new BotDispatchService({...s.config,sensitiveWordsFile:words},{},{abbreviationRequest:async()=>Buffer.from('[{"name":"yyds","trans":["特定禁词","普通释义"]}]')});cleanup.push(()=>service.close());
    const request={...s.request,command:'缩写' as const,argument:'yyds'};await service.reply(request,s.api,lifetime());expect(s.calls[0]!.text).not.toContain('特定禁词');expect(s.calls[0]!.text).toContain('[已遮蔽]');
    writeFileSync(words,'invalid');await service.reply(request,s.api,lifetime());expect(s.calls).toHaveLength(2);expect(s.calls[1]!.text).toContain('暂时无法保存');expect(s.calls[1]!.text).not.toContain('特定禁词');
    expect(loadBotConfig({KANBAN_BOT_BASE_URL:'https://example.test///',KANBAN_BOT_SENSITIVE_WORDS_FILE:words})).toMatchObject({baseURL:'https://example.test',sensitiveWordsFile:words});
  });
});
