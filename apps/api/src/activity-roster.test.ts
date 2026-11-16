import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { createApp } from './app';
const origin='https://rebuild.example';const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(){
  const db=openDatabase(':memory:');fixture(db);nicknameFixture(db);
  db.exec("INSERT INTO attendees(id,event_id,manager_id,name,note,payer_kind,status,created_at,updated_at) VALUES('guest-active','listen','alice','未認領同行','同行原文','manager','tentative','before','before'); INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,invitation_token,created_at,updated_at) VALUES('hidden-invited','listen','alice','私人邀請','manager','invited','private-invitation-token','before','before');");
  const app=createApp({db,origin,qq:{clientId:'current-app',authorize:()=>'',exchange:async()=>{throw Error('unused');}}});await app.ready();cleanups.push(async()=>{await app.close();db.close();});
  async function account(user:string){const cookie='kanban_session=fixture-'+user;const viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};}
  const alice=await account('alice');const bob=await account('bob');
  const get=(path:string,headers:Record<string,string>={})=>app.inject({url:'/api/v2/activities/'+path,headers});
  const music=(attendee:string,headers:Record<string,string>=alice)=>get('listen/attendees/'+attendee+'/music',headers);
  async function profile(headers=alice,selections=[{entryId:'sub-2',level:4}]){return(await app.inject({method:'PUT',url:'/api/v2/me/music',headers:{...headers,'idempotency-key':randomUUID()},payload:{profileId:null,musicEpoch:0,revision:0,selections}})).json();}
  return {db,app,alice,bob,get,music,profile};
}
describe('activity roster and attendee music',()=>{
  it('preserves original party/FIFO positions and public ordering, same-name rows and frozen payment responsibility without leaking identities or invitation tokens',async()=>{
    const s=await setup();s.db.exec("UPDATE users SET nickname='同名'; INSERT INTO attendee_payment_origins VALUES('managed-listen','old-payer','原付款人',0,'alice');");
    const row=(await s.get('listen/roster',s.alice)).json();expect(row.participants.map((p:{id:string})=>p.id)).toEqual(['self-listen','managed-listen','guest-active']);
    expect(row.participants[0]).toMatchObject({name:'同名',isMe:true,isGuest:false,position:2,payerName:'同名'});
    expect(row.participants[1]).toMatchObject({name:'同名',isMe:false,isGuest:false,position:3,waitingPosition:1,payerName:'原付款人'});
    expect(row.participants[2]).toMatchObject({name:'未認領同行',isGuest:true,position:1,status:'tentative'});
    const response=await s.get('listen/roster');expect(response.statusCode).toBe(200);expect(response.body).not.toMatch(/user_id|manager_id|token|userId|withdrawn|私人邀請|hidden-invited/);expect(response.json().participants.every((p:{isMe:boolean;managedByMe:boolean})=>!p.isMe&&!p.managedByMe)).toBe(true);
  });
  it('uses exact attendee user ownership, never manager names, contact QQ or an unfinished claim, and preserves unlinked rows',async()=>{
    const s=await setup();const own=await s.profile();
    expect((await s.music('self-listen')).json()).toMatchObject({state:'ready',profileId:own.id,isSelf:true,picks:[{entryId:'sub-2',shared:true}]});
    expect((await s.music('managed-listen')).json()).toEqual({state:'unlinked'});expect((await s.music('guest-active')).json()).toEqual({state:'unlinked'});
    const bob=await s.profile(s.bob,[{entryId:'sub-0',level:3},{entryId:'sub-2',level:1}]);
    const ready=await s.music('managed-listen');expect(ready.json()).toEqual({state:'ready',profileId:bob.id,name:'小白',isSelf:false,picks:[{entryId:'sub-0',name:'YOASOBI',kind:'sub',level:3,shared:false},{entryId:'sub-2',name:'Aimer',kind:'sub',level:1,shared:true}]});
    expect(ready.body).not.toMatch(/contact|gender|note|userId|manager|QQ|pin/);
    s.db.prepare("INSERT INTO attendee_claims VALUES('pending','listen','guest-active','private-claim','alice','bob','pending','2099','before',NULL)").run();
    expect((await s.music('guest-active')).json()).toEqual({state:'unlinked'});
    for(const person of ['guest-listen','hidden-invited','self-karaoke','missing'])expect((await s.music(person)).statusCode).toBe(404);
  });
  it('returns actionable viewer and target states after field changes, erasure or account closure without exposing private fields',async()=>{
    const s=await setup();const bob=await s.profile(s.bob);
    expect((await s.music('managed-listen')).json()).toEqual({state:'viewer_unlinked'});await s.profile();
    const response=await s.app.inject({method:'PUT',url:'/api/v2/me/music/fields',headers:{...s.bob,'idempotency-key':randomUUID()},payload:{profileId:bob.id,musicEpoch:0,revision:0,name:'獨立成分稱呼',note:'私密留言',gender:'私密性別',genderPublic:false}});expect(response.statusCode).toBe(200);
    expect((await s.music('managed-listen')).json().name).toBe('獨立成分稱呼');expect((await s.music('managed-listen')).body).not.toMatch(/私密|note|gender/);
    s.db.prepare("INSERT INTO privacy_requests VALUES('closed','bob','shared_review','before','before','')").run();expect((await s.music('managed-listen')).json()).toEqual({state:'unlinked'});expect((await s.get('listen/roster',s.alice)).json().participants).toHaveLength(3);
    s.db.prepare("UPDATE music_profiles SET user_id=NULL,erased_at='erased' WHERE user_id='alice'").run();expect((await s.music('self-listen')).json()).toEqual({state:'viewer_unlinked'});
  });
  it('keeps invited and draft access identical for metadata, roster and music; cookies, site roles and another event never grant access',async()=>{
    const s=await setup();await s.profile();await s.profile(s.bob);
    for(const path of ['invite','invite/roster','invite/attendees/self-invite/music']){
      expect((await s.get(path,s.alice)).statusCode).toBe(200);expect((await s.get(path,s.bob)).statusCode).toBe(404);expect((await s.get(path,{cookie:s.alice.cookie})).statusCode).toBe(path.endsWith('/music')?409:404);
    }
    s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,0,'before'); INSERT INTO event_access VALUES('karaoke','bob','before');");expect((await s.get('invite/roster',s.bob)).statusCode).toBe(404);
    s.db.exec("INSERT INTO event_access VALUES('invite','bob','before');");expect((await s.get('invite/roster',s.bob)).statusCode).toBe(200);
    for(const path of ['draft','draft/roster','draft/attendees/self-draft/music'])expect((await s.get(path,s.bob)).statusCode).toBe(404);
    s.db.exec("INSERT INTO event_access VALUES('draft','bob','before'); INSERT INTO event_roles VALUES('role','draft','bob','[\"schedule\"]','before');");
    for(const path of ['draft','draft/roster','draft/attendees/self-draft/music'])expect((await s.get(path,s.bob)).statusCode).toBe(200);
    s.db.exec("UPDATE event_roles SET permissions_json='[]'");expect((await s.get('draft/roster',s.bob)).statusCode).toBe(404);
    s.db.exec("UPDATE event_roles SET permissions_json='{\"length\":10}'");const invalid=await s.get('draft/roster',s.bob);expect(invalid.statusCode).toBe(500);expect(invalid.body).not.toMatch(/Invalid stored|private|私人/);
    s.db.exec("DELETE FROM event_roles;");expect((await s.get('draft/roster',s.bob)).statusCode).toBe(404);
    for(const path of ['deleted','deleted/roster','deleted/attendees/self-deleted/music'])expect((await s.get(path,s.alice)).statusCode).toBe(404);
  });
  it('requires scoped membership for music and rejects old account or revoked sessions on every read',async()=>{
    const s=await setup();await s.profile();
    expect((await s.music('self-listen',{})).statusCode).toBe(401);expect((await s.music('self-listen',{...s.alice,'x-account-scope':'stale'})).statusCode).toBe(409);
    expect((await s.get('listen/roster',{...s.alice,'x-account-scope':'stale'})).statusCode).toBe(409);
    s.db.exec('DELETE FROM browser_sessions');expect((await s.music('self-listen')).statusCode).toBe(401);expect((await s.get('listen/roster',s.alice)).statusCode).toBe(401);
  });
  it('only uses current configured official QQ avatars and revalidates the source hostname',async()=>{
    const s=await setup();s.db.exec("INSERT INTO external_identities VALUES('qq','other-app','private-subject','alice','private-nickname','before'); INSERT INTO external_profiles VALUES('qq','other-app','alice','https://q1.qlogo.cn/wrong.png'); INSERT INTO external_identities VALUES('qq','current-app','current-subject','alice','external nickname','before'); INSERT INTO external_profiles VALUES('qq','current-app','alice','https://evil.example/private');");
    expect((await s.get('listen/roster')).json().participants[0].avatarUrl).toBe('');s.db.exec("UPDATE external_profiles SET avatar_url='http://q1.qlogo.cn/synthetic.png' WHERE client_id='current-app'");
    const response=await s.get('listen/roster');expect(response.json().participants[0].avatarUrl).toBe('https://q1.qlogo.cn/synthetic.png');expect(response.body).not.toMatch(/subject|external nickname|wrong.png/);
  });
  it('matches original Python roster positions and never writes roster, identity, claims, history, music or bot work during reads',async()=>{
    const s=await setup();await s.profile();await s.profile(s.bob);const folder=mkdtempSync(join(tmpdir(),'qgroup-roster-probe-'));const path=join(folder,'synthetic.sqlite3');
    try{
      await s.db.backup(path);const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'}));const original=probe();
      const expected=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from qgroup_core import roster
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
rows=roster.serialize(db,event,'alice')['participants']
access=[dict(id=e['id'],viewer=viewer,allowed=e['status']!='deleted' and roster.can_access(db,e,viewer)) for e in db.execute('SELECT * FROM events') for viewer in [None,'alice','bob']]
print(json.dumps(dict(rows=[dict(id=r['id'],name=r['nickname'],position=r['position'],waitingPosition=r['waiting_position'],isGuest=r['is_guest'],payerName=r['payer_name']) for r in rows],access=access)))`,path],{encoding:'utf8',env:{...process.env,QQ_APP_ID:'',QQ_APP_KEY:''}}));
      const tables=['attendees','events','roster_parties','event_access','event_roles','settlements','finance_entries','bot_outbox','bot_settings','music_profiles','music_selections','music_profile_fields','music_field_history','account_audit','event_audit','attendee_claims'];const before=tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
      const result=(await s.get('listen/roster',s.alice)).json();expect(result.participants.map(({id,name,position,waitingPosition,isGuest,payerName}:Record<string,unknown>)=>({id,name,position,waitingPosition,isGuest,payerName}))).toEqual(expected.rows);
      for(const access of expected.access as {id:string;viewer:string|null;allowed:boolean}[])expect((await s.get(access.id,access.viewer==='alice'?s.alice:access.viewer==='bob'?s.bob:{})).statusCode).toBe(access.allowed?200:404);
      await s.music('self-listen');await s.music('managed-listen');await s.music('guest-active');expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
      await s.db.backup(path);expect(probe()).toEqual(original);
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
