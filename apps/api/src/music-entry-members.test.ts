import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { MusicEntryMembers } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db);
  const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  const headers = async (user: string) => {
    const cookie = 'kanban_session=fixture-' + user;
    const session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin: 'https://rebuild.example', 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
  };
  const alice = await headers('alice'), bob = await headers('bob');
  const read = (id = 'sub-2', h: Record<string, string> = alice) => app.inject({ url: '/api/v2/music/entries/' + encodeURIComponent(id) + '/members', headers: h });
  let n = 0;
  function profile(name: string, options: { user?: string; contact?: string; legacy?: string; selected?: boolean; erased?: boolean } = {}) {
    const id = 'm_' + (++n).toString(16).padStart(32, '0');
    db.prepare('INSERT INTO music_profiles VALUES(?,?,0,?,?)').run(id, options.user ?? null, 'synthetic', options.erased ? 'erased' : null);
    db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,1,?,0,0,?)').run(id, name, 'PRIVATE_NOTE', 'PRIVATE_GENDER', 'synthetic');
    if (options.legacy) db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(id, options.legacy, 'OLD_NAME', 1, 'PRIVATE_PIN_HASH', 'STALE_CONTACT', '{"note":"PRIVATE_LEGACY_NOTE"}', '[]', 'unlinked');
    if (options.contact !== undefined) db.prepare('INSERT INTO music_profile_contacts VALUES(?,?,?,0,?)').run(id, options.contact, options.legacy ? 'legacy' : 'self_reported', 'synthetic');
    if (options.selected !== false) db.prepare("INSERT INTO music_selections VALUES(?,'sub-2',4,0)").run(id);
    return id;
  }
  return { app, db, alice, bob, read, profile };
}
describe('term selectors and original visibility', () => {
  it('matches the wrapped Python endpoint, including unlinked profiles, Unicode name order, equal-name ties and contact/ID fallback', async () => {
    const s = await setup();
    const source: Record<string, object> = {}, ids = new Map<string, string>();
    for (const [index, name] of ['🟢', '\ue000', '同名', '同名', 'A', 'a', ''].entries()) {
      const legacy = index === 2 ? '10001' : undefined;
      const contact = index === 4 ? '234567' : legacy ?? '';
      const id = s.profile(name || '未命名成分', { ...(index === 0 ? { user: 'alice' } : {}), contact, legacy });
      const key = legacy ?? id; ids.set(key, id);
      source[key] = { qq: key, name: name || '未命名成分', contactQQ: contact, selection: index % 2 ? ['sub-2'] : [{ id: 'sub-2', level: 4 }] };
    }
    const original = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u,service,contacts
u.data={'entries':{'sub-2':{'id':'sub-2','text':'Aimer','kind':'sub'}},'members':json.load(sys.stdin)}
def request(qq,eid):
    h=object.__new__(service.Handler);h.path='/api/entry/members?id='+eid
    h.context=lambda:{};h.current_qq=lambda _:qq
    h.send_json=lambda v,status=200:dict(status=status,value=contacts.payload(u.data,v))
    return h.do_GET()
print(json.dumps(dict(guest=request('','sub-2'),member=request(next(iter(u.data['members'])),'sub-2'),missing=request(next(iter(u.data['members'])),'missing'))))`], { input: JSON.stringify(source), encoding: 'utf8' }));
    const actual = await s.read();
    expect(actual.statusCode, actual.body).toBe(original.member.status);
    expect(MusicEntryMembers.parse(actual.json()).members).toEqual(original.member.value.members.map((member: any) => ({
      id: ids.get(member.qq), name: member.name, contactQQ: member.contactQQ, contactSource: member.contactQQSource,
    })));
    expect((await s.read('sub-2', {})).statusCode).toBe(original.guest.status);
    expect((await s.read('missing')).statusCode).toBe(original.missing.status);
  });
  it('requires a current member, matching scope and an existing music profile before revealing any selector', async () => {
    const s = await setup();
    const id = s.profile('只供成員查看', { user: 'alice' });
    expect((await s.read('sub-2', {})).statusCode).toBe(401);
    expect((await s.read('sub-2', { cookie: s.alice.cookie })).statusCode).toBe(409);
    expect((await s.read('sub-2', { ...s.alice, 'x-account-scope': s.bob['x-account-scope'] })).statusCode).toBe(409);
    const denied = await s.read('sub-2', s.bob);
    expect(denied.statusCode).toBe(403); expect(denied.json().code).toBe('MUSIC_PROFILE_REQUIRED');
    expect(denied.body).not.toContain(id); expect(denied.body).not.toContain('只供成員查看');
    const blank = s.profile('空成分', { user: 'bob', selected: false });
    expect((await s.read('sub-2', s.bob)).statusCode).toBe(200);
    s.db.prepare('UPDATE music_profiles SET erased_at=?,user_id=NULL WHERE id=?').run('erased', blank);
    expect((await s.read('missing', s.bob)).statusCode).toBe(403);
    s.db.prepare('DELETE FROM browser_sessions WHERE token_hash=(SELECT token_hash FROM users WHERE id=?)').run('alice');
    expect((await s.read()).statusCode).toBe(401);
  });
  it('returns every saved selector without deduplicating equal names or truncating at a page boundary', async () => {
    const s = await setup();
    const ids = [s.profile('相同名稱', { user: 'alice' })];
    for (let n = 0; n < 125; n++) ids.push(s.profile('相同名稱'));
    s.profile('未選取', { selected: false }); s.profile('已刪除', { erased: true });
    expect((await s.read()).json().members.map((m: any) => m.id)).toEqual(ids);
    const catalog = (await s.app.inject({ url: '/api/v2/music/catalog' })).json();
    expect(catalog.entries.find((e: any) => e.id === 'sub-2').count).toBe(ids.length);
    expect((await s.read('sub-0')).json()).toEqual({ entryId: 'sub-0', members: [] });
    expect((await s.read('missing')).json().code).toBe('ENTRY_NOT_FOUND');
    expect((await s.read('x'.repeat(81))).statusCode).toBe(400);
  });
  it('reads current names and canonical contacts without disclosing credentials, account keys, private fields or stale cleared contacts', async () => {
    const s = await setup(), id = s.profile('新名稱', { user: 'alice', legacy: '10001', contact: '' });
    const result = await s.read();
    expect(result.json().members).toEqual([{ id, name: '新名稱', contactQQ: '', contactSource: '' }]);
    expect(result.body).not.toMatch(/OLD_NAME|STALE_CONTACT|PRIVATE|alice|bob|user_id|legacy_key|gender|note|pin|openid|token|consent|level/);
    expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers.vary).toContain('Cookie');
    s.db.prepare("UPDATE music_profile_contacts SET contact_qq='345678',source='self_reported' WHERE profile_id=?").run(id);
    s.db.prepare("UPDATE music_profile_fields SET name='更新後名稱' WHERE profile_id=?").run(id);
    expect((await s.read()).json().members).toEqual([{ id, name: '更新後名稱', contactQQ: '345678', contactSource: 'self_reported' }]);
  });
  it('reflects only committed selection changes and keeps read requests free of database or bot side effects', async () => {
    const s = await setup(), id = s.profile('小青', { user: 'alice', selected: false });
    const tables = ['events', 'attendees', 'bot_outbox', 'bot_settings', 'finance_entries', 'settlements'];
    const snapshot = () => tables.map(t => s.db.prepare('SELECT * FROM ' + t).all());
    const before = snapshot(), changed = s.db.prepare('SELECT total_changes() n').get();
    expect((await s.read()).json().members).toEqual([]);
    expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(changed);
    const save = await s.app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...s.alice, 'idempotency-key': randomUUID() },
      payload: { profileId: id, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-2', level: 4 }] } });
    expect(save.statusCode, save.body).toBe(200);
    expect((await s.read()).json().members).toEqual([{ id, name: '小青', contactQQ: '', contactSource: '' }]);
    const next = await s.app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...s.alice, 'idempotency-key': randomUUID() },
      payload: { profileId: id, musicEpoch: 0, revision: 1, selections: [{ entryId: 'sub-0', level: 3 }] } });
    expect(next.statusCode).toBe(200); expect((await s.read()).json().members).toEqual([]);
    expect(snapshot()).toEqual(before); expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('retains independent selectors after account closure and removes erased profiles while preserving stable IDs through reassignment', async () => {
    const s = await setup();
    const alice = s.profile('小青', { user: 'alice' }), bob = s.profile('小白', { user: 'bob', contact: '345678' });
    const closed = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.bob, payload: {
      target: 'account', profileId: bob, profileRevision: 0, requestId: randomUUID(), secret: 'b'.repeat(64), confirm: true,
    } });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await s.read()).json().members).toContainEqual({ id: bob, name: '小白', contactQQ: '345678', contactSource: 'self_reported' });
    expect((await s.read('sub-2', s.bob)).statusCode).toBe(401);
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(alice);
    s.db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('alice', bob);
    expect((await s.read()).json().members.map((m: any) => m.id)).toEqual([bob, alice]);
    const erased = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.alice, payload: {
      target: 'music', profileId: bob, profileRevision: 0, requestId: randomUUID(), secret: 'c'.repeat(64), confirm: true,
    } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await s.read()).statusCode).toBe(403);
    // A different surviving profile can still read the complete list, without the erased selector.
    s.db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('alice', alice);
    expect((await s.read()).json().members).toEqual([{ id: alice, name: '小青', contactQQ: '', contactSource: '' }]);
  });
});
