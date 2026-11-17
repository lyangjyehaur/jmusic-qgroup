import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { musicEntryKey } from '@qgroup/domain';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
const origin = 'https://rebuild.example',
  stamp = '2026-11-17T08:00:00.000Z';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const db = openDatabase(':memory:');
  fixture(db);
  const app = createApp({ db, origin, now: () => new Date(stamp) });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
  });
  async function auth(user: string) {
    const cookie = 'kanban_session=fixture-' + user,
      session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
  }
  const alice = await auth('alice'),
    bob = await auth('bob');
  const mine = async (h = alice) =>
    (await app.inject({ url: '/api/v2/me/music/entries', headers: h })).json();
  const send = (input: object, h: Record<string, string> = alice, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/me/music/entries',
      headers: { ...h, 'idempotency-key': key },
      payload: input,
    });
  const create = async (name = '自建樂團', kind: 'main' | 'sub' = 'sub', h = alice) => {
    const m = await mine(h);
    return send(
      {
        command: 'create',
        profileId: m.profileId,
        musicEpoch: m.musicEpoch,
        name,
        kind,
        category: '乐队',
        confirm: true,
      },
      h,
    );
  };
  const edit = async (id: string, patch: object = {}, command = 'update', h = alice) => {
    const m = await mine(h),
      e = m.entries.find((e: any) => e.id === id);
    return send(
      {
        command,
        profileId: m.profileId,
        musicEpoch: m.musicEpoch,
        id,
        revision: e?.revision,
        ...(command === 'update' ? { name: e.name, kind: e.kind, category: e.category } : {}),
        ...patch,
        confirm: true,
      },
      h,
    );
  };
  return { db, app, alice, bob, mine, send, create, edit };
}
describe('native music catalog and member-created entries', () => {
  it('matches the original update and delete semantics for categories, type changes, aliases, quotas and selected protection', async () => {
    const s = await setup(),
      created = await s.create('原詞條'),
      id = created.json().id,
      m = await s.mine();
    s.db.prepare('UPDATE music_entry_details SET aliases_json=? WHERE entry_id=?').run('["原別名"]', id);
    s.db.prepare('INSERT INTO music_selections VALUES(?,?,4,0)').run(m.profileId, id);
    const source = {
      entries: {
        [id]: {
          id,
          text: '原詞條',
          createdBy: '10001',
          kind: 'sub',
          category: '乐队',
          aliases: ['原別名'],
          createdAt: Date.parse(stamp) / 1000,
        },
      },
      members: { '10001': { qq: '10001', name: '小青', created: [id], selection: [{ id, level: 4 }] } },
    };
    const run = (method: string, body: object) =>
      JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import json,sys
from music_site import upstream as u
data=json.load(sys.stdin);u.data=data['source'];u.save=lambda:None;u.time.time=lambda:${Date.parse(stamp) / 1000}
h=object.__new__(u.Handler);h.send_json=lambda value,status=200:dict(status=status,value=value)
result=getattr(h,sys.argv[1])(data['body'])
print(json.dumps(dict(result=result,entry=u.data['entries'].get(data['body']['entryId']),member=u.member_payload(u.data['members']['10001']))))`,
            method,
          ],
          { input: JSON.stringify({ source, body }), encoding: 'utf8' },
        ),
      );
    const patch = { name: '  新　名稱  ', kind: 'main', category: '歌手' },
      expected = run('api_update_entry', {
        qq: '10001',
        entryId: id,
        text: patch.name,
        kind: patch.kind,
        category: patch.category,
      });
    expect((await s.edit(id, patch)).statusCode).toBe(expected.result.status);
    const actual = (await s.mine()).entries[0];
    expect(actual).toMatchObject({
      name: expected.entry.text,
      kind: expected.entry.kind,
      category: expected.entry.category,
      aliases: expected.entry.aliases,
    });
    expect((await s.mine()).createdCounts).toEqual({
      main: expected.member.createdMain,
      sub: expected.member.createdSub,
    });
    expect(s.db.prepare('SELECT level FROM music_selections WHERE entry_id=?').get(id)).toEqual({
      level: expected.member.selection[0].level,
    });
    expect((await s.edit(id, {}, 'delete')).statusCode).toBe(
      run('api_delete_entry', { qq: '10001', entryId: id }).result.status,
    );
    source.members['10001'].selection = [];
    s.db.prepare('DELETE FROM music_selections WHERE entry_id=?').run(id);
    expect((await s.edit(id, {}, 'delete')).statusCode).toBe(
      run('api_delete_entry', { qq: '10001', entryId: id }).result.status,
    );
  });
  it('matches Python entry normalization including NFKC, casefold, alias whitespace and zero-width characters', () => {
    const values = [
      'Ｓtraße',
      'stras\u200bse',
      ' a　 b ',
      'a b',
      'ab',
      'İıI',
      'ςΣσ',
      '\ufeffa\u00adb',
      '🟢'.repeat(24),
      '\u001cＡ\u0085B\u001f',
    ];
    const source = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import json,sys;from music_site.upstream import normalize_entry_key;print(json.dumps([normalize_entry_key(s) for s in json.load(sys.stdin)]))',
        ],
        { input: JSON.stringify(values), encoding: 'utf8' },
      ),
    );
    expect(values.map(musicEntryKey)).toEqual(source);
    expect(musicEntryKey('a b')).not.toBe(musicEntryKey('ab'));
  });
  it('creates an explicit blank profile with the first term, preserves selection drafts and retries the exact creation once', async () => {
    const s = await setup(),
      m = await s.mine(),
      key = randomUUID(),
      input = {
        command: 'create',
        profileId: null,
        musicEpoch: 0,
        name: '  新　樂團  ',
        kind: 'sub',
        category: '乐队',
        confirm: true,
      };
    expect(m).toMatchObject({ profileId: null, entries: [], createdCounts: { main: 0, sub: 0 } });
    const first = await s.send(input, s.alice, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await s.send(input, s.alice, key)).json()).toEqual(first.json());
    const mine = await s.mine();
    expect(mine.entries).toMatchObject([
      { name: '新 樂團', category: '乐队', kind: 'sub', creatorName: '小青', count: 0 },
    ]);
    expect(mine.createdCounts).toEqual({ main: 0, sub: 1 });
    expect((await s.app.inject({ url: '/api/v2/me/music', headers: s.alice })).json()).toMatchObject({
      id: mine.profileId,
      revision: 0,
      selections: [],
    });
    expect((await s.send({ ...input, name: '另一個' }, s.alice, key)).statusCode).toBe(409);
    expect(s.db.prepare('SELECT count(*) n FROM music_profile_receipts').get()).toEqual({ n: 1 });
  });
  it('rejects duplicate names and aliases across types while preserving the original user text and metadata', async () => {
    const s = await setup(),
      first = await s.create('Straße');
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    s.db
      .prepare('UPDATE music_entry_details SET aliases_json=? WHERE entry_id=?')
      .run('["Ａ　Ｂ","旧別名"]', id);
    for (const name of ['ＳＴＲＡＳＳＥ', 'stra\u200bsse', 'a b', '旧別名'])
      expect((await s.create(name, 'main')).json()).toMatchObject({ code: 'ENTRY_EXISTS' });
    const second = await s.create('另一樂團');
    expect(second.statusCode).toBe(200);
    expect((await s.edit(second.json().id, { name: 'a b' })).statusCode).toBe(409);
    expect((await s.edit(id, { name: 'Straße 新名', kind: 'main' })).statusCode).toBe(200);
    expect(
      s.db.prepare('SELECT aliases_json,created_at_json FROM music_entry_details WHERE entry_id=?').get(id),
    ).toEqual({ aliases_json: '["Ａ　Ｂ","旧別名"]', created_at_json: String(Date.parse(stamp) / 1000) });
  });
  it('enforces 2/8 creation quotas, frees deleted slots and allows source-compatible type edits without touching selections or levels', async () => {
    const s = await setup();
    for (let n = 0; n < 2; n++) expect((await s.create('領域' + n, 'main')).statusCode).toBe(200);
    expect((await s.create('超額領域', 'main')).json().code).toBe('ENTRY_LIMIT');
    for (let n = 0; n < 8; n++) expect((await s.create('細分' + n)).statusCode).toBe(200);
    expect((await s.create('超額細分')).json().code).toBe('ENTRY_LIMIT');
    let m = await s.mine();
    const sub = m.entries.find((e: any) => e.kind === 'sub'),
      main = m.entries.find((e: any) => e.kind === 'main');
    s.db.prepare('INSERT INTO music_selections VALUES(?,?,4,0)').run(m.profileId, sub.id);
    expect((await s.edit(sub.id, { kind: 'main' })).statusCode).toBe(200);
    expect((await s.mine()).createdCounts).toEqual({ main: 3, sub: 7 });
    expect(s.db.prepare('SELECT level,position FROM music_selections WHERE entry_id=?').get(sub.id)).toEqual({
      level: 4,
      position: 0,
    });
    expect((await s.edit(sub.id, {}, 'delete')).json().code).toBe('ENTRY_SELECTED');
    expect((await s.edit(main.id, {}, 'delete')).statusCode).toBe(200);
    expect((await s.create('補細分')).statusCode).toBe(200);
    expect((await s.mine()).createdCounts).toEqual({ main: 2, sub: 8 });
  });
  it('retains source created-list quotas independently of metadata ownership and carries legacy creator rights through linking', async () => {
    const s = await setup();
    await s.create();
    const m = await s.mine(),
      id = m.profileId;
    s.db
      .prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, '10001', '原成分', 1, '', '10001', '{}', '["main-0","main-1"]', 'oauth');
    s.db
      .prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)')
      .run('sub-0', '歌手', '["原別名"]', '10001', '123', 'null');
    expect((await s.mine()).createdCounts).toEqual({ main: 2, sub: 1 });
    expect((await s.create('不能多建', 'main')).json().code).toBe('ENTRY_LIMIT');
    expect((await s.edit('sub-0', { name: '原歌手新名' })).statusCode).toBe(200);
    const next = await s.create('新細分');
    expect(next.statusCode).toBe(200);
    const raw = JSON.parse(
      (
        s.db.prepare('SELECT created_entries_json FROM music_legacy_profiles WHERE profile_id=?').get(id) as {
          created_entries_json: string;
        }
      ).created_entries_json,
    );
    expect(raw).toContain(next.json().id);
    expect((await s.edit(next.json().id, {}, 'delete')).statusCode).toBe(200);
    expect(
      JSON.parse(
        (
          s.db
            .prepare('SELECT created_entries_json FROM music_legacy_profiles WHERE profile_id=?')
            .get(id) as { created_entries_json: string }
        ).created_entries_json,
      ),
    ).not.toContain(next.json().id);
    s.db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('bob', id);
    expect((await s.mine()).entries).toEqual([]);
    expect((await s.mine(s.bob)).entries.some((e: any) => e.id === 'sub-0')).toBe(true);
  });
  it('sorts public catalog by actual selection count and Python text order, preserves custom classifications and exposes no identities', async () => {
    const s = await setup();
    await s.create('🟢自建');
    const m = await s.mine();
    s.db.prepare('INSERT INTO music_selections VALUES(?,?,1,0)').run(m.profileId, 'sub-2');
    s.db
      .prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)')
      .run('sub-2', '來源分類', '["原別名"]', '10001', '123', 'null');
    const result = await s.app.inject({ url: '/api/v2/music/catalog' }),
      catalog = result.json();
    expect(catalog.entries[0]).toMatchObject({
      id: 'sub-2',
      count: 1,
      category: '來源分類',
      aliases: ['原別名'],
    });
    expect(catalog.categories).toContain('來源分類');
    expect(catalog.categories).not.toContain('未使用分類');
    expect(result.body).not.toMatch(
      /10001|alice|bob|created_by|profileId|user_id|token|contact|pin|revision/,
    );
    expect(catalog.entries.map((e: any) => e.id)).toEqual(
      JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            'import json,sys;v=json.load(sys.stdin);print(json.dumps([e["id"] for e in sorted(v,key=lambda e:(-e["count"],e["name"]))]))',
          ],
          { input: JSON.stringify(catalog.entries), encoding: 'utf8' },
        ),
      ),
    );
  });
  it('checks permissions, validation, CSRF and both revisions; no body-supplied identity can manage another member term', async () => {
    const s = await setup(),
      first = await s.create(),
      id = first.json().id,
      m = await s.mine(),
      entry = m.entries[0];
    const data = {
      command: 'update',
      profileId: m.profileId,
      musicEpoch: 0,
      id,
      revision: entry.revision,
      name: '新名',
      kind: 'sub',
      category: '歌手',
      confirm: true,
    };
    expect((await s.send(data, {})).statusCode).toBe(401);
    expect((await s.send(data, { ...s.alice, 'x-account-scope': 'old' })).statusCode).toBe(409);
    expect((await s.send(data, { ...s.alice, origin: 'https://other.example' })).statusCode).toBe(403);
    expect((await s.send(data, { ...s.alice, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await s.send({ ...data, userId: 'alice' })).statusCode).toBe(400);
    await s.create('小白詞條', 'sub', s.bob);
    const bob = await s.mine(s.bob);
    expect((await s.send({ ...data, profileId: bob.profileId }, s.bob)).statusCode).toBe(403);
    expect((await s.send({ ...data, revision: 'a'.repeat(64) })).json().code).toBe('ENTRY_CHANGED');
    expect((await s.send({ ...data, musicEpoch: 1 })).json().code).toBe('PROFILE_ERASED');
    for (const name of ['', ' ', '🟢'.repeat(25), '\u200b', 'bad\u0000name'])
      expect((await s.create(name)).statusCode).toBe(400);
    expect((await s.create('🟢'.repeat(24))).statusCode).toBe(200);
    expect(
      (await s.app.inject({ url: '/api/v2/me/music/entries', headers: { cookie: s.alice.cookie } }))
        .statusCode,
    ).toBe(409);
  });
  it('rolls back the entry and blank profile when the durable result fails, and blocks deletion once anyone selects it', async () => {
    const s = await setup();
    s.db.exec(
      "CREATE TRIGGER fail_entry_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    expect((await s.create()).statusCode).toBe(500);
    expect((await s.mine()).profileId).toBeNull();
    expect(s.db.prepare('SELECT count(*) n FROM music_entry_details').get()).toEqual({ n: 0 });
    s.db.exec('DROP TRIGGER fail_entry_receipt');
    const created = await s.create();
    await s.create('小白詞條', 'sub', s.bob);
    const bob = await s.mine(s.bob);
    s.db.prepare('INSERT INTO music_selections VALUES(?,?,3,0)').run(bob.profileId, created.json().id);
    const response = await s.edit(created.json().id, {}, 'delete');
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('小白');
    expect(s.db.prepare('SELECT level FROM music_selections WHERE profile_id=?').get(bob.profileId)).toEqual({
      level: 3,
    });
  });
  it('erases native creator identity and old receipts while preserving public terms, other selections and all bot data', async () => {
    const s = await setup(),
      m = await s.mine(),
      key = randomUUID(),
      input = {
        command: 'create',
        profileId: m.profileId,
        musicEpoch: 0,
        name: '原詞條',
        kind: 'sub',
        category: '歌手',
        confirm: true,
      };
    const created = await s.send(input, s.alice, key),
      id = created.json().id;
    await s.create('小白詞條', 'sub', s.bob);
    const bob = await s.mine(s.bob);
    s.db.prepare('INSERT INTO music_selections VALUES(?,?,4,0)').run(bob.profileId, id);
    const before = ['events', 'attendees', 'bot_outbox', 'bot_settings', 'finance_entries'].map((t) =>
      s.db.prepare('SELECT * FROM ' + t).all(),
    );
    const profile = (await s.app.inject({ url: '/api/v2/me/music', headers: s.alice })).json();
    const erased = await s.app.inject({
      method: 'POST',
      url: '/api/v2/me/privacy/erase',
      headers: s.alice,
      payload: {
        requestId: randomUUID(),
        secret: 'ab'.repeat(32),
        target: 'music',
        confirm: true,
        profileId: profile.id,
        profileRevision: profile.revision,
      },
    });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await s.send(input, s.alice, key)).statusCode).toBe(410);
    expect(s.db.prepare('SELECT created_by FROM music_entry_details WHERE entry_id=?').get(id)).toEqual({
      created_by: '',
    });
    expect(
      (await s.app.inject({ url: '/api/v2/music/catalog' })).json().entries.find((e: any) => e.id === id),
    ).toMatchObject({ name: '原詞條', creatorName: '', count: 1 });
    expect(
      ['events', 'attendees', 'bot_outbox', 'bot_settings', 'finance_entries'].map((t) =>
        s.db.prepare('SELECT * FROM ' + t).all(),
      ),
    ).toEqual(before);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
});
