import { randomUUID } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { ActivityAccessPreview, ActivityCopy, ActivityList, ActivityShare } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { accountKey } from './finance-context';
import { redactRequestURL } from './request-log';
const origin='https://rebuild.example',token='a'.repeat(32),stamp='2026-11-17T00:00:00+00:00';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(staticRoot?:string){
  const db=openDatabase(':memory:');fixture(db);db.prepare('UPDATE events SET revision=1,invite_token=?').run(token);
  const app=createApp({db,origin,staticRoot,now:()=>new Date(stamp)});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  async function headers(id:string){const cookie='kanban_session=fixture-'+id,viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return {cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};}
  const alice=await headers('alice'),bob=await headers('bob');
  const get=(path:string,h=bob)=>app.inject({url:'/api/v2/'+path,headers:h});
  const accept=(patch:Record<string,unknown>={},h=bob,key=randomUUID(),t=token)=>app.inject({method:'POST',url:'/api/v2/activities/invite/access/'+t+'/accept',headers:{...h,'idempotency-key':key},payload:{revision:1,confirm:true,...patch}});
  return {db,app,get,accept,alice,bob};
}
function state(db:DB,omit:string[]=[]){return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).filter(r=>!omit.includes(r.name)).map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));}
describe('activity access invitations, copy and personal entries',()=>{
  it('previews only the title and revision and performs no writes or access grant',async()=>{
    const s=await setup(),before=state(s.db);const r=await s.app.inject({url:'/api/v2/activities/invite/access/'+token});expect(r.statusCode,r.body).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.json()).toEqual(ActivityAccessPreview.parse({id:'invite',title:'私人活動',revision:1}));
    expect(state(s.db)).toEqual(before);expect((await s.get('activities/invite')).statusCode).toBe(404);
    expect(JSON.stringify(r.json())).not.toContain('私人地點');
  });
  it('grants only event_access on explicit scoped acceptance, without roster, audit, finance or outbox changes',async()=>{
    const s=await setup(),before=state(s.db,['request_results','event_access']),key=randomUUID();const response=await s.accept({},s.bob,key);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({id:'invite',granted:true});
    expect(state(s.db,['request_results','event_access'])).toEqual(before);expect(s.db.prepare('SELECT * FROM event_access').all()).toEqual([{event_id:'invite',user_id:'bob',created_at:stamp}]);
    expect((await s.get('activities/invite')).statusCode).toBe(200);expect((await s.get('activities/invite/arrangements')).json().canEdit).toBe(false);
    s.db.exec("UPDATE events SET revision=2 WHERE id='invite'");expect((await s.accept({},s.bob,key)).json()).toEqual(response.json());expect((await s.accept({revision:2},s.bob,key)).statusCode).toBe(409);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM event_access').get()).toEqual({n:1});expect(s.db.prepare('SELECT COUNT(*) AS n FROM request_results').get()).toEqual({n:1});
    s.db.exec("DELETE FROM event_access WHERE event_id='invite' AND user_id='bob'");expect((await s.accept({},s.bob,key)).statusCode).toBe(404);
  });
  it('requires confirmation, current revision, Origin, CSRF and current account scope before any grant',async()=>{
    const s=await setup();for(const patch of [{confirm:false},{revision:0},{revision:2},{extra:true}])expect((await s.accept(patch)).statusCode).toBe(patch.revision!==undefined?409:400);
    for(const patch of [{origin:'https://other.test'},{'x-csrf-token':'bad'},{'x-account-scope':'bad'},{cookie:s.alice.cookie},{cookie:''}])expect((await s.accept({}, {...s.bob,...patch})).statusCode).toBeGreaterThanOrEqual(400);
    expect(s.db.prepare('SELECT * FROM event_access').all()).toEqual([]);expect(s.db.prepare('SELECT * FROM request_results').all()).toEqual([]);
  });
  it('does not bypass invalid tokens, revoked tokens, drafts or deletion even for owners/admins or result replay',async()=>{
    const s=await setup(),key=randomUUID();s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");
    expect((await s.accept({},s.alice,randomUUID(),'b'.repeat(32))).statusCode).toBe(404);
    expect((await s.accept({},s.bob,key)).statusCode).toBe(200);s.db.prepare("UPDATE events SET revision=1,invite_token=? WHERE id='invite'").run('b'.repeat(32));expect((await s.accept({},s.bob,key)).statusCode).toBe(404);
    for(const id of ['draft','deleted','missing'])expect((await s.get('activities/'+id+'/access/'+token)).statusCode).toBe(404);
    expect((await s.get('activities/invite/access/not-a-token')).statusCode).toBe(400);
  });
  it('exposes private share tokens only to the owner, and never creates a token by reading',async()=>{
    const s=await setup(),before=state(s.db);expect(ActivityShare.parse((await s.get('activities/invite/share',s.alice)).json())).toEqual({id:'invite',path:'/activities/invite/access/'+token,invitation:true});
    expect((await s.get('activities/invite/share')).statusCode).toBe(404);expect((await s.get('activities/listen/share')).json()).toEqual({id:'listen',path:'/activities/listen',invitation:false});expect((await s.get('activities/draft/share',s.alice)).statusCode).toBe(404);
    expect((await s.app.inject({url:'/api/v2/activities/listen/share'})).json()).toEqual({id:'listen',path:'/activities/listen',invitation:false});expect((await s.app.inject({url:'/api/v2/activities/invite/share',headers:{cookie:s.alice.cookie}})).statusCode).toBe(404);expect(state(s.db)).toEqual(before);await s.accept();expect((await s.get('activities/invite/share')).statusCode).toBe(403);
    s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before'); INSERT INTO event_roles VALUES('role','invite','bob','[\"roster\"]','before')");expect((await s.get('activities/invite/share')).statusCode).toBe(403);
  });
  it('copies only arrangements from an accessible source, with no dates, token, owner, notification consent or associated records',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET bot_enabled=1,fee_policy='原費用',minimum_participants=2 WHERE id='listen'");const before=state(s.db),r=await s.get('activities/listen/copy-source');expect(r.statusCode,r.body).toBe(200);const copy=ActivityCopy.parse(r.json());
    expect(Object.keys(copy).sort()).toEqual(['id','values']);expect(copy.values).toMatchObject({title:'週末一起聽日系音樂',feePolicy:'原費用',minimumParticipants:2});
    expect(Object.keys(copy.values).sort()).toEqual(['capacity','category','description','durationHours','feePolicy','location','minimumParticipants','timezone','title','visibility'].sort());expect(state(s.db)).toEqual(before);
    expect((await s.get('activities/invite/copy-source')).statusCode).toBe(404);expect((await s.get('activities/draft/copy-source')).statusCode).toBe(404);expect((await s.get('activities/deleted/copy-source',s.alice)).statusCode).toBe(404);
  });
  it('lists ownership, cohosting, active self/managed registrations and historical financial obligations, not access alone',async()=>{
    const s=await setup();expect(ActivityList.parse((await s.get('me/activities')).json()).events).toEqual([]);
    s.db.exec("INSERT INTO event_access VALUES('invite','bob','before'); INSERT INTO event_roles VALUES('role','karaoke','bob','[]','before'); INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('self','listen','bob','bob','小白','self','tentative','before','before')");
    s.db.exec("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('past',1,500,1,'','before','alice','小青','published','[]')");s.db.prepare("INSERT INTO settlement_details VALUES('past',1,?)").run(JSON.stringify({total_cents:500,payers:[{id:accountKey('past','bob'),name:'小白',label:'小白',amount_cents:500}]}));
    const before=state(s.db),list=ActivityList.parse((await s.get('me/activities')).json());expect(list.events.map(e=>e.id).sort()).toEqual(['karaoke','listen','past']);expect(list.events.find(e=>e.id==='past')?.phase).toBe('ended');expect(state(s.db)).toEqual(before);
    const owner=ActivityList.parse((await s.get('me/activities',s.alice)).json());expect(owner.events.map(e=>e.id)).toContain('draft');expect(owner.events.map(e=>e.id)).not.toContain('deleted');
    s.db.exec("UPDATE attendees SET status='withdrawn' WHERE id='self'");expect(ActivityList.parse((await s.get('me/activities')).json()).events.map(e=>e.id).sort()).toEqual(['karaoke','past']);
  });
  it('paginates personal results after applying participation and requires scope without accepting unknown filters',async()=>{
    const s=await setup();s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");
    for(let i=0;i<23;i++)s.db.prepare("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,created_at) SELECT ?,'bob',title,category,location,starts_at,deadline,capacity,description,created_at FROM events WHERE id='listen'").run('extra-'+String(i).padStart(2,'0'));
    const first=ActivityList.parse((await s.get('me/activities')).json()),second=ActivityList.parse((await s.get('me/activities?page=2')).json());expect(first.events).toHaveLength(20);expect(first.hasMore).toBe(true);expect(second.events).toHaveLength(4);expect(second.hasMore).toBe(false);expect(new Set([...first.events,...second.events].map(e=>e.id)).size).toBe(24);
    expect((await s.app.inject({url:'/api/v2/me/activities',headers:{cookie:s.bob.cookie}})).statusCode).toBe(409);expect((await s.get('me/activities?period=history')).statusCode).toBe(400);
  });
  it('serves only whitelisted legacy HTML aliases through the SPA; unknown files and API paths stay 404',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-aliases-'));writeFileSync(join(folder,'index.html'),'<html>native-app</html>');cleanup.push(async()=>rmSync(folder,{recursive:true,force:true}));const s=await setup(folder);
    for(const path of ['/music/index.html','/music/admin.html','/privacy.html','/music/privacy.html','/contact.html']){const r=await s.app.inject({url:path+'?event=listen'});expect(r.statusCode,r.body).toBe(200);expect(r.body).toBe('<html>native-app</html>');}
    for(const path of ['/unknown.html','/api/not-real.html','/missing.js'])expect((await s.app.inject({url:path})).statusCode).toBe(404);
    expect((await s.app.inject({url:'/music/index.html',method:'POST'})).statusCode).toBe(404);
  });
  it('rejects old music internal and export APIs despite forged proxy context, cookies or bearer headers',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-bridge-rejection-'));writeFileSync(join(folder,'index.html'),'<html>native-app</html>');cleanup.push(async()=>rmSync(folder,{recursive:true,force:true}));const s=await setup(folder),before=state(s.db);
    const forged={...s.alice,'x-music-proxy-key':'synthetic','x-music-identity':Buffer.from(JSON.stringify({user_id:'alice',admin_actor:'account:alice',admin_csrf:'synthetic'})).toString('base64url'),authorization:'Bearer synthetic'};
    for(const path of ['/music/api','/music/api/me','/music/api/admin/members','/music/api/export','/music/api/qgroup/events'])for(const method of ['GET','POST'] as const){const r=await s.app.inject({url:path,method,headers:forged,...(method==='POST'?{payload:{confirm:true}}:{})});expect(r.statusCode,r.body).toBe(404);expect(r.json().code).toBe('NOT_FOUND');}
    const native=await s.app.inject({url:'/api/v2/admin/music/m_'+ 'a'.repeat(32),headers:forged});expect(native.statusCode).toBeGreaterThanOrEqual(400);expect(state(s.db)).toEqual(before);
  });
  it('redacts native access tokens and legacy query credentials from request logs',()=>{
    expect(redactRequestURL('/api/v2/activities/invite/access/'+token+'/accept?secret=anything')).toBe('/api/v2/activities/invite/access/[redacted]/accept');
    expect(redactRequestURL('/?event=invite&invite='+token)).toBe('/');
  });
});
