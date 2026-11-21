import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from './app';
import { SearchResults } from '@qgroup/contracts';
import { shoutActors, shoutAuthorityFixture, shoutOrigin, shoutProfileId, shoutRescueKey, shoutSnapshot, shoutStamp, shoutToken } from '../testsupport/shout-authority-fixture';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-search-')); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDatabase(join(root, 'owned.sqlite3')); cleanup.push(async () => { db.close(); }); shoutAuthorityFixture(db);
  db.prepare("UPDATE events SET title='Needle ' || id").run();
  db.prepare("UPDATE music_profile_fields SET name='Needle ' || substr(profile_id,-2)").run();
  db.prepare("INSERT INTO event_access VALUES('invite','cohost',?)").run(shoutStamp);
  db.prepare("INSERT INTO event_roles VALUES('search-draft-cohost','draft','cohost','[\"schedule\"]',?)").run(shoutStamp);
  db.prepare("INSERT INTO music_entries VALUES('search-term','Needle term','sub')").run();
  db.prepare("INSERT INTO music_entry_details VALUES('sub-4','歌手','[\"全形 ＡＬＩＡＳ\"]','','0','null')").run();
  const app = createApp({ db, origin: shoutOrigin, now: () => new Date(shoutStamp), botEnabledDefault: false, adminCredentialHash: () => hash(shoutRescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready(); const headers = new Map<string, Record<string, string>>();
  for (const a of shoutActors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const cookie = a.member ? 'kanban_session=' + shoutToken(a.id) : '';
    const session = await app.inject({ url: '/api/v2/session', headers: { cookie } }); expect(session.statusCode).toBe(200);
    const h = { cookie: cookie || String(session.headers['set-cookie']).split(';')[0]!, origin: shoutOrigin, 'x-account-scope': session.json().scope, 'x-csrf-token': session.json().csrf };
    if (a.id.startsWith('rescue')) {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: shoutRescueKey, confirm: true } }); expect(login.statusCode).toBe(200);
      h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
    }
    headers.set(a.id, h);
  }
  const search = (who = 'alice', query = 'q=Needle', patch: Record<string, string> = {}) => app.inject({ url: '/api/v2/search?' + query, headers: { ...headers.get(who)!, ...patch } });
  return { db, app, headers, search };
}
const sensitive = /PRIVATE_|contact|gender|note|legacy|token|owner_id|user_id|openid|unionid/i;

