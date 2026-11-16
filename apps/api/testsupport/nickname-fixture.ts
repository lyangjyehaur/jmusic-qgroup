import type { DB } from '@qgroup/database';
/** Synthetic only. Includes records that must never be renamed or re-queued. */
export function nicknameFixture(db: DB) {
  db.prepare("INSERT INTO bot_settings VALUES(1,2,'{\"enabled\":true,\"dry_run\":true}','before')").run();
  for (const event of ['listen', 'invite', 'draft', 'deleted', 'past']) {
    db.prepare('UPDATE events SET bot_enabled=1 WHERE id=?').run(event);
    db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,'alice','together','before')").run('party-' + event, event);
    for (const [kind, user, status] of [['self', 'alice', 'confirmed'], ['managed', 'bob', 'waiting'], ['guest', null, 'withdrawn']] as const) {
      db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at)
        VALUES(?,?,'alice',?,?,'frozen attendee name','private note','manager',?,'before','before')`).run(kind + '-' + event, event, user, 'party-' + event, status);
    }
    for (const status of ['pending', 'sending', 'sent', 'failed', 'skipped']) for (const channel of ['group', 'private']) db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,attempts,claim_token,simulated_at,created_at)
      VALUES(?,'synthetic',?,?,?,'{"template_version":1}',?,2,'existing-claim','simulation-only','before')`).run(event, channel + '-' + status, channel, 'synthetic-group', status);
  }
  db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('manager-only','karaoke','alice','bob','frozen','manager','confirmed','before','before')").run();
  db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('money','listen','expense','{\"amount_cents\":12345}','before','alice','小青','before')").run();
  db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES('listen',12345,2,'before','frozen nickname 小青')").run();
}
