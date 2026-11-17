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
    const fieldInput = { profileId:s.id,musicEpoch:member.musicEpoch,revision:0,name:'移交前的成分稱呼',note:'移交前私人留言',gender:'',genderPublic:false }; const fieldKey=randomUUID();
    const fields = (key=fieldKey) => s.app.inject({method:'PUT',url:'/api/v2/me/music/fields',headers:{cookie:s.bob.cookie,origin,'x-account-scope':member.scope,'x-csrf-token':member.csrf,'idempotency-key':key},payload:fieldInput});
    expect((await fields()).statusCode).toBe(200);
    const contact = (await s.get(s.bob,'/me/music/contact')).json();
    s.db.prepare("INSERT INTO request_results VALUES('bob','contact-receipt','old',?,200,'before')").run(JSON.stringify(contact)); s.db.prepare("INSERT INTO music_profile_receipts VALUES('bob','contact-receipt',?)").run(s.id);
    const p = await s.preview('alice'); const input = {targetUserId:'alice',revision:p.revision,reason:'核對移交',confirm:true}; const requestKey = randomUUID();
    expect((await s.command(s.alice,s.path+'/link',input,requestKey)).statusCode).toBe(200); await s.change('bob');
    expect((await put()).statusCode).toBe(410); expect((await put()).json().code).toBe('PROFILE_REASSIGNED');
    expect((await fields()).statusCode).toBe(410); expect((await fields(randomUUID())).json().code).toBe('PROFILE_ERASED');
    expect(s.db.prepare('SELECT name,note FROM music_profile_fields WHERE profile_id=?').get(s.id)).toEqual({name:'移交前的成分稱呼',note:'移交前私人留言'});
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

