import type { DB } from '@qgroup/database';
import { createHash } from 'node:crypto';
/** Synthetic unowned legacy profiles. No real member keys, credentials or PINs. */
export function musicClaimFixture(db: DB) {
  for (const key of ['10001','10002','10003']) {
    const id = 'm_' + createHash('sha256').update('synthetic-claim:' + key).digest('hex').slice(0,40);
    db.prepare("INSERT INTO music_profiles VALUES(?,NULL,7,'synthetic',NULL)").run(id);
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(id, key, '舊成分 ' + key, 1, key === '10003' ? '' : createHash('sha256').update('jpm-pin|123456').digest('hex'), key, '{"gender":"private gender","note":"private note"}', '[]', 'unlinked');
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,?,'legacy',0,'synthetic')").run(id, key);
    db.prepare("INSERT INTO music_selections VALUES(?,'sub-2',4,0)").run(id);
  }
}
