import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture, catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { createPairedBackups } from './paired-backups';
import { erasureJournal, type ErasureJournal } from './erasure-journal';
import { exportMusic } from './music-export';
import { createPrivacy } from './privacy';
import { putPaymentImage } from './payment-media';
const origin = 'https://rebuild.example', stamp = '2026-11-17T08:00:00.000Z';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function source() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-backups-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, 'state.sqlite3')); cleanup.push(() => { db.close(); }); fixture(db); adminCatalogFixture(db);
  db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  let clock = new Date(stamp);
  const now = () => clock, journal = erasureJournal(db), backups = createPairedBackups(db, journal, now)!;
  return { root, db, now, journal, backups, clock: (time: string) => { clock = new Date(time); } };
}
async function setup() {
  const s = source(), app = createApp({ db: s.db, origin, now: s.now, pairedBackupScheduling: false }); await app.ready(); cleanup.push(() => app.close());
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const session = (await app.inject({ url: '/api/v2/admin/session', headers })).json(), admin = { ...headers, 'x-admin-csrf': session.adminCsrf };
  const read = (backup?: string, h = headers) => app.inject({ url: '/api/v2/admin/music-export' + (backup ? '?backup=' + backup : ''), headers: h });
  return { ...s, app, headers, admin, read };
}
function erase(db: DB, journal: ErasureJournal, reset = false) {
  const privacy = createPrivacy(db, journal), ids = Object.values(catalogProfiles);
  db.transaction(() => privacy.submit({ version: 2, kind: 'admin_music', command: reset ? 'reset_music' : 'delete_profile', actorRef: 'account:alice',
    profiles: (reset ? ids : [catalogProfiles.bob]).map(id => ({ id, userId: id === catalogProfiles.alice ? 'alice' : id === catalogProfiles.bob ? 'bob' : null })),
    entries: reset ? (db.prepare('SELECT id FROM music_entries').all() as { id: string }[]).map(e => e.id) : [], requestId: randomUUID(), createdAt: stamp, secretHash: hash('receipt-secret'), signature: hash('erase-command') })).immediate();
  privacy.guard();
}
describe('administrative music exports and native paired backups', () => {
  it('creates startup/hourly checkpoints and stops the schedule on shutdown', async () => {
    const s = source(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = createApp({ db: s.db, origin, now: s.now });
    try {
      await app.ready(); expect(s.backups.list()).toHaveLength(1);
      s.clock('2026-11-17T09:00:00.000Z'); await vi.advanceTimersByTimeAsync(3600000); expect(s.backups.list()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3600000); expect(s.backups.list()).toHaveLength(2);
      await app.close(); s.clock('2026-11-17T11:00:00.000Z'); await vi.advanceTimersByTimeAsync(3600000); expect(s.backups.list()).toHaveLength(2);
    } finally { await app.close(); vi.useRealTimers(); }
  });
  it('projects current selections, fields, ownership, explicit contact clearing, creation lists and ordered trends without reviving legacy credentials', async () => {
    const s = await setup();
    s.db.prepare('UPDATE music_profile_fields SET name=?,note=?,gender=?,gender_public=1 WHERE profile_id=?').run('目前稱呼', '目前私人留言', 'custom', catalogProfiles.bob);
    s.db.prepare("INSERT INTO music_profile_contacts VALUES(?,'','legacy',1,'now')").run(catalogProfiles.bob);
    s.db.prepare("INSERT INTO music_documents VALUES('settings',0,?)").run(JSON.stringify({ adminPasswordHash: 'DO-NOT-EXPORT' }));
    for (const [kind, time] of [['trend', 1], ['trend_sample', 2]] as const) s.db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind, JSON.stringify({ t: time, counts: { 'sub-0': 2 } }));
    const result = await s.read(), data = result.json(); expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers['content-disposition']).toMatch(/^attachment; filename="music-data-/);
    expect(data.members['10002']).toMatchObject({ name: '目前稱呼', note: '目前私人留言', gender: 'custom', genderPublic: true, pinHash: 'private', boardUserId: 'bob', contactQQ: '', selection: [{ id: 'sub-1', level: 4 }, { id: 'sub-0', level: 1 }], created: ['sub-1', 'sub-0', 'main-0'] });
    expect(data.entries['sub-0']).toMatchObject({ createdBy: catalogProfiles.alice, aliases: ['源別名', 'Yoru', '\ufeff保留'], createdAt: 123 });
    expect(data.trend.map((point: { t: number }) => point.t)).toEqual([1, 2]); expect(data.settings).toEqual({}); expect(result.body).not.toMatch(/DO-NOT-EXPORT|fixture-alice|csrf|token_hash/);
  });
  it('captures WAL, image bytes, wallpaper BLOBs, all bot rows and durable ledger consistently with private permissions and unique names', () => {
    const s = source(), raw = Buffer.from('synthetic-image-bytes');
    const digest = s.db.transaction(() => putPaymentImage(s.db, raw, s.now())).immediate();
    const wall = Buffer.from('synthetic-wallpaper'), wallHash = createHash('sha256').update(wall).digest('hex'); s.db.prepare("INSERT INTO wallpaper_assets VALUES(?,'image/png',?,?)").run(wallHash, wall, wall.length);
    for (const [index, status] of ['pending', 'pending', 'sending', 'sent', 'failed', 'skipped'].entries())
      s.db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,last_error,claim_token,retry_at,simulated_at,created_at,delivered_payload_json)
        VALUES('listen','synthetic',?,'synthetic','{"frozen":true}',?,2,?,?,?,?,'before',?)`).run('checkpoint-' + index, status,
        status === 'sending' ? 'delivery unconfirmed' : '', status === 'sending' ? 'synthetic-claim' : '', status === 'failed' ? 'retry-time' : null,
        index === 1 ? 'simulated-time' : null, status === 'sent' ? '{"frozenDelivered":true}' : null);
    const botTables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bot_%' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    const before = botTables.map(table => s.db.prepare('SELECT * FROM ' + table).all()), item = s.backups.capture(), second = s.backups.capture(); expect(second.id).not.toBe(item.id);
    const base = join(s.root, 'paired-backups', item.id), m = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
    expect(m.restoreEligible).toBe(false); expect(statSync(base).mode & 0o777).toBe(0o700);
    for (const f of m.files) expect(statSync(join(base, f.path)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(base, 'images', digest.slice(0, 2), digest + '.png'))).toEqual(raw);
    const copy = s.backups.open(item.id); try { expect(copy.prepare('SELECT data FROM wallpaper_assets').get()).toEqual({ data: wall }); expect(botTables.map(table => copy.prepare('SELECT * FROM ' + table).all())).toEqual(before); expect(exportMusic(copy)).toEqual(exportMusic(s.db)); } finally { copy.close(); }
    const probe = (path: string) => execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' }); expect(probe(join(base, 'state.sqlite3'))).toEqual(probe(s.db.name));
    expect(s.db.prepare('SELECT digest FROM image_assets').get()).toEqual({ digest });
  });
  it('backs up before administrative mutations and blocks the mutation if the image pair cannot be saved', async () => {
    const s = await setup(), before = exportMusic(s.db);
    const request = { method: 'POST' as const, url: '/api/v2/admin/music/' + catalogProfiles.bob + '/pin', headers: { ...s.admin, 'idempotency-key': randomUUID() }, payload: { revision: 0, pin: '123456', reason: '核對後重設', confirm: true } };
    const response = await s.app.inject(request); expect(response.statusCode, response.body).toBe(200); expect(s.backups.list()).toHaveLength(1);
    const copy = s.backups.open(s.backups.list()[0]!.id); try { expect(exportMusic(copy)).toEqual(before); } finally { copy.close(); }
    const digest = s.db.transaction(() => putPaymentImage(s.db, Buffer.from('image'), s.now())).immediate(); rmSync(join(s.root, 'images', digest.slice(0, 2), digest + '.png'));
    expect((await s.app.inject(request)).statusCode).toBe(200); // Existing receipts need no new snapshot.
    expect(s.backups.list()).toHaveLength(1);
    const pin = s.db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(catalogProfiles.bob);
    const fail = await s.app.inject({ ...request, headers: { ...s.admin, 'idempotency-key': randomUUID() }, payload: { ...request.payload, revision: 1, pin: '654321' } });
    expect(fail.statusCode).toBe(503); expect(fail.json().code).toBe('BACKUP_REQUIRED'); expect(s.db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(catalogProfiles.bob)).toEqual(pin);
    expect(readdirSync(join(s.root, 'paired-backups')).some(name => name.endsWith('.tmp'))).toBe(false);
    const result = await s.app.inject({ method: 'POST', url: '/api/v2/admin/music/' + catalogProfiles.bob + '/pin-result', headers: s.admin, payload: { requestId: request.headers['idempotency-key'] } });
    expect(result.json()).toEqual({ status: 'completed' });
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/admin/logout', headers: s.admin, payload: { confirm: true } })).statusCode).toBe(200);
  });
  it('takes the wallpaper checkpoint after asynchronous decoding and concurrent changes, immediately before the write', async () => {
    const s = await setup(), descriptor = Object.getOwnPropertyDescriptor(sharp.prototype, 'stats')!;
    let arrived!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    const raw = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    const appearance = (await s.app.inject({ url: '/api/v2/admin/appearance', headers: s.headers })).json();
    Object.defineProperty(sharp.prototype, 'stats', { ...descriptor, value: async function(this: Sharp) { arrived(); await pending; return descriptor.value.call(this); } });
    try {
      const request = s.app.inject({ method: 'POST', url: '/api/v2/admin/appearance', headers: { ...s.admin, 'idempotency-key': randomUUID() }, payload: { command: 'upload', name: '合成', revision: appearance.revision, confirm: true, mime: 'image/png', data: raw.toString('base64') } });
      // LightMyRequest is thenable: start execution before waiting for its decoder.
      const response = Promise.resolve(request); await started; expect(s.backups.list()).toEqual([]);
      s.db.prepare("UPDATE events SET title='解碼期間的新資料' WHERE id='listen'").run(); release(); expect((await response).statusCode).toBe(200);
      const copy = s.backups.open(s.backups.list()[0]!.id);
      try { expect(copy.prepare("SELECT title FROM events WHERE id='listen'").get()).toEqual({ title: '解碼期間的新資料' }); expect(copy.prepare('SELECT * FROM wallpaper_items').all()).toEqual([]); } finally { copy.close(); }
      expect(s.db.prepare('SELECT count(*) n FROM wallpaper_items').get()).toEqual({ n: 1 });
    } finally { release(); Object.defineProperty(sharp.prototype, 'stats', descriptor); }
  });
  it('holds the real writer lock even when a caller entered a deferred transaction', () => {
    const s = source(), rival = openDatabase(s.db.name); rival.pragma('busy_timeout=0');
    try {
      const backups = createPairedBackups(s.db, { read() { expect(() => rival.prepare("UPDATE events SET title='must not write' WHERE id='listen'").run()).toThrow(/locked/); return []; }, append() { throw new Error('Not used'); } }, s.now)!;
      s.db.transaction(() => backups.capture()).deferred(); expect(s.backups.list()).toHaveLength(1);
    } finally { rival.close(); }
  });
  it('keeps current and historical exports coherent with a competing erasure writer throughout latest-ledger verification', async () => {
    const s=source(),item=s.backups.capture(),rival=openDatabase(s.db.name);rival.pragma('busy_timeout=0');let probing=false,checks=0;
    const app=createApp({db:s.db,origin,pairedBackupScheduling:false,erasureJournal:{
      read(){if(probing){checks++;expect(()=>rival.prepare("UPDATE users SET nickname='concurrent erasure' WHERE id='bob'").run()).toThrow(/locked/);}return s.journal.read();},
      append:entry=>s.journal.append(entry),
    }});
    try {
      await app.ready();const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();probing=true;
      for(const suffix of ['', '?backup='+item.id]){const response=await app.inject({url:'/api/v2/admin/music-export'+suffix,headers:{cookie,'x-account-scope':viewer.scope}});expect(response.statusCode,response.body).toBe(200);}
      expect(checks).toBe(2);expect(s.db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'小白'});
    } finally {await app.close();rival.close();}
  });
  it('downloads historical data with latest ownership, explicit empty contact and PIN state while preserving historical fields and all originals', async () => {
    const s = await setup(); s.db.prepare("INSERT INTO music_profile_contacts VALUES(?,'10002','legacy',0,'before')").run(catalogProfiles.bob);
    const item = s.backups.capture(), original = readFileSync(join(s.root, 'paired-backups', item.id, 'state.sqlite3'));
    s.db.prepare("UPDATE music_profile_fields SET name='新版稱呼' WHERE profile_id=?").run(catalogProfiles.bob);
    s.db.prepare("UPDATE music_profile_contacts SET contact_qq='' WHERE profile_id=?").run(catalogProfiles.bob);
    s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE id=?").run(catalogProfiles.bob); s.db.prepare("UPDATE music_legacy_profiles SET pin_hash='new-pin' WHERE profile_id=?").run(catalogProfiles.bob);
    const result = await s.read(item.id); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().members['10002']).toMatchObject({ name: '詞庫bob', boardUserId: '', contactQQ: '', pinHash: 'new-pin' });
    expect(readFileSync(join(s.root, 'paired-backups', item.id, 'state.sqlite3'))).toEqual(original); expect(exportMusic(s.db).members['10002']).toMatchObject({ name: '新版稱呼' });
  });
  it('replays newer deletion and RESET intents onto historical snapshots without changing live data or replaying bot jobs', async () => {
    for (const reset of [false, true]) {
      const s = await setup(); s.db.prepare("INSERT INTO music_shouts VALUES('old',?,'10002','稱呼','PRIVATE-ERASED',123,NULL,0)").run(catalogProfiles.bob);
      s.db.prepare("INSERT INTO music_shouts VALUES('orphan',NULL,'99999','稱呼','ORPHAN-RESET',123,NULL,1)").run();
      s.db.prepare("INSERT INTO music_documents VALUES('trend',0,'{\"t\":123,\"counts\":{}}')").run();
      const item = s.backups.capture(), bot = s.db.prepare('SELECT * FROM bot_outbox').all(); erase(s.db, s.journal, reset);
      const live = exportMusic(s.db), result = await s.read(item.id); expect(result.statusCode, result.body).toBe(200);
      expect(result.json().members['10002']).toBeUndefined(); expect(result.body).not.toContain('PRIVATE-ERASED');
      if (reset) expect(result.json()).toEqual({ entries: {}, members: {}, settings: {}, shouts: [], shoutHistory: [], trend: [] });
      else expect(result.json().entries['sub-1'].createdBy).toBe('');
      expect(exportMusic(s.db)).toEqual(live); expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(bot);
    }
  });
  it('does not remove post-RESET data when applied markers are present and closes historical account bindings without deleting retained music', async () => {
    const s = await setup(); erase(s.db, s.journal, true); s.db.prepare("INSERT INTO music_entries VALUES('after-reset','新詞條','sub')").run();
    const item = s.backups.capture(); expect((await s.read(item.id)).json().entries['after-reset'].text).toBe('新詞條');
    const t = await setup(), old = t.backups.capture(), privacy = createPrivacy(t.db, t.journal);
    t.db.transaction(() => privacy.submit({ version: 1, kind: 'account', userId: 'bob', profileId: catalogProfiles.bob, requestId: randomUUID(), createdAt: stamp, secretHash: hash('secret'), signature: hash('close') })).immediate(); privacy.guard();
    expect((await t.read(old.id)).json().members['10002']).toMatchObject({ boardUserId: '', name: '詞庫bob' });
  });
  it('requires current administrator and account scope, validates names and ignores no unknown query fields', async () => {
    const s = await setup(), item = s.backups.capture();
    expect((await s.app.inject({ url: '/api/v2/admin/music-export' })).statusCode).toBe(401);
    expect((await s.read(item.id, { ...s.headers, 'x-account-scope': 'wrong' })).statusCode).toBe(409);
    for (const query of ['?backup=../state.sqlite3', '?backup=' + item.id + '&extra=x']) expect((await s.app.inject({ url: '/api/v2/admin/music-export' + query, headers: s.headers })).statusCode).toBe(400);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run(); expect((await s.read(item.id)).statusCode).toBe(403);
  });
  it('rejects corrupt snapshots, missing files, manifest omissions and symlinks without fallback to unsanitized JSON', async () => {
    const s = await setup(), item = s.backups.capture(), base = join(s.root, 'paired-backups', item.id), path = join(base, 'state.sqlite3'), raw = readFileSync(path);
    writeFileSync(path, raw.subarray(0, raw.length - 1)); expect((await s.read(item.id)).statusCode).toBe(503); writeFileSync(path, raw);
    rmSync(path); symlinkSync(s.db.name, path); expect((await s.read(item.id)).statusCode).toBe(503); rmSync(path); writeFileSync(path, raw);
    rmSync(join(base, 'state.erasures.jsonl')); expect((await s.read(item.id)).statusCode).toBe(503);
    const digest = s.db.transaction(() => putPaymentImage(s.db, Buffer.from('image'), s.now())).immediate(), next = s.backups.capture(), manifestPath = join(s.root, 'paired-backups', next.id, 'manifest.json'), m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.files = m.files.filter((f: { path: string }) => !f.path.includes(digest)); writeFileSync(manifestPath, JSON.stringify(m)); expect((await s.read(next.id)).statusCode).toBe(503);
  });
  it('retains no more than 30 backups or 14 days, leaves unrelated files alone and refuses unsafe retention contents', () => {
    const s = source(); const oldest = s.backups.capture();
    for (let i = 1; i < 33; i++) { s.clock('2026-11-17T08:00:' + String(i).padStart(2, '0') + '.000Z'); s.backups.capture(); }
    writeFileSync(join(s.root, 'paired-backups', 'operator-note'), 'retain'); s.backups.prune(); expect(s.backups.list()).toHaveLength(30); expect(existsSync(join(s.root, 'paired-backups', oldest.id))).toBe(false);
    const protectedBackup = s.backups.list()[0]!; writeFileSync(join(s.root, 'paired-backups', protectedBackup.id, 'operator-note'), 'retain');
    s.clock('2026-12-02T08:00:00.000Z'); expect(() => s.backups.prune()).toThrow('Unclassified'); expect(existsSync(join(s.root, 'paired-backups', protectedBackup.id, 'operator-note'))).toBe(true);
    rmSync(join(s.root, 'paired-backups', protectedBackup.id, 'operator-note')); s.backups.prune(); expect(s.backups.list()).toEqual([]); expect(readFileSync(join(s.root, 'paired-backups', 'operator-note'), 'utf8')).toBe('retain');
  });
  it('orders same-clock and restarted captures by a durable sequence instead of random UUID order', () => {
    const s = source(), first = s.backups.capture(), second = s.backups.capture();
    expect(s.backups.list().map(item => item.id)).toEqual([second.id, first.id]);
    const restarted = createPairedBackups(s.db, s.journal, s.now)!, third = restarted.capture();
    expect(restarted.list().map(item => item.id)).toEqual([third.id, second.id, first.id]);
  });
  it('fails closed on corrupt erasure ledgers and symlinked roots, preserving the previous backups', () => {
    const s = source(), item = s.backups.capture(); writeFileSync(join(s.root, 'state.erasures.jsonl'), '{broken'); expect(() => s.backups.capture()).toThrow(); expect(s.backups.list().map(x => x.id)).toEqual([item.id]);
    const t = source(); symlinkSync(s.root, join(t.root, 'paired-backups')); expect(() => t.backups.capture()).toThrow('Unsafe');
  });
  it('refuses exports and new backups when the latest ledger is lost, pending or conflicts with a committed receipt', async () => {
    const s = await setup(), item = s.backups.capture(); erase(s.db, s.journal);
    const path = join(s.root, 'state.erasures.jsonl'), raw = readFileSync(path);
    rmSync(path); expect((await s.read()).statusCode).toBe(503); expect((await s.read(item.id)).statusCode).toBe(503); expect(() => s.backups.capture()).toThrow('markers differ');
    writeFileSync(path, raw); expect((await s.read(item.id)).statusCode).toBe(200);
    const modified = JSON.parse(raw.toString()); modified.signature = hash('corrupt-signature'); writeFileSync(path, JSON.stringify(modified) + '\n');
    expect((await s.read(item.id)).statusCode).toBe(503); expect(() => s.backups.capture()).toThrow('receipt differ'); writeFileSync(path, raw);
    // A durable intent written by a second process without a committed apply
    // must block the old process's exports until recovery completes.
    s.journal.append({ version: 1, kind: 'music', userId: 'bob', profileId: catalogProfiles.orphan, requestId: randomUUID(), createdAt: stamp, secretHash: hash('pending-secret'), signature: hash('pending-command') });
    expect((await s.read()).statusCode).toBe(503); expect(() => s.backups.capture()).toThrow('markers differ'); createPrivacy(s.db, s.journal);
    const recovered = await s.read(item.id); expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().members['10003']).toBeUndefined();
  });
});
