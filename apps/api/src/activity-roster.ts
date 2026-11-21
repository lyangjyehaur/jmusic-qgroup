import { ActivityAttendeePath, ActivityPath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import type { ActivityRoster, AttendeeMusic } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { requireActivityAccess } from './activity-access';
import { getProfile } from './repositories';
import { profileFields } from './music-fields';
import { safeAvatar } from './qq-provider';
import type { Security } from './security';

/** An absent scope always receives the anonymous public view, even with a cookie. */
export function activityViewer(security: Security, request: Parameters<Security['scoped']>[0]) {
  if (!request.headers['x-account-scope']) return null;
  const viewer = security.scoped(request); return viewer.kind === 'member' ? viewer.id : null;
}
export function activityRoster(db: DB, id: string, viewerId: string | null, qqClientId?: string): z.infer<typeof ActivityRoster> {
  const event = requireActivityAccess(db,id,viewerId);
  const rows = db.prepare(`SELECT a.id,COALESCE(u.nickname,a.name) AS name,a.note,a.status,a.user_id,a.manager_id,
    a.withdrawal_requested,a.confirmation_state,a.attendance,a.payer_kind,m.nickname AS manager_name,
    o.payer_name AS origin_payer,ep.avatar_url
    FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN roster_parties party ON party.id=a.party_id LEFT JOIN attendee_payment_origins o ON o.attendee_id=a.id
    LEFT JOIN external_identities ei ON ei.user_id=a.user_id AND ei.provider='qq' AND ei.client_id=?
    LEFT JOIN external_profiles ep ON ep.user_id=ei.user_id AND ep.provider=ei.provider AND ep.client_id=ei.client_id
    WHERE a.event_id=? AND a.status IN ('confirmed','waiting','tentative') ORDER BY party.seq,a.seq`).all(qqClientId ?? '',id) as {id:string;name:string;note:string;status:'confirmed'|'waiting'|'tentative';user_id:string|null;manager_id:string;withdrawal_requested:number;confirmation_state:string;attendance:string;payer_kind:string;manager_name:string;origin_payer:string|null;avatar_url:string|null}[];
  let waiting = 0;
  const participants = rows.map((row,index) => ({
    id:row.id,name:row.name,note:row.note,status:row.status,position:index+1,waitingPosition:row.status === 'waiting' ? ++waiting : null,
    isMe:!!viewerId && row.user_id === viewerId,isGuest:row.user_id === null,managedByMe:row.manager_id === viewerId,
    managerName:row.manager_name,payerName:row.origin_payer ?? (row.payer_kind === 'self' ? row.name : row.manager_name),
    withdrawalRequested:!!row.withdrawal_requested,confirmationState:row.confirmation_state,attendance:row.attendance,avatarUrl:safeAvatar(row.avatar_url ?? ''),
  })).sort((a,b) => ['confirmed','waiting','tentative'].indexOf(a.status)-['confirmed','waiting','tentative'].indexOf(b.status));
  return {eventId:id,revision:event.revision,participants};
}
export function attendeeMusic(db: DB, eventId: string, attendeeId: string, viewerId: string): z.infer<typeof AttendeeMusic> {
  requireActivityAccess(db,eventId,viewerId);
  const person = db.prepare("SELECT user_id FROM attendees WHERE id=? AND event_id=? AND status IN ('confirmed','waiting','tentative')").get(attendeeId,eventId) as {user_id:string|null} | undefined;
  if (!person) throw withApiError(new DomainError('ATTENDEE_NOT_FOUND', '報名不存在或已退出',404));
  // Never use manager_id, a matching name, contact QQ or an unconfirmed claim.
  if (!person.user_id || db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(person.user_id)) return {state:'unlinked'};
  const own = getProfile(db,viewerId); if (!own) return {state:'viewer_unlinked'};
  const target = getProfile(db,person.user_id); if (!target) return {state:'unlinked'};
  const common = new Set(own.selections.map(pick=>pick.entryId));
  const picks = db.prepare('SELECT s.entry_id AS entryId,e.name,e.kind,s.level FROM music_selections s JOIN music_entries e ON e.id=s.entry_id WHERE s.profile_id=? ORDER BY s.position').all(target.id) as {entryId:string;name:string;kind:'main'|'sub';level:number}[];
  return {state:'ready',profileId:target.id,name:profileFields(db,target.id).name,isSelf:person.user_id===viewerId,picks:picks.map(pick=>({...pick,shared:common.has(pick.entryId)}))};
}
export function registerActivityRoster(app: FastifyInstance, db: DB, security: Security, qqClientId?: string) {
  app.get('/api/v2/activities/:id/roster',async request => {
    const {id}=ActivityPath.parse(request.params);return db.transaction(()=>activityRoster(db,id,activityViewer(security,request),qqClientId))();
  });
  app.get('/api/v2/activities/:id/attendees/:attendeeId/music',async request => {
    const {id,attendeeId}=ActivityAttendeePath.parse(request.params);
    return db.transaction(()=>attendeeMusic(db,id,attendeeId,security.scopedMember(request).id))();
  });
}
