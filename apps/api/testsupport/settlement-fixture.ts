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
}
