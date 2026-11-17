import type { DB } from '@qgroup/database';
import { musicMatchingFixture } from './music-matching-fixture';
/** Source-equivalent aggregate history only. Never used by the runtime. */
export function musicTrendFixture(db: DB, stamp = new Date()) {
  musicMatchingFixture(db);
  const now = Math.trunc(stamp.getTime() / 1000);
  for (let i = 0; i < 8; i++) {
    const time = now - i * 43200;
    db.prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)').run('sub-' + i, '歌手', '[]', '', JSON.stringify(time), 'null');
    db.prepare('UPDATE music_profile_creation SET created_at=? WHERE profile_id=?').run(new Date(time * 1000).toISOString(), 'm_' + (i + 1).toString(16).padStart(24, '0'));
  }
  [ { 'main-0': 2, 'main-1': 1, 'sub-0': 1 }, { 'main-0': 1, 'main-1': 3, 'sub-0': 0 }, { 'main-0': 4, 'main-1': 3, 'sub-0': 3 } ].forEach((counts, i) => {
    db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('trend', i, JSON.stringify({ t: now - (3 - i) * 1800, counts }));
  });
}
