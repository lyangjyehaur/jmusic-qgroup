import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { PRIVACY_VERSION } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { musicClaimFixture } from '../testsupport/music-claim-fixture';
import { createApp, hash } from './app';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example';
async function setup(path = ':memory:') {
  const db = openDatabase(path); if (!(db.prepare("SELECT 1 FROM users WHERE id='alice'").get())) { fixture(db); nicknameFixture(db); musicClaimFixture(db); }
  let time = new Date('2026-11-17T08:00:00Z');
  const provider = { clientId: 'synthetic-qq', authorize: (state: string) => 'https://example.test/?state=' + state, exchange: async (code: string) => ({ subject: hash(code).slice(0,32).toUpperCase(), nickname: '授權 ' + code, avatarUrl: '', unionId: 'synthetic-union-' + code }) };
  const app = createApp({ db, origin, now: () => time, qq: provider }); await app.ready();
  let closed = false; const close = async () => { if (!closed) { await app.close(); db.close(); closed = true; } }; cleanups.push(close);
  async function browser(cookie = '') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } }); const viewer = response.json();
    return { cookie: String(response.headers['set-cookie'] ?? cookie).split(';')[0]!, viewer };
  }
  type Browser = Awaited<ReturnType<typeof browser>>;
  const headers = (b: Browser) => ({ cookie: b.cookie, origin, 'x-account-scope': b.viewer.scope, 'x-csrf-token': b.viewer.csrf });
  const post = (b: Browser, url: string, payload: object, override = {}, ip = '127.0.0.1') => app.inject({ method: 'POST', url: '/api/v2' + url, headers: { ...headers(b), ...override }, payload, remoteAddress: ip });
  const start = (b: Browser, qq = '10001', pin = '123456', id = randomUUID(), ip = '127.0.0.1') => post(b, '/music/claim/start', { requestId: id, legacyQQ: qq, pin, consent: true }, {}, ip);
  const status = async (b: Browser) => (await app.inject({ url: '/api/v2/music/claim', headers: headers(b) })).json();
  const finish = (b: Browser, id: string) => post(b, '/music/claim/finish', { claimId: id, confirm: true });
  const cancel = (b: Browser, id: string) => post(b, '/music/claim/cancel', { claimId: id, confirm: true });
  async function authorize(b: Browser, id?: string, code = 'new-identity', mode = b.viewer.authenticated ? 'bind' : 'login') {
    const response = await post(b, '/auth/qq/start', { mode, confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION, returnTo: '/me/music', ...(id ? { musicClaimId: id } : {}) });
    expect(response.statusCode, response.body).toBe(200); const state = new URL(response.json().authorizeUrl).searchParams.get('state')!;
    await app.inject({ url: '/auth/qq/callback?' + new URLSearchParams({ state, code }), headers: { cookie: b.cookie } });
    const result = (await app.inject({ url: '/api/v2/auth/qq/status', headers: headers(b) })).json();
    const done = await post(b, '/auth/qq/finish', { attemptId: result.attemptId, confirm: true });
    return { done, next: done.statusCode === 200 ? await browser(String(done.headers['set-cookie']).split(';')[0]) : b, attemptId: result.attemptId };
  }
  return { db, app, browser, headers, post, start, status, finish, cancel, authorize, close, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}
