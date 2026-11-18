import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { legacySchema } from '../../../packages/database/src/legacy-schema';
import { importSnapshot } from '../../../tools/migration/import-snapshot';
import { digest, parseJson, profileId } from '../../../tools/migration/music-codec';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { createApp, hash } from './app';
const cleanups: (() => void | Promise<void>)[] = []; afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const native = 'm_' + 'b'.repeat(24); const stamp = new Date('2026-11-17T08:00:00Z');
function allFiles(root: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(readdirSync(join(root, prefix)).sort().flatMap(name => { const path = prefix ? prefix + '/' + name : name; return lstatSync(join(root, path)).isDirectory() ? Object.entries(allFiles(root, path)) : [[path, digest(readFileSync(join(root, path)))]]; }));
}
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qgroup-import-'))); const source = join(root, 'snapshot'); const destination = join(root, 'candidate');
  mkdirSync(join(source, 'music/walls'), { recursive: true }); mkdirSync(join(source, 'images'));
  const write = (path: string, value: unknown) => writeFileSync(join(source, path), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const board = new Database(join(source, 'board.sqlite3')); board.pragma('foreign_keys = ON'); board.exec(legacySchema);
  board.prepare('INSERT INTO site_settings(id) VALUES(1)').run();
  board.exec("INSERT INTO bot_settings_history VALUES(0,'{}','source-baseline','','baseline'); INSERT INTO bot_runtime(id) VALUES(1);");
  board.exec('CREATE TEMP TABLE music_entries(id TEXT,name TEXT,kind TEXT)'); fixture(board); nicknameFixture(board);
  board.prepare("INSERT INTO user_admin_roles VALUES('alice',1,7,'before')").run(); board.prepare("UPDATE sqlite_sequence SET seq=9000 WHERE name='attendees'").run();
  board.prepare("INSERT INTO external_identities VALUES('qq','synthetic-app','synthetic-subject','alice','QQ 原名','before')").run();
  board.prepare("UPDATE settlements SET qr_image=? WHERE event_id='listen'").run(Buffer.from([0, 1, 255, 17]));
  board.pragma('journal_mode=WAL'); board.close();
  execFileSync('python3', ['-c', 'import sys;from music_site.identity_store import Store;Store(sys.argv[1])', join(source, 'music/identity.sqlite3')]);
  chmodSync(join(source, 'music/identity.sqlite3'), 0o600);
  const identity = new Database(join(source, 'music/identity.sqlite3'));
  identity.prepare("INSERT INTO links VALUES('10001','synthetic-app','synthetic-subject','alice',123,'legacy_pin_and_qq_oauth')").run();
  identity.prepare('INSERT INTO prelinks VALUES(?,?,123)').run(native, 'bob');
  identity.prepare('INSERT INTO native_profiles VALUES(?,?)').run(native, JSON.stringify({ qq: native, name: '未寫入 JSON 的成分', boardUserId: 'bob', consent: true, selection: ['e-main'], created: [], note: 'native private note', contactQQ: '12345', gender: '', genderPublic: false, createdAt: 123 }));
  identity.prepare('INSERT INTO profile_contacts VALUES(?,?,123)').run(native, '');
  identity.prepare("INSERT INTO link_overrides VALUES('10003','',2,123)").run();
  identity.prepare("INSERT INTO link_audit(qq,actor,before_user_id,after_user_id,created) VALUES('10003','synthetic-admin','alice','',123)").run();
  identity.prepare("INSERT INTO sessions VALUES('synthetic-old-music-session','10003',9999999999,'original-device',0)").run();
  identity.prepare("INSERT INTO prelinks VALUES('10004','erased-source-user',123)").run(); identity.close();
  const music = {
    entries: { 'e-main': { id: 'e-main', text: '日系音樂', category: '领域', createdBy: 'admin', aliases: ['JPOP'], createdAt: 120 }, 'e-one': { id: 'e-one', text: 'Aimer', category: '歌手', kind: 'sub', createdBy: '10004', createdAt: 121, updatedAt: 122 } },
    members: {
      '10001': { qq: '10001', name: '舊成分名稱', consent: true, selection: ['e-main', { id: 'e-one', level: 4 }, { entryId: 'e-one', level: 1 }], created: [], boardUserId: 'outdated-json-id', pinHash: hash('jpm-pin|synthetic-pin'), createdAt: 123, lastJoinAt: 124, gender: 'female', genderPublic: false, note: 'private member note', noteAt: 125 },
      '10003': { qq: '10003', name: '未關聯成分', consent: true, selection: [{ id: 'e-one', level: '999' }], created: [], boardUserId: 'alice', pinHash: hash('jpm-pin|other-synthetic-pin') },
      '10004': { qq: '10004', name: 'erased private name', selection: ['e-one'], created: [] },
    }, settings: { adminPasswordHash: hash('synthetic-old-admin') },
    shouts: [{ id: 'shout-1', qq: '10001', name: '歷史名稱', text: '保留喊話', createdAt: 1 }, { id: 'erased-shout', qq: '10004', text: 'erased private shout' }],
    shoutHistory: [{ id: 'history-1', qq: '10001', name: '凍結名稱', text: '保留歷史', createdAt: 1, archivedAt: 2 }], trend: [{ t: 123, counts: { 'e-main': 2, 'e-one': 1 } }],
  };
  write('music/data.json', music); write('music/erasures.jsonl', JSON.stringify({ qq: '10004', erased_at: 123 }) + '\n'); write('board.erasures.jsonl', ''); write('music/walls/manifest.json', { items: [], rotateSeconds: 24 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, source, destination, write, music };
}
describe('offline paired snapshot import', () => {
  it('replays administrative profile deletion and full music reset after importing older paired music snapshots', async () => {
    for(const reset of [false,true]){
      const s=setup(),requestId=randomUUID();
      s.music.entries['e-main'].createdBy='10001';s.write('music/data.json',s.music);
      s.write('board.erasures.jsonl',JSON.stringify({version:2,kind:'admin_music',command:reset?'reset_music':'delete_profile',actorRef:'account:alice',
        profiles:reset?[{id:profileId('10001'),userId:'alice'},{id:profileId(native),userId:'bob'},{id:profileId('10003'),userId:null}]:[{id:profileId('10001'),userId:'alice'}],
        entries:reset?['e-main','e-one']:[],requestId,createdAt:stamp.toISOString(),secretHash:hash('receipt'),signature:hash('command')})+'\n');
      const before=allFiles(s.source),result=await importSnapshot(s.source,s.destination,stamp);expect(allFiles(s.source)).toEqual(before);expect((result.report as {musicAfterErasure:unknown}).musicAfterErasure).toEqual({profiles:reset?0:2,entries:reset?0:2});
      const db=openDatabase(join(s.destination,'unified.sqlite3'));
      try{
        expect(db.prepare('SELECT erased_at,user_id FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({erased_at:stamp.toISOString(),user_id:null});
        expect(db.prepare('SELECT * FROM music_legacy_profiles WHERE profile_id=?').get(profileId('10001'))).toBeUndefined();
        expect(db.prepare('SELECT * FROM music_shouts WHERE profile_id=?').all(profileId('10001'))).toEqual([]);
        expect(db.prepare("SELECT * FROM music_documents WHERE kind IN ('shouts','shoutHistory')").all()).toEqual([]);
        if(reset){expect(db.prepare('SELECT * FROM music_entries').all()).toEqual([]);expect(db.prepare('SELECT id FROM music_profiles WHERE erased_at IS NULL').all()).toEqual([]);}
        else {expect(db.prepare("SELECT created_by FROM music_entry_details WHERE entry_id='e-main'").get()).toEqual({created_by:''});expect(db.prepare('SELECT id FROM music_profiles WHERE erased_at IS NULL').all()).toHaveLength(2);}
        expect(db.prepare('SELECT command FROM music_catalog_actions').all()).toEqual([{command:reset?'reset_music':'delete_profile'}]);
        expect(db.prepare('SELECT count(*) n FROM erasure_applied WHERE request_id=?').get(requestId)).toEqual({n:1});
        expect(db.pragma('foreign_key_check')).toEqual([]);
      }finally{db.close();}
    }
  });

  it('preserves every board column/trigger/ID/high-water mark and all bot states while projecting music recovery, explicit unlink and contact clearing', async () => {
    const s = setup(); const before = allFiles(s.source); const result = await importSnapshot(s.source, s.destination, stamp); expect(result.status).toBe('imported'); expect(allFiles(s.source)).toEqual(before);
    const old = new Database(join(s.source, 'board.sqlite3'), { readonly: true }); const db = openDatabase(join(s.destination, 'unified.sqlite3'));
    try {
      const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const { name } of tables) expect(db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(), name).toEqual(old.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all());
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='attendees'").get()).toEqual({ seq: 9000 });
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'music_%' AND name NOT LIKE 'appearance_%' AND name NOT LIKE 'rebuild_storage_%' AND name NOT LIKE 'unified_privacy_%' ORDER BY name").all()).toEqual(old.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all());
      expect(db.prepare('SELECT count(*) n FROM migration_map WHERE source=?').get('board')).toMatchObject({ n: expect.any(Number) });
      expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({ user_id: 'alice' });
      expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId(native))).toEqual({ user_id: 'bob' });
      expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId('10003'))).toEqual({ user_id: null });
      expect(db.prepare('SELECT contact_qq,ownership_source FROM music_legacy_profiles WHERE legacy_key=?').get(native)).toEqual({ contact_qq: '', ownership_source: 'prelinked' });
      expect(db.prepare('SELECT name,note,note_at,gender,gender_public FROM music_profile_fields WHERE profile_id=?').get(profileId('10001'))).toEqual({name:'舊成分名稱',note:'private member note',note_at:125,gender:'female',gender_public:0});
      expect(db.prepare('SELECT name,note FROM music_profile_fields WHERE profile_id=?').get(profileId(native))).toEqual({name:'未寫入 JSON 的成分',note:'native private note'});
      expect(db.prepare('SELECT entry_id,level,position FROM music_selections WHERE profile_id=? ORDER BY position').all(profileId('10001'))).toEqual([{ entry_id: 'e-main', level: 3, position: 0 }, { entry_id: 'e-one', level: 4, position: 1 }]);
      expect(db.prepare('SELECT level FROM music_selections WHERE profile_id=?').get(profileId('10003'))).toEqual({ level: 4 });
      expect(db.prepare('SELECT kind FROM music_entries WHERE id=?').get('e-main')).toEqual({ kind: 'main' });
      expect(db.prepare('SELECT created_by FROM music_entry_details WHERE entry_id=?').get('e-one')).toEqual({ created_by: '' });
      expect(db.prepare('SELECT * FROM music_legacy_profiles WHERE legacy_key=?').get('10004')).toBeUndefined();
      expect(db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(profileId('10004'))).toMatchObject({ erased_at: stamp.toISOString() });
      expect(JSON.stringify(db.prepare('SELECT * FROM music_documents').all())).not.toContain('erased private');
      expect(JSON.stringify(db.prepare('SELECT * FROM music_legacy_identity').all())).not.toContain('erased-source-user');
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND entity_type='prelinks' AND source_id='1'").get()).toEqual({ status: 'erased' });
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music' AND entity_type='shouts' AND source_id='1'").get()).toEqual({ status: 'erased' });
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music' AND entity_type='entry' AND source_id='e-one'").get()).toEqual({ status: 'erasure_redacted' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { old.close(); db.close(); }
    expect(statSync(s.destination).mode & 0o777).toBe(0o700);
    for (const file of Object.keys(allFiles(s.destination))) expect(statSync(join(s.destination, file)).mode & 0o777, file).toBe(0o600);
  });
  it('lets imported linked members read/save the same profile without re-claiming and never overwrites later writes on repeated import', async () => {
    const s = setup(); await importSnapshot(s.source, s.destination, stamp); const db = openDatabase(join(s.destination, 'unified.sqlite3')); const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready();
    try {
      const cookie = 'kanban_session=fixture-alice'; const session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
      const history = await app.inject({ url: '/api/v2/admin/music/' + profileId('10003') + '/history', headers: { cookie, 'x-account-scope': session.scope } });
      expect(history.statusCode, history.body).toBe(200); expect(history.json().history).toMatchObject([{ source: 'legacy', legacyId: 1, revision: null, beforeUserId: 'alice', afterUserId: null, actor: '舊版管理員', createdSeconds: 123, createdAt: '1970-01-01T00:02:03.000Z' }]);
      expect(history.body).not.toContain('synthetic-admin');
      const before = (await app.inject({ url: '/api/v2/me/music', headers: { cookie, 'x-account-scope': session.scope } })).json(); expect(before.id).toBe(profileId('10001'));
      const response = await app.inject({ method: 'PUT', url: '/api/v2/me/music', payload: { profileId: before.id, musicEpoch: 0, revision: 0, selections: [{ entryId: 'e-one', level: 2 }] }, headers: { cookie, origin: 'https://rebuild.example', 'x-account-scope': session.scope, 'x-csrf-token': session.csrf, 'idempotency-key': randomUUID() } }); expect(response.statusCode).toBe(200);
      const fields = await app.inject({method:'PUT',url:'/api/v2/me/music/fields',payload:{profileId:before.id,musicEpoch:0,revision:0,name:'匯入後獨立稱呼',note:'編輯後私人留言',gender:'',genderPublic:false},headers:{cookie,origin:'https://rebuild.example','x-account-scope':session.scope,'x-csrf-token':session.csrf,'idempotency-key':randomUUID()}}); expect(fields.statusCode).toBe(200);
      const result = await importSnapshot(s.source, s.destination, stamp); expect(result.status).toBe('already_imported'); expect(db.prepare('SELECT revision FROM music_profiles WHERE id=?').get(before.id)).toEqual({ revision: 2 }); expect(db.prepare('SELECT level FROM music_selections WHERE profile_id=?').get(before.id)).toEqual({ level: 2 });
      expect(db.prepare('SELECT name,note FROM music_profile_fields WHERE profile_id=?').get(before.id)).toEqual({name:'匯入後獨立稱呼',note:'編輯後私人留言'});
    } finally { await app.close(); db.close(); }
    s.music.members['10001'].name = '新的來源'; s.write('music/data.json', s.music); await expect(importSnapshot(s.source, s.destination, stamp)).rejects.toThrow('Refusing to replace');
  });
  it('replays current account erasure before ownership without changing frozen history or any bot outbox row', async () => {
    const s = setup(); s.write('board.erasures.jsonl', JSON.stringify({ user_id: 'bob', request_id: 'latest-bob-erasure', created_at: stamp.toISOString() }) + '\n');
    await importSnapshot(s.source, s.destination, stamp); const db = openDatabase(join(s.destination, 'unified.sqlite3'));
    try {
      expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({ nickname: '已注销用户' }); expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId(native))).toEqual({ user_id: null });
      expect(db.prepare('SELECT ownership_source FROM music_legacy_profiles WHERE legacy_key=?').get(native)).toEqual({ ownership_source: 'closed_account' });
      expect(db.prepare("SELECT status FROM migration_map WHERE source='board' AND entity_type='browser_sessions' AND status='erased'").all().length).toBeGreaterThan(0);
      const original = new Database(join(s.source, 'board.sqlite3'), { readonly: true }); try { for (const table of ['events', 'attendees', 'finance_entries', 'settlements', 'bot_outbox', 'bot_settings']) expect(db.prepare('SELECT * FROM ' + table).all()).toEqual(original.prepare('SELECT * FROM ' + table).all()); } finally { original.close(); }
    } finally { db.close(); }
  });
  it('honors a newer rebuild music erasure even when the old JSON/identity snapshot still contains the profile', async () => {
    const s = setup(); s.write('board.erasures.jsonl', JSON.stringify({ version: 1, kind: 'music', userId: 'alice', profileId: profileId('10001'), requestId: randomUUID(), secretHash: 'a'.repeat(64), signature: 'b'.repeat(64), createdAt: stamp.toISOString() }) + '\n');
    await importSnapshot(s.source, s.destination, stamp); const db = openDatabase(join(s.destination, 'unified.sqlite3'));
    try { expect(db.prepare('SELECT * FROM music_legacy_profiles WHERE legacy_key=?').get('10001')).toBeUndefined(); expect(db.prepare('SELECT * FROM music_selections WHERE profile_id=?').all(profileId('10001'))).toEqual([]); expect(db.prepare('SELECT * FROM music_legacy_erasures WHERE legacy_key=?').get('10001')).toBeDefined(); }
    finally { db.close(); }
  });
  it('erases imported PIN/contact/native/history data with music while preserving the account and rejects resurrection on source replay', async () => {
    const s = setup(); await importSnapshot(s.source, s.destination, stamp); const db = openDatabase(join(s.destination, 'unified.sqlite3')); const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready();
    try {
      const cookie = 'kanban_session=fixture-bob'; const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json(); const id = profileId(native);
      const response = await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: { cookie, origin: 'https://rebuild.example', 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf }, payload: { target: 'music', profileId: id, profileRevision: 0, requestId: randomUUID(), secret: 'd'.repeat(64), confirm: true } });
      expect(response.statusCode).toBe(200); expect(db.prepare('SELECT * FROM music_legacy_profiles WHERE profile_id=?').get(id)).toBeUndefined(); expect(db.prepare("SELECT * FROM music_legacy_identity WHERE json_extract(payload_json,'$.qq')=?").all(native)).toEqual([]);
      expect(JSON.stringify(db.prepare('SELECT * FROM music_legacy_identity').all())).not.toContain('native private note'); expect(db.prepare('SELECT * FROM music_legacy_erasures WHERE legacy_key=?').get(native)).toBeDefined();
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND entity_type='native_profiles'").get()).toEqual({ status: 'erased' });
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music' AND entity_type='profile' AND source_id=?").get(native)).toEqual({ status: 'erased' });
      expect((await importSnapshot(s.source, s.destination, stamp)).status).toBe('already_imported'); expect(db.prepare('SELECT * FROM music_selections WHERE profile_id=?').all(id)).toEqual([]);
      expect((await app.inject({ url: '/api/v2/session', headers: { cookie } })).json().authenticated).toBe(true);
    } finally { await app.close(); db.close(); }
  });
  it('account-only closure removes imported account proofs but retains the separate music and immutable ownership history for review', async () => {
    const s = setup(); await importSnapshot(s.source, s.destination, stamp); const db = openDatabase(join(s.destination, 'unified.sqlite3')); const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready();
    try {
      const cookie = 'kanban_session=fixture-bob'; const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
      db.prepare("INSERT INTO music_legacy_identity VALUES('link_audit',100,?)").run(JSON.stringify({ qq: native, actor: 'account:alice', before_user_id: 'bob', after_user_id: '', created: 1 }));
      const response = await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: { cookie, origin: 'https://rebuild.example', 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf }, payload: { target: 'account', profileId: profileId(native), profileRevision: 0, requestId: randomUUID(), secret: 'd'.repeat(64), confirm: true } });
      expect(response.statusCode).toBe(200); expect(response.json().status).toBe('shared_review'); expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId(native))).toEqual({ user_id: null });
      expect(db.prepare("SELECT * FROM music_legacy_identity WHERE table_name IN ('links','prelinks') AND json_extract(payload_json,'$.user_id')='bob'").all()).toEqual([]);
      const recovered = db.prepare("SELECT payload_json FROM music_legacy_identity WHERE table_name='native_profiles'").get() as { payload_json: string }; expect(JSON.parse(JSON.parse(recovered.payload_json).payload).boardUserId).toBe('');
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND entity_type='native_profiles'").get()).toEqual({ status: 'erasure_redacted' });
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music-identity' AND entity_type='prelinks' AND source_id='0'").get()).toEqual({ status: 'erased' });
      expect(db.prepare('SELECT fields_json,ownership_source FROM music_legacy_profiles WHERE legacy_key=?').get(native)).toMatchObject({ ownership_source: 'closed_account', fields_json: expect.stringContaining('native private note') });
      expect(db.prepare("SELECT count(*) n FROM music_legacy_identity WHERE table_name='link_audit'").get()).toEqual({ n: 2 });
    } finally { await app.close(); db.close(); }
  });
  it('rejects unknown fields, orphan choices, JSON-only links, duplicate owners and aliases without publishing a partial directory', async () => {
    const mutations = [
      (s: ReturnType<typeof setup>) => { Object.assign(s.music, { unexplained: { private: true } }); },
      (s: ReturnType<typeof setup>) => { s.music.members['10001'].selection = ['missing-entry']; },
      (s: ReturnType<typeof setup>) => { const db = new Database(join(s.source, 'music/identity.sqlite3')); db.prepare("UPDATE links SET openid='incorrect-subject' WHERE qq='10001'").run(); db.close(); },
      (s: ReturnType<typeof setup>) => { const db = new Database(join(s.source, 'music/identity.sqlite3')); db.prepare("DELETE FROM link_overrides WHERE qq='10003'").run(); db.close(); },
      (s: ReturnType<typeof setup>) => { const db = new Database(join(s.source, 'music/identity.sqlite3')); db.prepare("INSERT INTO prelinks VALUES('10003','alice',124)").run(); db.close(); },
      (s: ReturnType<typeof setup>) => { const db = new Database(join(s.source, 'music/identity.sqlite3')); db.prepare('UPDATE profile_contacts SET number=? WHERE qq=?').run('10001', native); db.close(); },
    ];
    for (const mutate of mutations) { const s = setup(); mutate(s); s.write('music/data.json', s.music); const before = allFiles(s.source); await expect(importSnapshot(s.source, s.destination, stamp)).rejects.toThrow(); expect(existsSync(s.destination)).toBe(false); expect(allFiles(s.source)).toEqual(before); expect(readdirSync(s.root)).toEqual(['snapshot']); }
  });
  it('rejects schema drift, source WAL sidecars, unsafe JSON, incomplete ledgers, missing pair components and symlinks', async () => {
    const changes = [
      (s: ReturnType<typeof setup>) => { const db = new Database(join(s.source, 'board.sqlite3')); db.exec('CREATE TABLE unclassified(secret TEXT)'); db.close(); },
      (s: ReturnType<typeof setup>) => s.write('board.sqlite3-wal', 'not-a-frozen-copy'),
      (s: ReturnType<typeof setup>) => s.write('music/data.json', '{"entries":{},"members":{},"members":{}}'),
      (s: ReturnType<typeof setup>) => s.write('music/data.json', '{"entries":{},"members":{},"trend":[9007199254740993]}'),
      (s: ReturnType<typeof setup>) => s.write('music/erasures.jsonl', '{"qq":"10001"}'),
      (s: ReturnType<typeof setup>) => rmSync(join(s.source, 'board.erasures.jsonl')),
      (s: ReturnType<typeof setup>) => { rmSync(join(s.source, 'music/walls/manifest.json')); symlinkSync(join(s.source, 'music/data.json'), join(s.source, 'music/walls/manifest.json')); },
    ];
    for (const change of changes) { const s = setup(); change(s); await expect(importSnapshot(s.source, s.destination, stamp)).rejects.toThrow(); expect(existsSync(s.destination)).toBe(false); }
    expect(() => parseJson('{"a":{"x":1,"x":2}}')).toThrow('Duplicate');
  });
  it('validates image bytes/references and wallpaper paths, skips erased/orphan private images, and preserves valid asset bytes', async () => {
    const s = setup(); const image = Buffer.from('synthetic-private-png'); const imageHash = digest(image); const path = 'images/' + imageHash.slice(0, 2) + '/' + imageHash + '.png'; mkdirSync(join(s.source, 'images', imageHash.slice(0, 2))); writeFileSync(join(s.source, path), image);
    const wallBytes=await sharp({create:{width:4,height:3,channels:3,background:'#286f83'}}).webp().toBuffer();writeFileSync(join(s.source,'music/walls/wall-one.webp'),wallBytes); s.write('music/walls/manifest.json', { items: [{ name: '壁紙', src: '/walls/wall-one.webp', enabled: false }], rotateSeconds: 24 });
    await importSnapshot(s.source, s.destination, stamp); expect(existsSync(join(s.destination, path))).toBe(false); expect(readFileSync(join(s.destination, 'walls/wall-one.webp'))).toEqual(wallBytes);
    const imported=openDatabase(join(s.destination,'unified.sqlite3'));try{expect(imported.prepare('SELECT data FROM wallpaper_assets').get()).toEqual({data:wallBytes});expect(imported.prepare('SELECT name,enabled,position FROM wallpaper_items').all()).toEqual([{name:'壁紙',enabled:0,position:0}]);}finally{imported.close();}
    const bad = setup(); bad.write('music/walls/manifest.json', { items: [{ src: '/walls/../data.json' }] }); await expect(importSnapshot(bad.source, bad.destination, stamp)).rejects.toThrow('wallpaper'); expect(existsSync(bad.destination)).toBe(false);
  });
  it('rejects malformed UTF-8 in each text source and never traverses unrelated parent directories during publication', async () => {
    for (const path of ['music/data.json', 'music/erasures.jsonl', 'board.erasures.jsonl', 'music/walls/manifest.json']) {
      const s = setup(); writeFileSync(join(s.source, path), Buffer.concat([Buffer.from('{"invalid":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));
      const before = allFiles(s.source); await expect(importSnapshot(s.source, s.destination, stamp)).rejects.toThrow(); expect(existsSync(s.destination)).toBe(false); expect(allFiles(s.source)).toEqual(before);
    }
    const s = setup(); const unrelated = join(s.root, 'unrelated'); mkdirSync(unrelated, { mode: 0o000 });
    try { expect((await importSnapshot(s.source, s.destination, stamp)).status).toBe('imported'); }
    finally { chmodSync(unrelated, 0o700); }
  });
  it('publishes only minimal CLI output, withholds partial candidates on a missing referenced image and keeps a valid referenced image byte-for-byte', async () => {
    const s = setup(); const bytes = Buffer.from('synthetic-referenced-private-image'); const image = digest(bytes); const path = 'images/' + image.slice(0, 2) + '/' + image + '.png';
    const board = new Database(join(s.source, 'board.sqlite3')); board.prepare("INSERT INTO image_assets VALUES(?,?,?,'before')").run(image, bytes.length, 'image/png'); board.prepare("INSERT INTO user_payment_codes VALUES('saved-code','alice','wechat','私人碼',?,'before',NULL)").run(image); board.close();
    await expect(importSnapshot(s.source, s.destination, stamp)).rejects.toThrow('Referenced board image is missing'); expect(existsSync(s.destination)).toBe(false);
    mkdirSync(join(s.source, 'images', image.slice(0, 2))); writeFileSync(join(s.source, path), bytes);
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'tools/migration/import-snapshot.ts', s.source, s.destination], { encoding: 'utf8' }); const result = JSON.parse(output);
    expect(Object.keys(result).sort()).toEqual(['releaseEligible', 'schema', 'sourceDigest', 'status']); expect(result).toMatchObject({ status: 'imported', schema: 15, releaseEligible: false }); expect(output).not.toMatch(/alice|bob|pin|private|QQ|10001/);
    expect(readFileSync(join(s.destination, path))).toEqual(bytes);
    const second = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tools/migration/import-snapshot.ts', s.source, s.destination], { encoding: 'utf8' })); expect(second.status).toBe('already_imported');
  });
  it('matches the original Python recovery, contact, override and normalized-choice projections on a synthetic pair', async () => {
    const s = setup(); await importSnapshot(s.source, s.destination, stamp);
    const python = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site.identity_store import Store
from music_site import contacts,admin_links,upstream
from music_site.maintenance import sanitize
from pathlib import Path
p=Path(sys.argv[1]);d=json.loads((p/'data.json').read_text());store=Store(p/'identity.sqlite3')
sanitize(d,{'10004'});store.recover_profiles(d);contacts.project(d,store);admin_links.projection(d,store)
print(json.dumps({k:dict(name=m['name'],owner=m.get('boardUserId',''),contact=contacts.number(d,k),selection=upstream.norm_selection(m.get('selection',[]))) for k,m in d['members'].items()}))`, join(s.source, 'music')], { encoding: 'utf8' }));
    const db = openDatabase(join(s.destination, 'unified.sqlite3'));
    try { for (const [key, value] of Object.entries(python) as [string, { name: string; owner: string; contact: string; selection: { id: string; level: number }[] }][]) {
      const row = db.prepare('SELECT m.name,m.contact_qq,p.user_id FROM music_legacy_profiles m JOIN music_profiles p ON p.id=m.profile_id WHERE m.legacy_key=?').get(key) as { name: string; contact_qq: string; user_id: string | null };
      expect({ name: row.name, owner: row.user_id ?? '', contact: row.contact_qq, selection: db.prepare('SELECT entry_id AS id,level FROM music_selections WHERE profile_id=? ORDER BY position').all(profileId(key)) }).toEqual(value);
    } } finally { db.close(); }
  });
  it('carries source PIN rate counters into active persistent limits without changing private source evidence',async()=>{
    const s=setup();const identity=new Database(join(s.source,'music/identity.sqlite3'));const bucket='qq:'+hash('10003');
    for(let i=0;i<8;i++)identity.prepare('INSERT INTO login_attempts VALUES(?,?)').run(bucket,stamp.getTime()/1000);identity.close();const before=allFiles(s.source);
    await importSnapshot(s.source,s.destination,stamp);const db=openDatabase(join(s.destination,'unified.sqlite3'));const app=createApp({db,origin:'https://rebuild.example',now:()=>stamp});await app.ready();
    try{
      expect(db.prepare('SELECT * FROM music_claim_attempts WHERE bucket=?').all(bucket)).toHaveLength(8);expect(db.prepare("SELECT * FROM music_legacy_identity WHERE table_name='login_attempts'").all()).toHaveLength(8);
      const response=await app.inject('/api/v2/session');const viewer=response.json();const cookie=String(response.headers['set-cookie']).split(';')[0]!;
      const limited=await app.inject({method:'POST',url:'/api/v2/music/claim/start',headers:{cookie,origin:'https://rebuild.example','x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf},payload:{requestId:randomUUID(),legacyQQ:'10003',pin:'000000',consent:true}});expect(limited.statusCode).toBe(429);expect(limited.json().code).toBe('PIN_RATE_LIMIT');expect(allFiles(s.source)).toEqual(before);
    }finally{await app.close();db.close();}
  });
});
