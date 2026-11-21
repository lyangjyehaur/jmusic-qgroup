import { type DB, removeMusicShout } from '@qgroup/database';
import { hash } from '../src/app';
import { fixture } from './fixture';

export const shoutOrigin = 'https://rebuild.example';
export const shoutStamp = '2026-11-17T08:00:00.000Z';
export const shoutRescueKey = 'synthetic-shout-rescue-' + 'x'.repeat(32);
// Declared business expectations, independent of the runtime guards.
export const shoutActors = [
  { id: 'alice', member: true, music: true, admin: false },
  { id: 'bob', member: true, music: true, admin: false },
  { id: 'cohost', member: true, music: true, admin: false },
  { id: 'empty', member: true, music: false, admin: false },
  { id: 'admin', member: true, music: true, admin: true },
  { id: 'admin-empty', member: true, music: false, admin: true },
  { id: 'rescue', member: false, music: false, admin: true },
  { id: 'rescue-second', member: false, music: false, admin: true },
  { id: 'visitor', member: false, music: false, admin: false },
  { id: 'anonymous', member: false, music: false, admin: false },
] as const;
export const shoutProfileId = (id: string) => 'm_' + (shoutActors.findIndex(a => a.id === id) + 1).toString(16).padStart(24, '0');
export const shoutToken = (id: string) => ['alice', 'bob'].includes(id) ? 'fixture-' + id : 'shout-' + id;
export function shoutSnapshot(db: DB) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
export function shoutAuthorityFixture(db: DB) {
  fixture(db);
  for (const [index, a] of shoutActors.entries()) {
    if (!a.member) continue;
    if (!['alice', 'bob'].includes(a.id)) {
      db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash(shoutToken(a.id)), a.id, shoutStamp);
      db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash(shoutToken(a.id)), a.id, shoutStamp);
    }
    if (a.admin) db.prepare('INSERT INTO user_admin_roles VALUES(?,1,1,?)').run(a.id, shoutStamp);
    if (a.music) {
      const id = shoutProfileId(a.id);
      db.prepare('INSERT INTO music_profiles VALUES(?,?,1,?,NULL)').run(id, a.id, shoutStamp);
      db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,0,?,0,0,?)').run(id, 'Music ' + a.id, 'PRIVATE_NOTE_' + a.id, 'PRIVATE_GENDER_' + a.id, shoutStamp);
      db.prepare("INSERT INTO music_profile_contacts VALUES(?,?,'self_reported',0,?)").run(id, String(130000 + index), shoutStamp);
      db.prepare("INSERT INTO music_selections VALUES(?,'sub-2',3,0)").run(id);
    }
  }
  db.prepare("INSERT INTO event_roles VALUES('shout-cohost','listen','cohost','[\"roster\",\"schedule\"]',?)").run(shoutStamp);
  const time = Date.parse(shoutStamp) / 1000;
  for (const [index, state] of ['active', 'history', 'orphan', 'removed'].entries()) {
    const id = 'matrix-' + state, profile = state === 'orphan' ? null : shoutProfileId('bob'), archived = state === 'active' ? null : time - 100;
    db.prepare('INSERT INTO music_shouts VALUES(?,?,?,?,?,?,?,?)').run(id, profile, 'PRIVATE_LEGACY_KEY', 'Original author', 'CONTENT_' + state, time - 60, archived, index);
    // Two original copies and their maps must both be removed by moderation.
    for (const kind of ['shouts', 'shoutHistory']) {
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run(kind, index, JSON.stringify({ id, qq: 'PRIVATE_LEGACY_KEY', name: 'Original author', text: 'CONTENT_' + state, createdAt: time - 60 }));
      db.prepare("INSERT INTO migration_map VALUES('music',?,?,?,?,?,'imported')").run(kind, String(index), id, '', '');
    }
  }
  removeMusicShout(db, 'matrix-removed', 'deleted');
  for (const [index, state] of ['pending', 'sending', 'sent', 'failed', 'skipped'].entries()) {
    db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,created_at)
      VALUES('listen','synthetic',?,'synthetic','{}',?,2,?,'retry-time','simulated','before')`).run('shout-matrix-' + index, state, 'claim-' + index);
  }
}