describe('administrator PIN reset and imported ownership history', () => {
  const input = (revision = 7, pin = '654321') => ({ revision, pin, reason: '已核對口令重設申請', confirm: true });
  it('resets only the numeric legacy PIN, preserves ownership and Python bot behavior, and never returns proofs', async () => {
    const s = await setup(); await s.change('bob');
    s.db.prepare("UPDATE music_legacy_profiles SET ownership_source='oauth' WHERE profile_id=?").run(s.id);
    const tables = ['events','attendees','roster_parties','finance_entries','settlements','settlement_history','bot_settings','bot_outbox','users','browser_sessions','external_identities','music_selections','music_profile_contacts','music_account_epochs'];
    const before = tables.map(table => s.db.prepare('SELECT * FROM '+table).all());
    const folder = mkdtempSync(join(tmpdir(),'qgroup-pin-bot-')); const snapshot = join(folder,'synthetic.sqlite3');
    try {
      await s.db.backup(snapshot); const probe = () => JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',snapshot],{encoding:'utf8'})); const bot = probe();
      const response = await s.command(s.alice,s.path+'/pin',input(8)); expect(response.statusCode,response.body).toBe(200); expect(response.json()).toEqual({ok:true});
      expect(s.db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(s.id)).toEqual({pin_hash:hash('jpm-pin|654321')});
      expect((await s.get(s.alice,s.path)).json()).toMatchObject({owner:{id:'bob'},status:'oauth',hasPin:true,revision:9});
      expect(tables.map(table => s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
      const old = await s.post(s.guest,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'654321',consent:true}); expect(old.json().code).toBe('PROFILE_LINKED');
      expect((await s.get(s.guest,'/session')).json().authenticated).toBe(false);
      const history = await s.get(s.alice,s.path+'/pin-history'); expect(history.json().history).toMatchObject([{revision:9,reason:input().reason,actor:'小青'}]); expect(history.body).not.toMatch(/654321|jpm-pin|pin_hash|credential:|actor_ref/);
      expect(s.db.prepare('SELECT response_json FROM auth_requests WHERE response_json LIKE ?').get('%music_pin_reset%')).toEqual({response_json:JSON.stringify({ok:true,operation:'music_pin_reset',profileId:s.id})});
      await s.db.backup(snapshot); expect(probe()).toEqual(bot);
    } finally { rmSync(folder,{recursive:true,force:true}); }
  });
  it('requires authority, Origin, scope, both CSRF checks and explicit validated input for reset and result lookup', async () => {
    const s = await setup();
    for(const b of [s.guest,s.bob]) for(const suffix of ['/pin','/pin-result','/pin-history']) {
      const response = suffix === '/pin-history' ? await s.get(b,s.path+suffix) : await s.command(b,s.path+suffix,suffix === '/pin' ? input() : {requestId:randomUUID()}); expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    for (const extra of [{origin:'https://evil.test'},{'x-csrf-token':'wrong'},{'x-account-scope':'stale'},{'x-admin-csrf':'wrong'}] as Record<string,string>[]) {
      expect((await s.command(s.alice,s.path+'/pin',input(),randomUUID(),extra)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await s.command(s.alice,s.path+'/pin-result',{requestId:randomUUID()},randomUUID(),extra)).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(s.db.prepare('SELECT * FROM music_pin_history').all()).toEqual([]);
  });
  it('rejects malformed PINs and confirmations without modifying the original hash', async () => {
    const s = await setup(); const before = s.db.prepare('SELECT * FROM music_legacy_profiles').all();
    for(const patch of [{pin:'123'},{pin:'1234567'},{pin:'１２３４'},{pin:1234},{confirm:false},{reason:''},{revision:-1},{extra:true}]) expect((await s.command(s.alice,s.path+'/pin',{...input(),...patch})).statusCode).toBe(400);
    expect(s.db.prepare('SELECT * FROM music_legacy_profiles').all()).toEqual(before); expect(s.db.prepare('SELECT * FROM music_pin_history').all()).toEqual([]);
  });
  it('supports rescue administrators and PIN-less numeric profiles but rejects native and erased profiles', async () => {
    const s = await setup(); const login=await s.post(s.guest,'/admin/login',{key,confirm:true});s.guest.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
    const third=(s.db.prepare("SELECT profile_id FROM music_legacy_profiles WHERE legacy_key='10003'").get() as {profile_id:string}).profile_id;
    expect((await s.command(s.guest,'/admin/music/'+third+'/pin',input())).statusCode).toBe(200);
    const history=(await s.get(s.guest,'/admin/music/'+third+'/pin-history')).json();expect(history.history[0].actor).toBe('救援憑證'); expect(JSON.stringify(history)).not.toMatch(/credential:|token_hash/);
    s.db.prepare("UPDATE music_legacy_profiles SET legacy_key='m_native' WHERE profile_id=?").run(s.id);
    expect((await s.command(s.alice,s.path+'/pin',input())).json().code).toBe('PIN_NOT_SUPPORTED');
    s.db.prepare("UPDATE music_profiles SET erased_at='erased' WHERE id=?").run(s.id); expect((await s.command(s.alice,s.path+'/pin',input())).statusCode).toBe(404);
  });
  it('revokes pending recovery and imported sessions without touching ordinary login, limits or other profiles', async () => {
    const s=await setup();
    const claim=(await s.post(s.bob,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'123456',consent:true})).json();expect(claim.status).toBe('pending');
    const second=await s.browser();expect((await s.post(second,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10002',pin:'123456',consent:true})).statusCode).toBe(200);
    const tokenHash=hash('fixture-bob'); const stamp='2026-11-17T08:00:00.000Z';
    for(const id of ['claim-auth','ordinary'])s.db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,mode,status,expires_at,created_at,app_id,union_id) VALUES(?,?,'bob','qq','bind','verified',?,?,'synthetic','private-union')").run(id,tokenHash,'2026-11-17T08:10:00.000Z',stamp);
    s.db.prepare("UPDATE music_claim_intents SET attempt_id='claim-auth' WHERE id=?").run(claim.claimId);
    for(const [index,qq]of ['10001','10002'].entries())for(const table of ['sessions','entry_intents']) {
      s.db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run(table,index,JSON.stringify({qq,token_hash:'old-proof-'+qq}));
      s.db.prepare('INSERT INTO migration_map VALUES(?,?,?,?,?,?,?)').run('music-identity',table,String(index),table+':'+index,'','synthetic','requires_legacy_adapter');
    }
    const limits=s.db.prepare('SELECT * FROM music_claim_attempts').all();
    expect((await s.command(s.alice,s.path+'/pin',input())).statusCode).toBe(200);
    expect(s.db.prepare("SELECT status,union_id FROM login_attempts WHERE id='claim-auth'").get()).toEqual({status:'failed',union_id:''}); expect(s.db.prepare("SELECT status FROM login_attempts WHERE id='ordinary'").get()).toEqual({status:'verified'});
    expect(s.db.prepare('SELECT id FROM music_claim_intents WHERE profile_id=?').all(s.id)).toEqual([]); expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toHaveLength(1);expect(s.db.prepare('SELECT * FROM music_claim_attempts').all()).toEqual(limits);
    expect(s.db.prepare('SELECT payload_json FROM music_legacy_identity').all()).toHaveLength(2);expect(s.db.prepare("SELECT status FROM migration_map WHERE source_id='0'").all()).toEqual([{status:'erased'},{status:'erased'}]);
    expect((await s.post(s.bob,'/music/claim/finish',{claimId:claim.claimId,confirm:true})).statusCode).toBe(409);
    expect((await s.post(s.bob,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'123456',consent:true})).json().code).toBe('PIN_INVALID');
    expect((await s.post(s.bob,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'654321',consent:true})).json().status).toBe('pending');
    expect((await s.get(s.bob,'/session')).json().authenticated).toBe(true);
  });
  it('checks versions and receipt content, queries lost results, never reapplies old receipts and rechecks revoked authority', async () => {
    const s=await setup();const requestId=randomUUID();const payload=input();
    expect((await s.command(s.alice,s.path+'/pin-result',{requestId})).json()).toEqual({status:'not_found'});
    expect((await s.command(s.alice,s.path+'/pin',payload,requestId)).statusCode).toBe(200);
    expect((await s.command(s.alice,s.path+'/pin',input())).json().code).toBe('MUSIC_PIN_CHANGED');
    expect((await s.command(s.alice,s.path+'/pin',input(8,'4321'))).statusCode).toBe(200);
    expect((await s.command(s.alice,s.path+'/pin',payload,requestId)).statusCode).toBe(200);
    expect(s.db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(s.id)).toEqual({pin_hash:hash('jpm-pin|4321')});expect(s.db.prepare('SELECT * FROM music_pin_history').all()).toHaveLength(2);
    expect((await s.command(s.alice,s.path+'/pin-result',{requestId})).json()).toEqual({status:'completed'});
    expect((await s.command(s.alice,s.path+'/pin',{...payload,pin:'1234'},requestId)).json().code).toBe('REQUEST_CONFLICT');
    const another=(s.db.prepare("SELECT profile_id FROM music_legacy_profiles WHERE legacy_key='10002'").get() as {profile_id:string}).profile_id;
    expect((await s.command(s.alice,'/admin/music/'+another+'/pin-result',{requestId})).json().code).toBe('REQUEST_CONFLICT');
    const p=await s.preview('bob');const linkId=randomUUID();await s.command(s.alice,s.path+'/link',{targetUserId:'bob',revision:p.revision,reason:'synthetic',confirm:true},linkId);
    expect((await s.command(s.alice,s.path+'/pin-result',{requestId:linkId})).json().code).toBe('REQUEST_CONFLICT');
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run(); expect((await s.command(s.alice,s.path+'/pin-result',{requestId})).statusCode).toBe(403);
  });
  it('rolls back hash, revision, revoked proofs and history if audit or acknowledgement fails', async () => {
    const s=await setup(); const claim=(await s.post(s.bob,'/music/claim/start',{requestId:randomUUID(),legacyQQ:'10001',pin:'123456',consent:true})).json();
    const tables=['music_profiles','music_legacy_profiles','music_claim_intents','music_pin_history','auth_requests'];const before=tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
    for(const table of ['music_pin_history','auth_requests']){
      s.db.exec(`CREATE TRIGGER reject_pin BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END`);
      const response=await s.command(s.alice,s.path+'/pin',input());expect(response.statusCode).toBe(500);expect(response.body).not.toContain('private synthetic');expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);s.db.exec('DROP TRIGGER reject_pin');
    }
    expect(s.db.prepare('SELECT id FROM music_claim_intents').get()).toEqual({id:claim.claimId});
  });
  it('retains PIN audits under account privacy review, erases them only with music and paginates without secret references', async () => {
    const s=await setup();await s.change('bob');expect((await s.command(s.alice,s.path+'/pin',input(8))).statusCode).toBe(200);
    expect(sharedRecords(s.db,'alice').music_pin_history).toBe(1);expect(sharedRecords(s.db,'bob').music_pin_history).toBe(1);
    expect(()=>s.db.exec("UPDATE music_pin_history SET reason='overwrite'")).toThrow('append-only');expect(()=>s.db.exec('DELETE FROM music_pin_history')).toThrow('append-only');
    for(let i=0;i<51;i++)s.db.prepare('INSERT INTO music_pin_history(profile_id,revision,actor_ref,reason,created_at) VALUES(?,?,?,?,?)').run(s.id,100+i,'credential:private-digest','合成歷史','before');
    const first=(await s.get(s.alice,s.path+'/pin-history')).json();const second=(await s.get(s.alice,s.path+'/pin-history?before='+first.nextCursor)).json();expect(first.history).toHaveLength(50);expect(second.history).toHaveLength(2);expect(new Set([...first.history,...second.history].map(row=>row.id)).size).toBe(52);expect(JSON.stringify(first)).not.toContain('private-digest');
    expect((await s.post(s.bob,'/me/privacy/erase',{target:'music',profileId:s.id,profileRevision:9,requestId:randomUUID(),secret:'b'.repeat(64),confirm:true})).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM music_pin_history').all()).toEqual([]);
  });
  it('combines paginated original and new ownership history, preserving original IDs, seconds, null ownership and all source rows', async () => {
    const s=await setup();
    for(let i=0;i<53;i++) s.db.prepare("INSERT INTO music_legacy_identity VALUES('link_audit',?,?)").run(i,JSON.stringify({id:10+i*3,qq:'10001',actor:i%2?'credential:private-old':'account:alice',before_user_id:i%2?'bob':'',after_user_id:i%2?'':'bob',created:1794902400.25+i}));
    s.db.prepare("INSERT INTO music_legacy_identity VALUES('link_audit',99,?)").run(JSON.stringify({id:99,qq:'10002',actor:'private-other',before_user_id:'',after_user_id:'bob',created:1794902400}));
    const original=s.db.prepare('SELECT * FROM music_legacy_identity').all();await s.change('bob');
    const first=await s.get(s.alice,s.path+'/history');const page=first.json();const second=(await s.get(s.alice,s.path+'/history?before='+page.nextCursor)).json();
    expect(page.history).toHaveLength(50);expect(second.history).toHaveLength(4);expect(page.history[0]).toMatchObject({source:'unified',legacyId:null,revision:8});expect(page.nextCursor).toBeLessThan(0);
    const all=[...page.history,...second.history];expect(new Set(all.map(row=>row.id)).size).toBe(54);expect(all.filter(row=>row.source==='legacy').map(row=>row.legacyId)).toEqual(Array.from({length:53},(_,i)=>10+(52-i)*3));expect(all.at(-1)).toMatchObject({source:'legacy',legacyId:10,revision:null,beforeUserId:null,afterUserId:'bob',actor:'小青',createdSeconds:1794902400.25,createdAt:'2026-11-17T08:00:00.250Z'});
    expect(JSON.stringify(all)).not.toMatch(/private-old|private-other|credential:|actor_ref/);expect(s.db.prepare('SELECT * FROM music_legacy_identity').all()).toEqual(original);
  });
  it('reports malformed original history without discarding or exposing private migration evidence', async () => {
    const s=await setup();
    for(const patch of [{created:'invalid'},{created:null},{created:8640000000001},{id:-1},{before_user_id:123}]) {
      s.db.prepare("INSERT OR REPLACE INTO music_legacy_identity VALUES('link_audit',0,?)").run(JSON.stringify({id:1,qq:'10001',actor:'private-source',before_user_id:'',after_user_id:'bob',created:1794902400,...patch}));
      const response=await s.get(s.alice,s.path+'/history');expect(response.statusCode).toBe(503);expect(response.json().code).toBe('MUSIC_HISTORY_INVALID');expect(response.body).not.toContain('private-source');expect(s.db.prepare('SELECT * FROM music_legacy_identity').all()).toHaveLength(1);
    }
  });
});

describe('management acknowledgement compatibility after music erasure', () => {
  it('keeps original accepted link and PIN acknowledgements without recreating erased profiles or accepting new commands', async () => {
    const s = await setup();
    const review = await s.preview('bob'), linkKey = randomUUID(), pinKey = randomUUID();
    const link = { targetUserId:'bob', revision:review.revision, reason:'刪除前已確認的關聯', confirm:true };
    expect((await s.command(s.alice,s.path+'/link',link,linkKey)).statusCode).toBe(200);
    const pin = { pin:'4321', revision:8, reason:'刪除前已確認的口令', confirm:true };
    expect((await s.command(s.alice,s.path+'/pin',pin,pinKey)).statusCode).toBe(200);
    const deletion = (await s.get(s.alice,s.path+'/erase')).json();
    expect((await s.command(s.alice,s.path+'/erase',{revision:deletion.revision,requestId:randomUUID(),secret:'a'.repeat(64),confirm:'DELETE'})).statusCode).toBe(200);
    const tables = ['music_profiles','music_legacy_profiles','music_ownership_history','music_pin_history','music_account_epochs','bot_outbox','bot_settings'];
    const before = tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
    expect((await s.get(s.alice,s.path)).json().code).toBe('PROFILE_NOT_FOUND');
    expect((await s.command(s.alice,s.path+'/link',link,linkKey)).json()).toEqual({ok:true});
    expect((await s.command(s.alice,s.path+'/pin-result',{requestId:pinKey})).json()).toEqual({status:'completed'});
    expect((await s.command(s.alice,s.path+'/pin-result',{requestId:randomUUID()})).json()).toEqual({status:'not_found'});
    expect((await s.command(s.alice,s.path+'/link',link)).json().code).toBe('PROFILE_NOT_FOUND');
    expect((await s.command(s.alice,s.path+'/pin',pin)).json().code).toBe('PROFILE_NOT_FOUND');
    expect((await s.command(s.alice,s.path+'/link',{...link,reason:'另一份內容'},linkKey)).json().code).toBe('REQUEST_CONFLICT');
    expect((await s.command(s.bob,s.path+'/pin-result',{requestId:pinKey})).statusCode).toBe(403);
    expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
  });
});