describe('unified search current visibility and privacy', () => {
  for (const a of shoutActors) it(a.id + ': activity, music and people results use their existing independent permissions', async () => {
    const s = await setup(), before = shoutSnapshot(s.db), result = await s.search(a.id);
    expect(result.statusCode, result.body).toBe(a.id === 'anonymous' ? 401 : 200);
    if (result.statusCode === 200) {
      const data = SearchResults.parse(result.json()), expected = ['karaoke', 'listen', 'past', ...(['alice', 'cohost'].includes(a.id) ? ['draft', 'invite'] : [])].sort();
      expect(data.activities.items.map(item => item.id).sort()).toEqual(expected); expect(data.activities.total).toBe(expected.length);
      expect(data.music.items.map(item => item.id)).toEqual(['search-term']);
      expect(data.people.access).toBe(!a.member ? 'login_required' : !a.music ? 'music_required' : 'ready');
      expect(data.people.items.map(item => item.id).sort()).toEqual(a.music ? ['alice', 'bob', 'cohost', 'admin'].map(shoutProfileId).sort() : []);
      expect(data.people.total).toBe(a.music ? 4 : 0); expect(result.body).not.toMatch(sensitive);
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('does not match private notes, gender, contact QQ or opaque identity values', async () => {
    const s = await setup(), before = shoutSnapshot(s.db);
    for (const q of ['PRIVATE_NOTE_bob', 'PRIVATE_GENDER_bob', '130001', shoutProfileId('bob'), 'fixture-bob']) {
      const result = await s.search('alice', new URLSearchParams({ q }).toString()); expect(result.statusCode).toBe(200);
      expect(result.json().people).toEqual({ items: [], total: 0, hasMore: false, access: 'ready' });
      // The query is the caller's own input; result projections must not contain
      // a matching private source field or identity value.
      const { q: _query, ...projection } = result.json(); expect(JSON.stringify(projection)).not.toMatch(sensitive);
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('matches the current display name and excludes erased targets while preserving unlinked music', async () => {
    const s = await setup(), id = shoutProfileId('bob');
    s.db.prepare("UPDATE music_profile_fields SET name='Current author' WHERE profile_id=?").run(id);
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(id);
    expect((await s.search('alice', 'q=Current')).json().people.items).toEqual([{ id, name: 'Current author' }]);
    s.db.prepare('UPDATE music_profiles SET erased_at=? WHERE id=?').run(shoutStamp, id); const before = shoutSnapshot(s.db);
    expect((await s.search('alice', 'q=Current')).json().people.items).toEqual([]); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('rechecks private invitations, draft duties and current music qualification on each read', async () => {
    const s = await setup(); expect((await s.search('cohost')).json().activities.total).toBe(5);
    s.db.prepare("DELETE FROM event_access WHERE user_id='cohost'").run(); s.db.prepare("DELETE FROM event_roles WHERE event_id='draft' AND user_id='cohost'").run();
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(shoutProfileId('cohost')); const before = shoutSnapshot(s.db);
    const result = await s.search('cohost'); expect(result.statusCode).toBe(200); expect(result.json().activities.total).toBe(3);
    expect(result.json().people).toEqual({ items: [], total: 0, hasMore: false, access: 'music_required' }); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('rejects switched scopes and revoked devices rather than returning a cached member result', async () => {
    const s = await setup(), before = shoutSnapshot(s.db);
    for (const scope of ['', s.headers.get('bob')!['x-account-scope']!]) {
      const result = await s.search('alice', 'q=Needle', { 'x-account-scope': scope }); expect(result.statusCode).toBe(409); expect(result.json().code).toBe('ACCOUNT_CHANGED');
    }
    expect(shoutSnapshot(s.db)).toEqual(before); s.db.prepare("DELETE FROM browser_sessions WHERE user_id='alice'").run(); const revoked = shoutSnapshot(s.db);
    const result = await s.search(); expect(result.statusCode).toBe(401); expect(result.json().code).toBe('SESSION_EXPIRED'); expect(shoutSnapshot(s.db)).toEqual(revoked);
  });
});

describe('unified search normalization, bounds and failure semantics', () => {
  for (const [q, id] of [['mjxs', 'sub-4'], ['xuanshi', 'sub-4'], ['ｙｒｓｋ', 'sub-1'], ['ａｌｉａｓ', 'sub-4']] as const) it(q + ': preserves the music search spelling and alias rules', async () => {
    const s = await setup(), before = shoutSnapshot(s.db), result = await s.search('visitor', new URLSearchParams({ q }).toString());
    expect(result.statusCode).toBe(200); expect(result.json().music.items.map((item: { id: string }) => item.id)).toEqual([id]); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('paginates all matching visible rows without dropping results or counting hidden rows', async () => {
    const s = await setup();
    for (let i = 0; i < 23; i++) s.db.prepare("INSERT INTO music_entries VALUES(?,?,'sub')").run('paged-' + i.toString().padStart(2, '0'), 'Paged ' + i.toString().padStart(2, '0'));
    const before = shoutSnapshot(s.db), collected: string[] = [];
    for (let p = 1; p <= 3; p++) {
      const r = await s.search('visitor', 'q=Paged&group=music&page=' + p); expect(r.statusCode).toBe(200);
      expect(r.json().music.total).toBe(23); expect(r.json().music.hasMore).toBe(p < 3); collected.push(...r.json().music.items.map((item: { id: string }) => item.id));
    }
    expect(collected).toEqual(Array.from({ length: 23 }, (_, i) => 'paged-' + i.toString().padStart(2, '0')));
    expect((await s.search('visitor', 'q=Paged')).json().music.items).toHaveLength(10);
    expect((await s.search('visitor', 'q=Paged&group=music&page=10000')).json().music.items).toEqual([]); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  for (const query of ['q=', 'q=one&q=two', 'q=Needle&group=unknown', 'q=Needle&page=2', 'q=Needle&group=music&page=0', 'q=Needle&group=music&page=10001', 'q=' + 'x'.repeat(101), 'q=Needle&contact=130001']) it(query.slice(0, 50) + ': rejects invalid or ambiguous query input without changing data', async () => {
    const s = await setup(), before = shoutSnapshot(s.db), r = await s.search('alice', query); expect(r.statusCode).toBe(400); expect(r.json().code).toBe('INVALID_INPUT'); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('reports a source failure instead of presenting an empty successful result', async () => {
    const s = await setup(); s.db.prepare("UPDATE event_roles SET permissions_json='broken' WHERE event_id='draft' AND user_id='cohost'").run(); const before = shoutSnapshot(s.db);
    const result = await s.search('cohost'); expect(result.statusCode).toBe(500); expect(result.json().code).toBe('INTERNAL_ERROR'); expect(shoutSnapshot(s.db)).toEqual(before);
  });
});
