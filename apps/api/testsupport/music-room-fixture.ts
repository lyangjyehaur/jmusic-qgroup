import type { DB } from '@qgroup/database';
/** Isolated synthetic room roster; the preview composes it with catalog examples. */
export function musicRoomFixture(db: DB) {
  db.exec(
    "INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('room-party','listen','alice','individual','synthetic'); INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,payer_kind,status,created_at,updated_at) VALUES('room-alice','listen','alice','alice','room-party','小青','self','confirmed','synthetic','synthetic'),('room-bob','listen','alice','bob','room-party','小白','self','waiting','synthetic','synthetic'),('room-guest','listen','alice',NULL,'room-party','沒有成分的同行','manager','tentative','synthetic','synthetic');",
  );
}
