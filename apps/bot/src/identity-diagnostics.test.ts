import { execFileSync } from 'node:child_process';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../../api/testsupport/fixture';
import { identityDiagnosticFields,messageObservation } from './identity-diagnostics';
import { BotDispatcher } from './dispatch';
import { createBotObserver,type LogFields } from './observability';
import { until } from '../testsupport/platform';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function setup(){
  const root=mkdtempSync(join(tmpdir(),'bot-union-observation-')),path=join(root,'synthetic.sqlite3'),db=openDatabase(path);fixture(db);
  db.exec("INSERT INTO external_identities VALUES('qq','synthetic-app','synthetic-openid','alice','合成名','before'); INSERT INTO external_unionids VALUES('qq','synthetic-app','synthetic-openid','SITE-UNION-SECRET','before')");
  cleanup.push(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,path,db};
}
const observation=(author:unknown)=>messageObservation({author},'GROUP_AT_MESSAGE_CREATE',true,false);
const unionFields=(fields:LogFields)=>Object.fromEntries(Object.entries(fields).filter(([key])=>key.startsWith('union')));
describe('read-only cross-application identity diagnostics',()=>{
  it('keeps ignored-message diagnostics out of the dispatcher command and button budget',async()=>{
    let replies=0,diagnoses=0,acks=0;const rows:LogFields[]=[],signal=new AbortController().signal;
    const dispatcher=new BotDispatcher({maxJobs:1,observer:createBotObserver(row=>rows.push(row)),api:{ackInteraction:async()=>{acks++;return {ok:true,code:0,data:{},status:200,kind:'ok',platformTrace:null};}},business:{
      diagnose:async(_input,life)=>{diagnoses++;await new Promise<void>(resolve=>life.addEventListener('abort',()=>resolve(),{once:true}));},observe:async()=>{},reply:async()=>{replies++;},close:async()=>{},
    }});cleanup.push(()=>dispatcher.close());await dispatcher.onDispatch({op:0,t:'READY',s:1,d:{user:{id:'BOT'}}},signal);
    for(let i=0;i<12;i++){await dispatcher.onDispatch({op:0,t:'GROUP_MESSAGE_CREATE',s:i+2,d:{group_openid:'group',id:'ordinary'+i,content:'ordinary'}},signal);await until(()=>dispatcher.pending===0);}
    expect(diagnoses).toBe(8);expect(rows.some(row=>row.event==='message_diagnostic_unavailable'&&row.reason==='queue_full')).toBe(true);
    await dispatcher.onDispatch({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:20,d:{group_openid:'group',id:'command',content:'<@BOT> /帮助'}},signal);await until(()=>replies===1&&dispatcher.pending===0);
    await dispatcher.onDispatch({op:0,t:'INTERACTION_CREATE',s:21,id:'outer',d:{group_openid:'group',id:'button',type:11,data:{resolved:{button_data:'/我的'}}}},signal);await until(()=>replies===2);expect(acks).toBe(1);await dispatcher.close();
  });
  it('matches retained Python presence, Unicode length, opaque reference and site-match booleans without exposing identity/account values',()=>{
    const s=setup(),authors=[null,[],{}, {union_openid:123,union_user_account:false}, {union_openid:' \t\n',union_user_account:' '}, {union_openid:'SITE-UNION-SECRET',union_user_account:'PRIVATE-QQ-ACCOUNT'}, {union_openid:'  OTHER-UNION-SECRET  '}, {union_openid:'未知😀',union_user_account:'有值'}];
    const users=s.db.prepare('SELECT * FROM users').all(),before=s.db.prepare('SELECT * FROM external_unionids').all(),expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from types import SimpleNamespace
from qgroup_bot.main import union_diagnostics
authors=json.load(sys.stdin)
print(json.dumps([union_diagnostics(author,SimpleNamespace(db=Path(sys.argv[1]))) for author in authors]))`,s.path],{input:JSON.stringify(authors),encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()},timeout:10000}));
    const fields=authors.map(author=>identityDiagnosticFields(s.path,observation(author)));
    const correlated=identityDiagnosticFields(s.path,messageObservation({group_openid:'PRIVATE-GROUP',id:'PRIVATE-MESSAGE',author:authors[5]},'GROUP_MESSAGE_CREATE',true,false));expect(correlated.group_ref).toMatch(/^[a-f0-9]{20}$/);expect(correlated.input_ref).toMatch(/^[a-f0-9]{20}$/);expect(JSON.stringify(correlated)).not.toMatch(/PRIVATE-GROUP|PRIVATE-MESSAGE/);
    expect(fields.map(unionFields)).toEqual(expected);expect(s.db.prepare('SELECT * FROM external_unionids').all()).toEqual(before);
    const output=JSON.stringify(fields);expect(output).not.toMatch(/SITE-UNION-SECRET|OTHER-UNION-SECRET|PRIVATE-QQ-ACCOUNT|synthetic-openid|未知😀/);
    expect(s.db.prepare('SELECT * FROM users').all()).toEqual(users);expect(s.db.prepare('SELECT count(*) n FROM bot_outbox').get()).toEqual({n:0});
  });
  it('reports unavailable storage/schema/recovery as a diagnostic failure without creating or changing identity records',()=>{
    const s=setup(),input=observation({union_openid:'SITE-UNION-SECRET'}),missing=join(s.root,'MISSING-SECRET.sqlite3');
    expect(identityDiagnosticFields(missing,input)).toMatchObject({union_openid_present:true,unionid_lookup:'unavailable'});expect(existsSync(missing)).toBe(false);
    s.db.exec('UPDATE rebuild_storage SET recovery_required=1');const recovery=identityDiagnosticFields(s.path,input);expect(recovery).toMatchObject({unionid_lookup:'unavailable'});expect(recovery).not.toHaveProperty('unionid_matches_site');
    const old=setup();old.db.exec('DROP TABLE external_unionids');const fields=identityDiagnosticFields(old.path,input);expect(fields).toMatchObject({unionid_lookup:'unavailable',unionid_lookup_error:'OperationalError'});expect(fields).not.toHaveProperty('unionid_matches_site');expect(JSON.stringify(fields)).not.toMatch(/SECRET|SELECT|sqlite3|synthetic/);
  });
  it('bounds locked-database observation and rejects oversized identity input before cloning or hashing it',()=>{
    const s=setup(),input=observation({union_openid:'SITE-UNION-SECRET'});s.db.pragma('journal_mode = DELETE');s.db.exec('BEGIN EXCLUSIVE');
    try{const started=performance.now(),fields=identityDiagnosticFields(s.path,input);expect(fields).toMatchObject({unionid_lookup:'unavailable'});expect(performance.now()-started).toBeLessThan(1000);}finally{s.db.exec('ROLLBACK');}
    const large=observation({union_openid:'SECRET'.repeat(10000),union_user_account:'PRIVATE ACCOUNT'});expect(large.unionOpenid).toBe('');const fields=identityDiagnosticFields(s.path,large);expect(fields).toMatchObject({union_openid_present:true,union_openid_len:null,unionid_lookup:'unavailable',unionid_lookup_error:'InvalidIdentifier'});expect(fields).not.toHaveProperty('union_openid_ref');expect(JSON.stringify(fields)).not.toMatch(/SECRET|PRIVATE/);
  });
  it('keeps commands and buttons working when identity diagnostics fail, and observes ignored traffic without logging raw authors or content',async()=>{
    const rows:LogFields[]=[],seen:unknown[]=[],replies:unknown[]=[],dispatcher=new BotDispatcher({observer:createBotObserver(row=>rows.push(row)),verboseEvents:true,api:{ackInteraction:async()=>({ok:true,code:0,data:{},status:200,kind:'ok',platformTrace:null})},business:{
      diagnose:async input=>{seen.push(input);throw Error('PRIVATE DIAGNOSTIC EXCEPTION');},observe:async()=>{},reply:async request=>{replies.push(request);},close:async()=>{},
    }});cleanup.push(()=>dispatcher.close());const signal=new AbortController().signal;
    await dispatcher.onDispatch({op:0,t:'READY',s:1,d:{user:{id:'BOT'}}},signal);
    for(const [i,content] of ['PRIVATE BODY','<@BOT> /帮助'].entries())await dispatcher.onDispatch({op:0,t:'GROUP_MESSAGE_CREATE',s:i+2,d:{group_openid:'group',id:'message'+i,content,author:{union_openid:'SITE-UNION-SECRET',union_user_account:'PRIVATE ACCOUNT',private:'PRIVATE AUTHOR'}}},signal);
    await dispatcher.onDispatch({op:0,t:'INTERACTION_CREATE',s:4,id:'outer',d:{group_openid:'group',id:'button',type:11,data:{resolved:{button_data:'/我的'}}}},signal);await dispatcher.drain();
    expect(seen).toHaveLength(2);expect(seen[0]).not.toHaveProperty('union_user_account');expect(seen[0]).not.toHaveProperty('private');expect(replies).toHaveLength(2);expect(rows.filter(row=>row.event==='message_diagnostic_unavailable')).toHaveLength(2);expect(JSON.stringify(rows)).not.toMatch(/SITE-UNION-SECRET|PRIVATE/);
  });
});