describe('legacy PIN and fresh QQ music claims', () => {
  it('reads only the original claim ID with device and account isolation and no business or bot writes',async()=>{
    const s=await setup(),b=await s.browser('kanban_session=fixture-bob');
    const first=(await s.start(b)).json(),second=(await s.start(b,'10002')).json();
    const get=(browser:typeof b,query:string)=>s.app.inject({url:'/api/v2/music/claim?'+query,headers:s.headers(browser)});
    const tables=['music_claim_intents','music_claim_attempts','music_profiles','music_selections','bot_settings','bot_outbox','account_audit'];
    const before=tables.map(table=>s.db.prepare('SELECT * FROM '+table).all());
    expect((await get(b,'requestId='+first.claimId)).json()).toEqual({status:'none'});
    expect((await get(b,'requestId='+second.claimId)).json()).toEqual(second);
    expect(await s.status(b)).toEqual(second);
    const guest=await s.browser(),alice=await s.browser('kanban_session=fixture-alice');
    s.db.prepare("INSERT INTO browser_sessions VALUES(?,'bob','other device')").run(hash('other-claim-device'));
    const other=await s.browser('kanban_session=other-claim-device');
    for(const browser of [guest,alice,other])expect((await get(browser,'requestId='+second.claimId)).json()).toEqual({status:'none'});
    expect((await s.app.inject({url:'/api/v2/music/claim?requestId='+second.claimId,headers:{...s.headers(b),'x-account-scope':alice.viewer.scope}})).statusCode).toBe(409);
    for(const query of ['requestId=bad','requestId=','requestId='+second.claimId+'&requestId='+first.claimId,'unexpected=value'])expect((await get(b,query)).statusCode).toBe(400);
    expect(tables.map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
    const auth=await s.authorize(b,second.claimId);expect((await get(auth.next,'requestId='+second.claimId)).json().status).toBe('authorized');
    await s.finish(auth.next,second.claimId);expect((await get(auth.next,'requestId='+second.claimId)).json().status).toBe('completed');
    expect((await s.cancel(auth.next,second.claimId)).json().status).toBe('completed');
  });

  it('finds an original profile, requires fresh QQ plus explicit final confirmation, and preserves music and bot data', async () => {
    const s = await setup(); const guest = await s.browser();
    const tables = ['events','attendees','roster_parties','finance_entries','settlements','bot_settings','bot_outbox','music_selections','music_profile_contacts','music_entry_details'];
    const before = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const original = (await s.start(guest)).json(); expect(original).toMatchObject({ status: 'pending', name: '舊成分 10001', legacyQQ: '10001', targetNickname: '' });
    s.db.prepare("INSERT INTO music_legacy_identity VALUES('sessions',0,?)").run(JSON.stringify({qq:'10001',token_hash:'synthetic-old-proof',expires:9999999999}));
    s.db.prepare("INSERT INTO migration_map VALUES('music-identity','sessions','0','sessions:0','','source-digest','requires_legacy_adapter')").run();
    expect(JSON.stringify(original)).not.toMatch(/pin|hash|token|private|gender/); expect((await s.finish(guest, original.claimId)).statusCode).toBe(401);
    const auth = await s.authorize(guest, original.claimId); expect(auth.done.statusCode).toBe(200); expect(auth.done.json().returnTo).toBe('/me/music/recover');
    const member = auth.next; expect((await s.status(member)).status).toBe('authorized'); expect((await s.status(guest)).code).toBe('SESSION_EXPIRED');
    expect((await s.app.inject({ url: '/api/v2/me/music', headers: s.headers(member) })).json()).toBeNull();
    const linked = await s.finish(member, original.claimId); expect(linked.json()).toMatchObject({ status: 'completed', profileId: original.profileId });
    expect((await s.finish(member, original.claimId)).json()).toEqual(linked.json());
    expect((await s.app.inject({ url: '/api/v2/me/music', headers: s.headers(member) })).json()).toMatchObject({ id: original.profileId, revision: 8, selections: [{ entryId: 'sub-2', level: 4 }] });
    expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(s.db.prepare('SELECT count(*) n FROM music_profile_audit').get()).toEqual({ n: 1 }); expect(s.db.prepare("SELECT count(*) n FROM account_audit WHERE action='music_claimed'").get()).toEqual({ n: 1 });
    expect(s.db.prepare("SELECT 1 FROM music_legacy_identity WHERE table_name='sessions'").get()).toBeUndefined();expect(s.db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND entity_type='sessions'").get()).toEqual({status:'erased'});
    expect((await s.browser(member.cookie)).viewer.musicEpoch).toBe(1);
    const other = await s.browser(); expect((await s.start(other)).json().code).toBe('PROFILE_LINKED');
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('preserves actual Python bot reads and all delivery states across targeted recovery, QQ authorization and linking',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'qgroup-claim-bot-')),path=join(folder,'synthetic.db');
    try{
      const s=await setup(path),b=await s.browser('kanban_session=fixture-bob');
      for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,created_at) VALUES('listen','synthetic',?,'synthetic','{}',?,2,?,'retry-time','simulated','before')`).run('claim-key-'+i,status,'claim-'+i);
      const probe=()=>JSON.parse(execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'}));
      const tables=['events','attendees','roster_parties','finance_entries','settlements','bot_settings','bot_outbox'],snapshot=()=>tables.map(table=>s.db.prepare('SELECT * FROM '+table).all()),before=snapshot(),bot=probe();
      const claim=(await s.start(b)).json(),auth=await s.authorize(b,claim.claimId);
      expect((await s.app.inject({url:'/api/v2/music/claim?requestId='+claim.claimId,headers:s.headers(auth.next)})).json().status).toBe('authorized');
      expect((await s.finish(auth.next,claim.claimId)).json().status).toBe('completed');expect((await s.cancel(auth.next,claim.claimId)).json().status).toBe('completed');
      expect(probe()).toEqual(bot);expect(snapshot()).toEqual(before);await s.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('reuses a name-only account and its stable nickname without merging another account or replacing its QQ', async () => {
    const s = await setup(); const alice = await s.browser('kanban_session=fixture-alice'); const original = (await s.start(alice)).json();
    expect((await s.finish(alice, original.claimId)).json().code).toBe('CLAIM_OAUTH_REQUIRED');
    const auth = await s.authorize(alice, original.claimId); expect(auth.done.statusCode).toBe(200); expect(auth.next.viewer.scope).toBe(alice.viewer.scope); expect(auth.next.viewer.nickname).toBe('小青');
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect((await s.finish(auth.next, original.claimId)).json().status).toBe('completed');
    expect(s.db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(original.profileId)).toEqual({ user_id: 'alice' });
    const newAttempt = (await s.start(await s.browser('kanban_session=fixture-bob'), '10002')).json();
    const conflict = await s.authorize(await s.browser('kanban_session=fixture-bob'), newAttempt.claimId, 'new-identity'); expect(conflict.done.json().code).toBe('QQ_CONFLICT');
    expect(s.db.prepare("SELECT user_id FROM music_profiles WHERE user_id='bob'").get()).toBeUndefined();
  });
  it('rejects wrong, missing and PIN-less profiles uniformly, and refuses to overwrite a current profile', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob');
    for (const [qq,pin] of [['10001','000000'],['10003','123456'],['99999','123456']]) expect((await s.start(b, qq, pin)).json().code).toBe('PIN_INVALID');
    for (const [qq,pin] of [['123','123456'],['10001','123'],['10001','１２３４'],['10001','1234567']]) expect((await s.start(b, qq, pin)).statusCode).toBe(400);
    const response = await s.app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...s.headers(b), 'idempotency-key': randomUUID() }, payload: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-1', level: 3 }] } }); expect(response.statusCode).toBe(200);
    expect((await s.start(b)).json().code).toBe('PROFILE_EXISTS'); expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]);
  });
  it('keeps a pending claim from creating a blank profile and cancels without deleting either original data or the account', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob'); const claim = (await s.start(b)).json();
    const create = () => s.app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...s.headers(b), 'idempotency-key': randomUUID() }, payload: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-1', level: 3 }] } });
    expect((await create()).json().code).toBe('MUSIC_CLAIM_PENDING'); expect((await s.cancel(b, claim.claimId)).json()).toEqual({ status: 'none' }); expect((await s.finish(b, claim.claimId)).statusCode).toBe(409);
    expect((await create()).statusCode).toBe(200); expect(s.db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(claim.profileId)).toEqual({ user_id: null });
  });
  it('binds the proof to the source browser, explicit claim attempt and original member, never to an old or unrelated OAuth', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob'); const other = await s.browser(); const claim = (await s.start(b)).json();
    expect((await s.post(other,'/auth/qq/start',{ mode:'login', confirm:true, acceptPrivacy:true, privacyVersion:PRIVACY_VERSION, musicClaimId:claim.claimId })).statusCode).toBe(409);
    expect((await s.post(b,'/auth/qq/start',{ mode:'login', confirm:true, acceptPrivacy:true, privacyVersion:PRIVACY_VERSION, musicClaimId:claim.claimId })).json().code).toBe('CLAIM_AUTH_MODE');
    const unrelated = await s.authorize(b); expect(unrelated.done.statusCode).toBe(200); expect((await s.status(unrelated.next)).status).toBe('none'); expect((await s.finish(unrelated.next, claim.claimId)).statusCode).toBe(409);
    const fresh = (await s.start(unrelated.next)).json(); expect(fresh.status).toBe('pending'); expect((await s.finish(unrelated.next, fresh.claimId)).json().code).toBe('CLAIM_OAUTH_REQUIRED');
    const guest = await s.browser(); const guestClaim = (await s.start(guest, '10002')).json();
    const nowOwner = await s.authorize(unrelated.next, fresh.claimId); expect((await s.finish(nowOwner.next, fresh.claimId)).statusCode).toBe(200);
    const collision = await s.authorize(guest, guestClaim.claimId); expect(collision.done.statusCode).toBe(409); expect((await s.status(guest)).status).toBe('pending');
  });
  it('expires ten-minute proofs, invalidates changed PINs and profile revisions, and cannot reuse replaced or cancelled intents', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob'); const a = (await s.start(b)).json(); const second = (await s.start(b,'10002')).json();
    expect((await s.finish(b,a.claimId)).statusCode).toBe(409); expect((await s.cancel(b,a.claimId)).json()).toEqual({status:'none'}); expect((await s.status(b)).claimId).toBe(second.claimId);
    s.advance(600000); expect((await s.status(b)).status).toBe('unavailable');
    expect((await s.post(b,'/auth/qq/start',{ mode:'bind',confirm:true,acceptPrivacy:true,privacyVersion:PRIVACY_VERSION,musicClaimId:second.claimId })).statusCode).toBe(409);
    const next = (await s.start(b)).json(); s.db.prepare('UPDATE music_legacy_profiles SET pin_hash=? WHERE profile_id=?').run(hash('jpm-pin|654321'),next.profileId); expect((await s.status(b)).status).toBe('unavailable');
    const final = (await s.start(b,'10001','654321')).json(); s.db.prepare('UPDATE music_profiles SET revision=revision+1 WHERE id=?').run(final.profileId); expect((await s.status(b)).status).toBe('unavailable');
  });
  it('cancels QQ authorization without consuming the PIN proof and permits a fresh attempt', async () => {
    const s = await setup(); const b = await s.browser(); const claim = (await s.start(b)).json();
    const start = await s.post(b,'/auth/qq/start',{ mode:'login',confirm:true,acceptPrivacy:true,privacyVersion:PRIVACY_VERSION,musicClaimId:claim.claimId }); expect(start.statusCode).toBe(200);
    const state = new URL(start.json().authorizeUrl).searchParams.get('state')!;
    expect((await s.post(b,'/auth/qq/cancel',{confirm:true})).json().returnTo).toBe('/me/music/recover'); expect((await s.status(b)).status).toBe('pending');
    await s.app.inject({url:'/auth/qq/callback?'+new URLSearchParams({state,code:'late'}),headers:{cookie:b.cookie}}); expect((await s.status(b)).status).toBe('pending');
    const auth = await s.authorize(b,claim.claimId); expect((await s.finish(auth.next,claim.claimId)).json().status).toBe('completed');
  });
  it('serializes competing browsers, rolls back a failing audit and retries completion once', async () => {
    const s = await setup(); const first = await s.browser('kanban_session=fixture-alice'); const second = await s.browser('kanban_session=fixture-bob');
    const a = (await s.start(first)).json(); const b = (await s.start(second)).json(); const aa = await s.authorize(first,a.claimId,'alice-qq'); const bb = await s.authorize(second,b.claimId,'bob-qq');
    s.db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON music_profile_audit BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END");
    const failure = await s.finish(aa.next,a.claimId); expect(failure.statusCode).toBe(500); expect(failure.body).not.toContain('synthetic'); expect((await s.status(aa.next)).status).toBe('authorized'); expect(s.db.prepare('SELECT user_id,revision FROM music_profiles WHERE id=?').get(a.profileId)).toEqual({ user_id:null,revision:7 });
    s.db.exec('DROP TRIGGER reject_claim'); const results = await Promise.all([s.finish(aa.next,a.claimId),s.finish(bb.next,b.claimId)]); expect(results.map(row=>row.statusCode).sort()).toEqual([200,409]); expect(s.db.prepare('SELECT count(*) n FROM music_profile_audit').get()).toEqual({n:1});
    const winner = results[0]!.statusCode === 200 ? [aa.next,a] as const : [bb.next,b] as const; expect((await s.finish(winner[0],winner[1].claimId)).json().status).toBe('completed');
  });
  it('checks scope, origin, CSRF and confirmation for PIN, cancellation and completion', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob');
    for (const [override,code] of [[{origin:'https://evil.test'},403],[{'x-account-scope':'stale'},409],[{'x-csrf-token':'a'.repeat(64)},403]] as const) {
      const input = {requestId:randomUUID(),legacyQQ:'10001',pin:'123456',consent:true}; expect((await s.post(b,'/music/claim/start',input,override)).statusCode).toBe(code);
    }
    expect(s.db.prepare('SELECT * FROM music_claim_attempts').all()).toEqual([]);
    const claim = (await s.start(b)).json(); expect((await s.post(b,'/music/claim/finish',{claimId:claim.claimId,confirm:false})).statusCode).toBe(400);
    expect((await s.post(b,'/music/claim/cancel',{claimId:claim.claimId,confirm:true},{'x-account-scope':'stale'})).statusCode).toBe(409);
    expect((await s.post(b,'/music/claim/finish',{claimId:claim.claimId,confirm:true},{origin:'https://evil.test'})).statusCode).toBe(403);
  });
  it('invalidates intents on account switch, device revocation and logout including successful authorization', async () => {
    const s = await setup(); const b = await s.browser('kanban_session=fixture-bob'); const a = (await s.start(b)).json();
    s.db.prepare("INSERT INTO browser_accounts VALUES(?,'alice','synthetic')").run(hash('fixture-bob'));
    expect((await s.post(b,'/me/accounts/switch',{scope:(await s.browser('kanban_session=fixture-alice')).viewer.scope,confirm:true})).statusCode).toBe(200); expect(s.db.prepare('SELECT 1 FROM music_claim_intents WHERE id=?').get(a.claimId)).toBeUndefined();
    const alice = await s.browser(b.cookie); const next = (await s.start(alice)).json(); const auth = await s.authorize(alice,next.claimId);
    expect((await s.post(auth.next,'/auth/logout',{confirm:true})).statusCode).toBe(200); expect((await s.finish(auth.next,next.claimId)).statusCode).toBe(401); expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]);
    const original = await s.browser('kanban_session=fixture-alice'); s.db.prepare("INSERT INTO browser_sessions VALUES(?,'alice','other')").run(hash('other-device'));
    const remote = await s.browser('kanban_session=other-device'); const remoteClaim = (await s.start(remote)).json();
    const devices = (await s.app.inject({url:'/api/v2/me/devices',headers:s.headers(original)})).json(); const target = devices.devices.find((row:{current:boolean})=>!row.current);
    expect((await s.post(original,'/me/devices/revoke',{deviceId:target.id,confirm:true})).statusCode).toBe(200); expect(s.db.prepare('SELECT 1 FROM music_claim_intents WHERE id=?').get(remoteClaim.claimId)).toBeUndefined();
  });
  for (const stage of ['pending', 'authorized', 'completed'] as const) it('preserves another account '+stage+' music claim when only an inactive device grant is revoked', async () => {
    const s = await setup(), alice = await s.browser('kanban_session=fixture-alice');
    let bob = await s.browser('kanban_session=fixture-bob');
    const link = await s.post(alice, '/me/devices/link', { confirm: true, authorizeOwnDevice: true });
    expect(link.statusCode, link.body).toBe(200);
    expect((await s.post(bob, '/device-links/accept', { token: link.json().token, confirm: true, acceptAccess: true })).statusCode).toBe(200);
    const started = await s.start(bob); expect(started.statusCode, started.body).toBe(200);
    const claim = started.json();
    if (stage !== 'pending') {
      const auth = await s.authorize(bob, claim.claimId, 'bob-grant-revocation');
      expect(auth.done.statusCode, auth.done.body).toBe(200); bob = auth.next;
      if (stage === 'completed') expect((await s.finish(bob, claim.claimId)).json().status).toBe('completed');
    }
    bob = await s.browser(bob.cookie);
    const status = await s.status(bob); expect(status.status).toBe(stage);
    const tables = ['users', 'music_claim_intents', 'music_profiles', 'music_selections', 'external_identities', 'login_attempts', 'bot_outbox', 'bot_settings'];
    const snapshot = () => tables.map(table => s.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
    const before = snapshot();
    const devices = await s.app.inject({ url: '/api/v2/me/devices', headers: s.headers(alice) });
    const remote = devices.json().devices.find((device: { current: boolean }) => !device.current);
    expect(remote).toBeDefined();
    const revoked = await s.post(alice, '/me/devices/revoke', { deviceId: remote.id, confirm: true });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await s.browser(bob.cookie)).viewer).toEqual(bob.viewer);
    expect((await s.post(bob, '/me/accounts/switch', { scope: alice.viewer.scope, confirm: true })).statusCode).toBe(403);
    expect(await s.status(bob)).toEqual(status); expect(snapshot()).toEqual(before);
    if (stage === 'pending') {
      const auth = await s.authorize(bob, claim.claimId, 'bob-grant-revocation');
      expect(auth.done.statusCode, auth.done.body).toBe(200); bob = auth.next;
    }
    expect((await s.finish(bob, claim.claimId)).json().status).toBe('completed');
  });
  it('persists QQ and IP limits across process restarts and never trusts spoofed forwarded IP headers', async () => {
    const folder = mkdtempSync(join(tmpdir(),'qgroup-pin-limits-')); const path = join(folder,'state.sqlite3');
    try {
      const s = await setup(path); const b = await s.browser();
      for(let i=0;i<8;i++) expect((await s.start(b,'10001','000000')).statusCode).toBe(403); await s.close();
      const next = await setup(path); const same = await next.browser(b.cookie); expect((await next.start(same)).statusCode).toBe(429);
      expect((await next.start(same,'10002','123456',randomUUID(),'192.0.2.2')).statusCode).toBe(200); next.advance(3600001); expect((await next.start(same)).statusCode).toBe(200);
      for(let i=0;i<30;i++) expect((await next.post(same,'/music/claim/start',{requestId:randomUUID(),legacyQQ:String(20000+i),pin:'000000',consent:true},{'x-forwarded-for':'198.51.100.'+i,'x-real-ip':'198.51.100.'+i},'192.0.2.3')).statusCode).toBe(403);
      expect((await next.start(same,'99999','000000',randomUUID(),'192.0.2.3')).json().code).toBe('PIN_RATE_LIMIT'); next.advance(900001); expect((await next.start(same,'99999','000000',randomUUID(),'192.0.2.3')).statusCode).toBe(403);
      await next.close();
    } finally { rmSync(folder,{recursive:true,force:true}); }
  });
  it('matches legacy Python QQ/IP limit boundaries without losing failed-attempt counters', async () => {
    const s = await setup(); const b = await s.browser(); const folder = mkdtempSync(join(tmpdir(),'qgroup-pin-diff-'));
    const cases = Array.from({length:10},(_,index)=>index<9?'10001':'10002');
    try {
      const expected = JSON.parse(execFileSync('python3',['-c',`import json,sys
from unittest.mock import patch
from music_site.identity_store import Store,Rejected
store=Store(sys.argv[1]);out=[]
with patch('music_site.identity_store.time.time',return_value=1794902400):
    for qq in json.loads(sys.argv[2]):
        try: store.login_allowed(qq,'127.0.0.1');out.append(403)
        except Rejected as exc: out.append(exc.status)
print(json.dumps(out))`,join(folder,'identity.sqlite3'),JSON.stringify(cases)],{encoding:'utf8'}));
      const actual=[]; for(const qq of cases) actual.push((await s.start(b,qq,'000000')).statusCode); expect(actual).toEqual(expected);
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
  it('keeps PIN intent creation idempotent, preserves the prior request on conflict and clears an authorized proof on account closure',async()=>{
    const s=await setup();const b=await s.browser('kanban_session=fixture-bob');const id=randomUUID();const original=await s.start(b,'10001','123456',id);expect((await s.start(b,'10001','123456',id)).json()).toEqual(original.json());
    expect((await s.start(b,'10002','123456',id)).json().code).toBe('REQUEST_CONFLICT');expect((await s.status(b)).claimId).toBe(id);
    const auth=await s.authorize(b,id);const closed=await s.post(auth.next,'/me/privacy/erase',{target:'account',profileId:null,profileRevision:0,requestId:randomUUID(),secret:'a'.repeat(64),confirm:true});expect(closed.statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]);expect((await s.finish(auth.next,id)).statusCode).toBe(401);expect(s.db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(original.json().profileId)).toEqual({user_id:null});
  });
  it('expires already authorized intents and erases all claim recovery paths with a claimed profile',async()=>{
    const s=await setup();const b=await s.browser('kanban_session=fixture-bob');const claim=(await s.start(b)).json();const auth=await s.authorize(b,claim.claimId);
    s.advance(600000);expect((await s.finish(auth.next,claim.claimId)).json().code).toBe('CLAIM_UNAVAILABLE');expect(s.db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(claim.profileId)).toEqual({user_id:null});
    const retry=(await s.start(auth.next)).json();const again=await s.authorize(auth.next,retry.claimId);expect((await s.finish(again.next,retry.claimId)).statusCode).toBe(200);
    const profile=(await s.app.inject({url:'/api/v2/me/music',headers:s.headers(again.next)})).json();
    expect((await s.post(again.next,'/me/privacy/erase',{target:'music',profileId:profile.id,profileRevision:profile.revision,requestId:randomUUID(),secret:'b'.repeat(64),confirm:true})).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM music_claim_intents').all()).toEqual([]);expect((await s.finish(again.next,retry.claimId)).statusCode).toBe(409);expect((await s.start(again.next)).json().code).toBe('PIN_INVALID');
  });
});
