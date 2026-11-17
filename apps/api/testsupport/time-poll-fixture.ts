import type { DB } from '@qgroup/database';
/** Imported polls intentionally retain expired candidates and old ballots. Synthetic only. */
export function timePollFixture(db: DB) {
  db.prepare("INSERT OR REPLACE INTO bot_settings VALUES(1,0,?,'synthetic')").run(
    JSON.stringify({
      enabled: true,
      groups: [{ id: 'synthetic-group', name: '測試群', replies: true, broadcast: true }],
    }),
  );
  for (const mode of ['date', 'exact']) {
    const id = 'poll-' + mode;
    db.prepare(
      "INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,created_at,time_mode,bot_enabled) VALUES(?,'alice',?,'约K','台北','','Asia/Taipei',?,5,1,'依實際分攤','2099-12-10T00:00:00+00:00','2026-11-17T00:00:00+00:00',?,1)",
    ).run(id, '時間投票 ' + mode, mode === 'date' ? 0 : 3, mode);
    for (const [position, start] of [
      '2020-01-01T00:00:00+00:00',
      '2099-12-11T00:00:00+00:00',
      '2099-12-12T00:00:00+00:00',
    ].entries())
      db.prepare('INSERT INTO time_poll_options VALUES(?,?,?,?)').run(id + '-' + position, id, position, start);
    db.prepare("INSERT INTO time_poll_ballots VALUES(?,'bob','2020-01-01T00:00:00+00:00')").run(id);
    db.prepare("INSERT INTO time_poll_votes VALUES(?,'bob',?,'yes')").run(id, id + '-0');
    db.prepare("INSERT INTO time_poll_votes VALUES(?,'bob',?,'yes')").run(id, id + '-1');
    db.prepare('UPDATE time_polls SET vote_revision=1 WHERE id=?').run(id);
  }
}
