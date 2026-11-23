import type { DB } from '@qgroup/database';
import { createHash } from 'node:crypto';
/** Isolated native settlement scenarios, never included by runtime startup. */
export function settlementFixture(db: DB) {
  for (const id of ['listen', 'past', 'karaoke']) {
    db.prepare("UPDATE events SET lifecycle='ended',bot_enabled=1 WHERE id=?").run(id);
    db.prepare('INSERT INTO event_roles VALUES(?,?,?, ?,?)').run(
      'settlement-helper-' + id,
      id,
      'bob',
      '["settlement"]',
      'before',
    );
    for (const [person, user, name, status] of [
      ['aaaaaaaaaaaaaaaa', 'alice', '', 'confirmed'],
      ['bbbbbbbbbbbbbbbb', 'bob', '', 'confirmed'],
      ['cccccccccccccccc', null, '同行', 'confirmed'],
      ['dddddddddddddddd', null, '未到同行', 'withdrawn'],
    ] as const)
      db.prepare(
        "INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,confirmation_state,accepted_conditions_version,created_at,updated_at) VALUES(?,?,?,?,?,'self',?,'accepted',1,'before','before')",
      ).run(id === 'listen' ? person : id === 'karaoke' ? createHash('sha256').update(id+person).digest('hex').slice(0,16) : id + '-' + person, id, user ?? 'alice', user, name, status);
  }
  // A preserved legacy denominator differs from the current three-person roster.
  db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('karaoke',5,7,'舊分母保留','before')").run();
  db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('karaoke',1,5,7,'舊分母保留','before','alice','小青','published','[]')").run();
  // Imported plan history for pagination; no real events or money are touched.
  for (let version = 1; version <= 52; version++)
    db.prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)').run(
      'past',
      version,
      JSON.stringify([
        {
          id: '1111111111111111',
          name: '歷史房 ' + version,
          payer_id: 'synthetic-payer',
          payer_name: '小青',
          payer_label: '小青',
          person_ids: ['past-aaaaaaaaaaaaaaaa'],
        },
      ]),
      '2026-11-17T00:00:00+00:00',
    );
}
