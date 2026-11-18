import { withApiError } from './error-display';
import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
/** A lookup alias identifies data; it never grants ownership or changes the viewer. */
export function resolveMusicProfileId(db: DB, query: string) {
  const row = db.prepare(`SELECT p.id FROM music_profiles p
    LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id
    LEFT JOIN music_profile_contacts c ON c.profile_id=p.id
    WHERE p.erased_at IS NULL AND (p.id=? OR l.legacy_key=? OR (c.contact_qq!='' AND c.contact_qq=?))
    ORDER BY CASE WHEN p.id=? THEN 0 ELSE 1 END LIMIT 1`).get(query, query, query, query) as { id: string } | undefined;
  if (!row) throw withApiError(new DomainError('NOT_FOUND', '找不到這份成分；請核對固定成分 ID 或聯絡 QQ', 404));
  return row.id;
}
