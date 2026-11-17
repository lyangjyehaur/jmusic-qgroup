import type { DB } from '@qgroup/database';
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
      ).run(id === 'listen' ? person : id + '-' + person, id, user ?? 'alice', user, name, status);
  }
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
