import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { MusicCircles } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicCircleFixture, circleId } from '../testsupport/music-circle-fixture';
import { createApp } from './app';
const origin='https://rebuild.example',cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(db=openDatabase(':memory:')){
  fixture(db);musicCircleFixture(db);
  const app=createApp({db,origin});await app.ready();cleanup.push(async()=>{await app.close();db.close();});
  const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();
  const headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
  const read=(query='',h=headers)=>app.inject({url:'/api/v2/music/circles'+query,headers:h});
  return{db,app,headers,read};
}
describe('scoped music circles',()=>{
  it('keeps all transitive circles, strict overlap thresholds, single picks and stable duplicate-name members',async()=>{
    const s=await setup(),response=await s.read();expect(response.statusCode,response.body).toBe(200);const result=MusicCircles.parse(response.json());
    expect(result).toMatchObject({minLink:40,membersWithSelection:25,singles:2});expect(result.clusters).toHaveLength(11);
    expect(result.clusters[0]).toMatchObject({size:3,members:[{name:'橋接'},{name:'鏈尾'},{name:'鏈首'}]});
    expect(result.clusters[1]!.members.map(m=>m.name)).toEqual(['同名0','同名0']);expect(new Set(result.clusters[1]!.members.map(m=>m.id)).size).toBe(2);
    expect(result.singleMembers[0]).toMatchObject({name:'獨立選擇',pickCount:10});expect(result.singleMembers[0]!.picks).toHaveLength(8);
    const strict=MusicCircles.parse((await s.read('?minLink=100')).json());expect(strict.clusters).toHaveLength(10);expect(strict.singles).toBe(5);
  });
  it('requires current scoped membership and saved music, rejects invalid thresholds and forged viewer overrides',async()=>{
    const s=await setup();expect((await s.read('',{...s.headers,cookie:''})).statusCode).toBe(401);expect((await s.read('',{...s.headers,'x-account-scope':'wrong'})).statusCode).toBe(409);
    for(const query of ['?minLink=0','?minLink=101','?minLink=NaN','?minLink=40.5','?minLink=40&viewer=bob','?target='+circleId(2),'?minLink=40&minLink=60'])expect((await s.read(query)).statusCode,query).toBe(400);
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE user_id=?').run('alice');expect((await s.read()).statusCode).toBe(403);
  });
  it('returns only names, stable IDs and term aggregates, keeps private fields outside every response and performs no writes',async()=>{
    const s=await setup(),tables=s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
    const snapshot=()=>tables.map(({name})=>s.db.prepare('SELECT * FROM "'+name+'"').all()),before=snapshot(),writes=s.db.prepare('SELECT total_changes() n').get();
    for(const threshold of [20,40,60,100]){const response=await s.read('?minLink='+threshold);expect(response.statusCode).toBe(200);expect(response.body).not.toMatch(/998877|私人留言|性別|note|gender|contact|qq|pin|token|scope|alice|bob|user_id|sourceFields/);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers.vary).toBe('Cookie');}
    expect(snapshot()).toEqual(before);expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(writes);
  });
  it('uses current canonical names and saved selections immediately without treating empty profiles or erased members as participants',async()=>{
    const s=await setup();s.db.prepare("UPDATE music_profile_fields SET name='新橋接稱呼' WHERE profile_id=?").run(circleId(3));
    expect((await s.read()).body).toContain('新橋接稱呼');
    s.db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(circleId(3));
    const changed=MusicCircles.parse((await s.read()).json());expect(changed.membersWithSelection).toBe(24);expect(changed.singles).toBe(4);expect(changed.clusters).toHaveLength(10);
    s.db.prepare("UPDATE music_profiles SET erased_at='erased',user_id=NULL WHERE id=?").run(circleId(2));expect((await s.read()).body).not.toContain('鏈尾');
  });
  it('does not retain former ownership or epoch grants after erasure; current replacement owners must pass their own saved-profile gate',async()=>{
    const s=await setup(),profile=(await s.app.inject({url:'/api/v2/me/music',headers:s.headers})).json();
    expect((await s.app.inject({method:'POST',url:'/api/v2/me/privacy/erase',headers:s.headers,payload:{target:'music',profileId:profile.id,profileRevision:profile.revision,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true}})).statusCode).toBe(200);
    expect((await s.read()).statusCode).toBe(403);
    s.db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('alice',circleId(3));const result=MusicCircles.parse((await s.read()).json());expect(result.membersWithSelection).toBe(24);expect(JSON.stringify(result)).not.toContain('鏈首');
  });
  it('leaves actual Python bot reads, compatibility schema and pending delivery records unchanged',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'qgroup-circles-')),path=join(dir,'isolated.db');cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const s=await setup(openDatabase(path)),ddl=s.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    for(const [index,status] of ['pending','pending','sending','sent','failed','skipped'].entries())s.db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,last_error,claim_token,retry_at,simulated_at,created_at)
      VALUES('listen','synthetic',?,'synthetic-group','{"template_version":1}',?,2,?,?,?,'simulation-only','before')`).run('circle-read-'+index,status,status==='sending'?'unconfirmed delivery':'synthetic retry','claim-'+index,index===1?'2099-01-01T00:00:00Z':null);
    const queue=s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all();
    const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'})),before=probe();
    for(const threshold of [1,20,40,60,80,100])expect((await s.read('?minLink='+threshold)).statusCode).toBe(200);
    expect(probe()).toEqual(before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(queue);expect(s.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(ddl);
  });
});
