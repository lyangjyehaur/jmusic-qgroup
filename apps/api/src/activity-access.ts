import type { DB } from '@qgroup/database';
import { DomainError } from '@qgroup/domain';
/** Preserve the original event access policy; site administrator is not an invitation. */
export function requireActivityAccess(db: DB, id: string, viewerId: string | null) {
  const event = db.prepare('SELECT id,owner_id,visibility,lifecycle,status,revision FROM events WHERE id=?').get(id) as {id:string;owner_id:string;visibility:string;lifecycle:string;status:string;revision:number} | undefined;
  if (!event || event.status === 'deleted') throw new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404);
  let allowed = event.visibility === 'public' || event.owner_id === viewerId;
  if (event.lifecycle === 'draft') {
    const role = viewerId ? db.prepare('SELECT permissions_json FROM event_roles WHERE event_id=? AND user_id=?').get(id, viewerId) as {permissions_json:string} | undefined : undefined;
    const scopes: unknown = role ? JSON.parse(role.permissions_json) : [];
    if (!Array.isArray(scopes) || scopes.some(scope=>typeof scope !== 'string')) throw new Error('Invalid stored event scopes');
    allowed = event.owner_id === viewerId || scopes.length > 0;
  } else if (!allowed && viewerId) allowed = !!db.prepare('SELECT 1 FROM event_access WHERE event_id=? AND user_id=?').get(id, viewerId);
  if (!allowed) throw new DomainError('NOT_FOUND', '找不到活動或尚未公開', 404);
  return event;
}
