import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { musicClaimFixture } from '../testsupport/music-claim-fixture';
import { createApp, hash } from './app';
import { sharedRecords } from './privacy';
const origin = 'https://rebuild.example'; const key = 'synthetic-admin-rescue-' + 'x'.repeat(32);
const cleanups: (() => Promise<void>)[] = []; afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db); musicClaimFixture(db);
  db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'before')").run();
  const app = createApp({ db, origin, adminCredentialHash: () => hash(key), now: () => new Date('2026-11-17T08:00:00Z') }); await app.ready();
  cleanups.push(async () => { await app.close(); db.close(); });
  async function browser(account = '') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie: account ? 'kanban_session=fixture-' + account : '' } });
    return { cookie: account ? 'kanban_session=fixture-' + account : String(response.headers['set-cookie']).split(';')[0]!, viewer: response.json() };
  }
  type Browser = Awaited<ReturnType<typeof browser>>;
  const get = (b: Browser, path: string) => app.inject({ url: '/api/v2' + path, headers: { cookie: b.cookie, 'x-account-scope': b.viewer.scope } });
  const post = (b: Browser, path: string, payload: object, extra: Record<string,string> = {}) => app.inject({ method: 'POST', url: '/api/v2' + path, payload, headers: { cookie: b.cookie, origin, 'x-account-scope': b.viewer.scope, 'x-csrf-token': b.viewer.csrf, ...extra } });
  async function command(b: Browser, path: string, payload: object, requestKey = randomUUID(), extra: Record<string,string> = {}) {
    const access = (await get(b, '/admin/session')).json(); return post(b, path, payload, { 'x-admin-csrf': access.adminCsrf ?? 'none', 'idempotency-key': requestKey, ...extra });
  }
  const alice = await browser('alice'); const bob = await browser('bob'); const guest = await browser();
  const id = (db.prepare("SELECT profile_id FROM music_legacy_profiles WHERE legacy_key='10001'").get() as { profile_id: string }).profile_id;
  const path = '/admin/music/' + id;
  const preview = async (targetUserId: string | null, b = alice) => (await command(b, path + '/link-preview', { targetUserId })).json();
  const change = async (targetUserId: string | null, b = alice) => { const p = await preview(targetUserId, b); return command(b, path + '/link', { targetUserId, revision: p.revision, reason: '已核對原資料與管理權', confirm: true }); };
  return { db, app, alice, bob, guest, browser, get, post, command, id, path, preview, change };
}
describe('unified administrator music ownership', () => {
  it('searches original IDs, names, current contacts and owners with separate statuses, pagination and no private proofs', async () => {
    const s = await setup();
    const response = await s.command(s.alice, '/admin/music/search', { search: '10001' });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ total: 1, limit: 20, offset: 0, profiles: [{ id: s.id, name: '舊成分 10001', hasPin: true, status: 'unlinked', owner: null, selections: [{ entryId: 'sub-2', level: 4 }] }] });
    expect(response.body).not.toMatch(/private|gender|note|pin_hash|pinHash|token_hash|jpm-pin/);
    expect((await s.change('bob')).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/music/search', { search: 'bob', status: 'prelinked' })).json().total).toBe(1);
    expect((await s.command(s.alice, '/admin/music/search', { search: 'bob', status: 'oauth' })).json().total).toBe(0);
    for (let i = 0; i < 22; i++) s.db.prepare("INSERT INTO music_profiles VALUES(?,NULL,0,'before',NULL)").run('m_' + String(i).padStart(24, '0'));
    const first = (await s.command(s.alice, '/admin/music/search', {})).json(); const second = (await s.command(s.alice, '/admin/music/search', { offset: 20 })).json();
    expect(first.profiles).toHaveLength(20); expect(second.profiles).toHaveLength(5); expect(new Set([...first.profiles,...second.profiles].map(row => row.id)).size).toBe(25);
    expect((await s.command(s.alice, '/admin/music/search', { search: '%' })).json().total).toBe(0);
    expect((await s.command(s.alice, '/admin/music/search', { search: 'x'.repeat(101) })).statusCode).toBe(400);
  });
  it('requires current account or rescue authority, origin, both CSRF checks and account scope for writes and previews', async () => {
    const s = await setup();
    for (const b of [s.guest,s.bob]) {
      expect((await s.get(b,s.path)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await s.command(b,'/admin/music/search',{})).statusCode).toBeGreaterThanOrEqual(400);
      expect((await s.preview('bob',b)).revision).toBeUndefined();
    }
    const p = await s.preview('bob'); const input = { targetUserId: 'bob', revision: p.revision, reason: '確認原資料', confirm: true };
    for (const extra of [{origin:'https://evil.test'},{'x-csrf-token':'wrong'},{'x-account-scope':'stale'},{'x-admin-csrf':'forged'}] as Record<string,string>[]) expect((await s.command(s.alice,s.path+'/link',input,randomUUID(),extra)).statusCode).toBeGreaterThanOrEqual(400);
    for (const patch of [{confirm:false},{reason:''},{targetUserId:12},{revision:0},{unexpected:true}]) expect((await s.command(s.alice,s.path+'/link',{...input,...patch})).statusCode).toBe(400);
    const login = await s.post(s.guest,'/admin/login',{key,confirm:true}); s.guest.cookie += '; '+String(login.headers['set-cookie']).split(';')[0];
    expect((await s.change('bob',s.guest)).statusCode).toBe(200); expect((await s.get(s.guest,s.path+'/history')).body).not.toMatch(/credential:|token_hash|actor_ref/);
  });
  it('previews without writes and preserves profiles, contacts, original order, finance and Python bot data through reassignment and unlink', async () => {
    const s = await setup(); const tables = ['users','external_identities','attendees','events','roster_parties','settlements','settlement_history','finance_entries','bot_outbox','bot_settings','music_selections','music_profile_contacts','browser_sessions'];
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-ownership-bot-')); const snapshot = join(folder, 'synthetic.sqlite3');
    cleanups.unshift(async () => { rmSync(folder, { recursive: true, force: true }); });
    await s.db.backup(snapshot);
    const probe = () => JSON.parse(execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', snapshot], { encoding: 'utf8' }));
    const originalBotView = probe();
    const before = tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
    const p = await s.preview('bob'); expect(p.target).toEqual({id:'bob',nickname:'小白'}); expect(p.profile.owner).toBeNull(); expect(s.db.prepare('SELECT * FROM music_ownership_history').all()).toEqual([]);
    for (const target of ['bob','alice',null]) expect((await s.change(target)).statusCode).toBe(200);
    expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
    expect((await s.get(s.alice,s.path)).json()).toMatchObject({owner:null,status:'unlinked',revision:10,hasPin:true,selections:p.profile.selections});
    expect(s.db.prepare('SELECT before_user_id,after_user_id FROM music_ownership_history ORDER BY id').all()).toEqual([{before_user_id:null,after_user_id:'bob'},{before_user_id:'bob',after_user_id:'alice'},{before_user_id:'alice',after_user_id:null}]);
    expect(s.db.prepare('SELECT * FROM music_account_epochs ORDER BY user_id').all()).toEqual([{user_id:'alice',epoch:2},{user_id:'bob',epoch:2}]);
    expect(()=>s.db.exec('DELETE FROM music_ownership_history')).toThrow('append-only'); expect(()=>s.db.exec("UPDATE music_ownership_history SET reason='overwrite'")).toThrow('append-only'); expect(s.db.pragma('foreign_key_check')).toEqual([]);
    await s.db.backup(snapshot); expect(probe()).toEqual(originalBotView);
  });
  it('never overwrites an existing target profile, rejects closed/missing targets and detects concurrent or ABA preview changes', async () => {
    const s = await setup(); const p = await s.preview('bob');
    expect((await s.change('alice')).statusCode).toBe(200); expect((await s.command(s.alice,s.path+'/link',{targetUserId:'bob',revision:p.revision,reason:'舊預覽',confirm:true})).json().code).toBe('MUSIC_LINK_CHANGED');
    const another = (s.db.prepare("SELECT profile_id FROM music_legacy_profiles WHERE legacy_key='10002'").get() as {profile_id:string}).profile_id;
    expect((await s.command(s.alice,'/admin/music/'+another+'/link-preview',{targetUserId:'alice'})).json().code).toBe('PROFILE_EXISTS');
    expect((await s.preview('missing')).code).toBe('USER_NOT_FOUND');
    const fresh = await s.preview('bob'); s.db.prepare("INSERT INTO music_account_epochs VALUES('bob',1)").run();
    expect((await s.command(s.alice,s.path+'/link',{targetUserId:'bob',revision:fresh.revision,reason:'過期目標版本',confirm:true})).statusCode).toBe(409);
    s.db.prepare("INSERT INTO privacy_requests VALUES('closed','bob','shared_review','before','before','')").run(); expect((await s.preview('bob')).code).toBe('USER_NOT_FOUND');
  });
  it('retires former receipts and stale writes even after relinking the same owner, while retries acknowledge without reapplying', async () => {
    const s = await setup(); await s.change('bob'); const member = (await s.get(s.bob,'/session')).json(); const profile = (await s.get(s.bob,'/me/music')).json();
    const save = {profileId:s.id,revision:profile.revision,musicEpoch:member.musicEpoch,selections:[{entryId:'sub-0',level:3}]}; const saveKey = randomUUID();
    const put = () => s.app.inject({method:'PUT',url:'/api/v2/me/music',headers:{cookie:s.bob.cookie,origin,'x-account-scope':member.scope,'x-csrf-token':member.csrf,'idempotency-key':saveKey},payload:save});
    expect((await put()).statusCode).toBe(200);
    const contact = (await s.get(s.bob,'/me/music/contact')).json();
    s.db.prepare("INSERT INTO request_results VALUES('bob','contact-receipt','old',?,200,'before')").run(JSON.stringify(contact)); s.db.prepare("INSERT INTO music_profile_receipts VALUES('bob','contact-receipt',?)").run(s.id);
    const p = await s.preview('alice'); const input = {targetUserId:'alice',revision:p.revision,reason:'核對移交',confirm:true}; const requestKey = randomUUID();
    expect((await s.command(s.alice,s.path+'/link',input,requestKey)).statusCode).toBe(200); await s.change('bob');
    expect((await put()).statusCode).toBe(410); expect((await put()).json().code).toBe('PROFILE_REASSIGNED');
    expect(s.db.prepare("SELECT response_status FROM request_results WHERE request_key='contact-receipt'").get()).toEqual({response_status:410});
    expect((await s.command(s.alice,s.path+'/link',input,requestKey)).statusCode).toBe(200); expect((await s.get(s.alice,s.path)).json().owner.id).toBe('bob');
    expect((await s.command(s.alice,s.path+'/link',{...input,reason:'另一個修改'},requestKey)).statusCode).toBe(409);
    expect(s.db.prepare('SELECT * FROM music_ownership_history').all()).toHaveLength(3);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run(); expect((await s.command(s.alice,s.path+'/link',input,requestKey)).statusCode).toBe(403);
  });
  it('rolls back ownership, epochs, proofs, receipt invalidation, history and acknowledgement as one transaction', async () => {
    const s = await setup(); const p = await s.preview('bob'); const input = {targetUserId:'bob',revision:p.revision,reason:'交易測試',confirm:true};
    const tables = ['music_profiles','music_legacy_profiles','music_account_epochs','music_claim_intents','music_legacy_identity','music_ownership_history','auth_requests']; const before=tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
    for (const target of ['music_ownership_history','auth_requests']) {
      s.db.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic fail'); END`);
      expect((await s.command(s.alice,s.path+'/link',input)).statusCode).toBe(500); expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before); s.db.exec('DROP TRIGGER reject_test');
    }
    expect((await s.command(s.alice,s.path+'/link',input)).statusCode).toBe(200);
  });
  it('invalidates competing PIN intents and their OAuth attempts, and prevents superseded source links from affecting a new owner', async () => {
    const s = await setup(); const claim = await s.post(s.bob,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'123456',consent:true}); expect(claim.statusCode).toBe(200);
    s.db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at) VALUES('proof',?,'bob','qq','app','bind','pending','2099','before')").run(hash('fixture-bob'));
    s.db.prepare("UPDATE music_claim_intents SET attempt_id='proof'").run();
    s.db.prepare("INSERT INTO music_legacy_identity VALUES('links',0,?)").run(JSON.stringify({qq:'10001',user_id:'bob'}));
    s.db.prepare("INSERT INTO music_legacy_identity VALUES('sessions',0,?)").run(JSON.stringify({qq:'10001',token_hash:'private-proof'}));
    s.db.prepare("INSERT INTO migration_map VALUES('music-identity','links','0','links:0','','source-digest','preserved')").run();
    expect((await s.change('alice')).statusCode).toBe(200); expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]); expect(s.db.prepare("SELECT status FROM login_attempts WHERE id='proof'").get()).toEqual({status:'failed'});
    expect(s.db.prepare("SELECT * FROM music_legacy_identity WHERE table_name IN ('links','sessions')").all()).toEqual([]);
    expect(s.db.prepare("SELECT status,payload_digest FROM migration_map WHERE entity_type='links'").get()).toEqual({status:'ownership_superseded',payload_digest:'source-digest'});
    expect((await s.post(s.bob,'/me/privacy/erase',{target:'account',profileId:null,profileRevision:0,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true})).statusCode).toBe(200);
    expect((await s.get(s.alice,s.path)).json()).toMatchObject({owner:{id:'alice'},status:'prelinked'});
    const folder=mkdtempSync(join(tmpdir(),'qgroup-ownership-reopen-'));const path=join(folder,'state.sqlite3');
    try {
      await s.db.backup(path);const reopened=openDatabase(path);const restarted=createApp({db:reopened,origin});
      try {
        const response=await restarted.inject({url:'/api/v2'+s.path,headers:{cookie:s.alice.cookie,'x-account-scope':s.alice.viewer.scope}});
        expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({owner:{id:'alice'},status:'prelinked'});expect(reopened.prepare("SELECT * FROM music_legacy_identity WHERE table_name IN ('links','sessions')").all()).toEqual([]);
      } finally {await restarted.close();reopened.close();}
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
  it('keeps both sides of retained ownership history under privacy review, and erases it only with the music', async () => {
    const s = await setup(); await s.change('bob'); const stale = (await s.get(s.bob,'/me/music')).json(); await s.change('alice');
    expect(sharedRecords(s.db,'bob').music_ownership_history).toBe(2); expect(sharedRecords(s.db,'alice').music_ownership_history).toBe(2);
    expect((await s.post(s.bob,'/me/privacy/erase',{target:'music',profileId:s.id,profileRevision:stale.revision,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true})).statusCode).toBe(409);
    const latest = (await s.get(s.alice,'/me/music')).json(); expect((await s.post(s.alice,'/me/privacy/erase',{target:'music',profileId:s.id,profileRevision:latest.revision,requestId:randomUUID(),secret:'b'.repeat(64),confirm:true})).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM music_ownership_history').all()).toEqual([]); expect((await s.get(s.alice,s.path)).statusCode).toBe(404); expect((await s.preview(null)).code).toBe('PROFILE_NOT_FOUND');
  });
  it('acknowledges a no-op without downgrading OAuth ownership, changing epochs or adding history', async () => {
    const s=await setup();await s.change('bob');s.db.prepare("UPDATE music_legacy_profiles SET ownership_source='oauth' WHERE profile_id=?").run(s.id);
    const before=s.db.prepare('SELECT * FROM music_profiles').all(); const epochs=s.db.prepare('SELECT * FROM music_account_epochs').all();
    expect((await s.change('bob')).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM music_profiles').all()).toEqual(before);expect(s.db.prepare('SELECT * FROM music_account_epochs').all()).toEqual(epochs);expect(s.db.prepare('SELECT * FROM music_ownership_history').all()).toHaveLength(1);expect((await s.get(s.alice,s.path)).json().status).toBe('oauth');
  });
  it('paginates history without exposing actor credentials and matches Python admin ownership transitions', async () => {
    const s = await setup(); const folder=mkdtempSync(join(tmpdir(),'qgroup-ownership-diff-'));
    try {
      const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from music_site.identity_store import Store
store=Store(sys.argv[1]);states=[]
for target in ['bob','alice','']:
    with store.connect() as db: revision=store.admin_state(db,'10001')['revision']
    state=store.admin_change('10001',target,revision,'synthetic-admin');states.append(dict(userId=state['user_id'],status=state['status']))
print(json.dumps(states))`,join(folder,'legacy.sqlite3')],{encoding:'utf8'}));
      const actual=[];for(const target of ['bob','alice',null]) {await s.change(target);const current=(await s.get(s.alice,s.path)).json();actual.push({userId:current.owner?.id??'',status:current.status});} expect(actual).toEqual(expected);
      for(let i=0;i<52;i++) s.db.prepare('INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,?,?,NULL,NULL,?,?)').run(s.id,100+i,'credential:private-digest','合成歷史','before');
      const first=(await s.get(s.alice,s.path+'/history')).json();const second=(await s.get(s.alice,s.path+'/history?before='+first.nextCursor)).json();expect(first.history).toHaveLength(50);expect(second.history).toHaveLength(5);expect(new Set([...first.history,...second.history].map(row=>row.id)).size).toBe(55);expect(JSON.stringify(first)).not.toContain('private-digest');
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
});
