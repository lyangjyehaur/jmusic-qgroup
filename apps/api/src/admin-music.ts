import {musicProfileActiveSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { SignedCursorQuery, AdminMusicSearch, PreviewMusicLink, SaveMusicLink, type AdminMusicProfile } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import type { AdminSecurity } from './admin-security';
import { hash } from './security';
import { invalidateMusicOwnership } from './music-ownership';
import { getProfile } from './repositories';
import { musicOwnershipHistory } from './music-admin-history';
import { musicNameJoins, musicNameSQL } from './music-fields';

type Profile = z.infer<typeof AdminMusicProfile>;
export const musicAdminProfileId = (params: unknown) => z.object({ id: z.string().regex(/^m_[a-f0-9]{24,40}$/) }).parse(params).id;
const projection = `SELECT p.id,${musicNameSQL} AS name,COALESCE(l.legacy_key,'') AS legacyKey,
  CASE WHEN l.pin_hash!='' THEN 1 ELSE 0 END AS hasPin,p.user_id AS userId,u.nickname,p.revision,
  CASE WHEN p.user_id IS NULL THEN 'unlinked' WHEN l.ownership_source='oauth' THEN 'oauth'
    WHEN l.ownership_source IN ('prelink','prelinked','admin_prelinked') THEN 'prelinked' ELSE 'account' END AS status
  FROM music_profiles p ${musicNameJoins}
  LEFT JOIN music_profile_contacts c ON c.profile_id=p.id`;
function serialize(db: DB, row: { id: string; name: string; legacyKey: string; hasPin: number; userId: string | null; nickname: string | null; revision: number; status: Profile['status'] }): Profile {
  return { id: row.id, name: row.name, legacyKey: row.legacyKey, hasPin: !!row.hasPin, owner: row.userId ? { id: row.userId, nickname: row.nickname ?? '未設定稱呼' } : null, revision: row.revision, status: row.status,
    selections: db.prepare(`SELECT s.entry_id AS entryId,e.name,e.kind,s.level FROM music_selections s JOIN music_entries e ON e.id=s.entry_id WHERE s.profile_id=? ORDER BY s.position`).all(row.id) as Profile['selections'] };
}
export function adminMusicProfile(db: DB, id: string, includeRetired=false) {
  const row = db.prepare(projection + ` WHERE p.id=? AND ${includeRetired?'p.erased_at IS NULL':musicProfileActiveSQL('p')}`).get(id) as Parameters<typeof serialize>[1] | undefined;
  if (!row) throw withApiError(new DomainError('PROFILE_NOT_FOUND', '成分不存在或已刪除', 404));
  return serialize(db, row);
}
function preview(db: DB, id: string, targetUserId: string | null) {
  const music = adminMusicProfile(db, id);
  const target = targetUserId === null ? null : db.prepare('SELECT id,nickname FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=users.id)').get(targetUserId) as { id: string; nickname: string } | undefined;
  if (target === undefined) throw withApiError(new DomainError('USER_NOT_FOUND', '目標帳號不存在或已關閉', 404));
  if (target) {
    const existing = getProfile(db, target.id);
    if (existing && existing.id !== music.id) throw withApiError(new DomainError('PROFILE_EXISTS', '目標帳號已有另一份成分，請先核對並解除原關聯；不會覆蓋或合併', 409));
  }
  const epochs = [music.owner?.id, target?.id].map(userId => userId ? (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(userId) ?? null) : null);
  return { profile: music, target: target ?? null, revision: hash(JSON.stringify({ music, target, epochs })) };
}
export function registerAdminMusic(app: FastifyInstance, db: DB, admin: AdminSecurity, now: () => Date) {
  // Search keys may contain contact QQs; never put them into URLs or browser history.
  app.post('/api/v2/admin/music/search', async request => {
    admin.authority(request, true); const input = AdminMusicSearch.parse(request.body);
    const where = `${musicProfileActiveSQL('p')} AND (?='' OR instr(lower(p.id),lower(?))>0 OR instr(lower(${musicNameSQL}),lower(?))>0
      OR instr(COALESCE(l.legacy_key,''),?)>0 OR instr(COALESCE(c.contact_qq,''),?)>0 OR instr(COALESCE(p.user_id,''),?)>0)`;
    const params = Array(6).fill(input.search) as string[];
    const sql = 'SELECT * FROM (' + projection + ' WHERE ' + where + ") WHERE (?='all' OR status=?)";
    const bindings = [...params, input.status, input.status];
    const total = (db.prepare('SELECT count(*) n FROM (' + sql + ')').get(...bindings) as { n: number }).n;
    const rows = db.prepare(sql + ' ORDER BY id LIMIT 20 OFFSET ?').all(...bindings, input.offset) as Parameters<typeof serialize>[1][];
    return { profiles: rows.map(row => serialize(db, row)), total, offset: input.offset, limit: 20 };
  });
  app.get('/api/v2/admin/music/:id', async request => { admin.authority(request); return adminMusicProfile(db, musicAdminProfileId(request.params)); });
  app.post('/api/v2/admin/music/:id/link-preview', async request => db.transaction(() => {
    admin.authority(request, true); return preview(db, musicAdminProfileId(request.params), PreviewMusicLink.parse(request.body).targetUserId);
  }).deferred());
  app.post('/api/v2/admin/music/:id/link', async request => db.transaction(() => {
    const access = admin.authority(request, true); const id = musicAdminProfileId(request.params); const input = SaveMusicLink.parse(request.body);
    const key = z.string().uuid().parse(request.headers['idempotency-key']); const signature = hash('v2:admin:music-link:' + id + ':' + JSON.stringify(input));
    const prior = db.prepare('SELECT signature FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope, key) as { signature: string } | undefined;
    if (prior) { if (prior.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於其他內容', 409)); return { ok: true }; }
    const before = preview(db, id, input.targetUserId);
    if (input.revision !== before.revision) throw withApiError(new DomainError('MUSIC_LINK_CHANGED', '成分、關聯或目標帳號已有變更，請重新預覽後核對', 409));
    admin.preserve(request);
    if ((before.profile.owner?.id ?? null) !== input.targetUserId) {
      const stamp = now().toISOString();
      db.prepare('UPDATE music_profiles SET user_id=?,revision=revision+1,updated_at=? WHERE id=?').run(input.targetUserId, stamp, id);
      db.prepare('UPDATE music_legacy_profiles SET ownership_source=? WHERE profile_id=?').run(input.targetUserId ? 'admin_prelinked' : 'admin_unlinked', id);
      invalidateMusicOwnership(db, id, [before.profile.owner?.id ?? null, input.targetUserId]);
      // Superseded source ownership must not reappear through a future legacy adapter
      // or be applied to the new owner when the former account is later closed.
      if (before.profile.legacyKey) {
        db.prepare(`UPDATE migration_map SET status='ownership_superseded' WHERE source='music-identity' AND EXISTS (
          SELECT 1 FROM music_legacy_identity i WHERE i.table_name=migration_map.entity_type AND CAST(i.row_number AS TEXT)=migration_map.source_id
          AND i.table_name IN ('links','prelinks','link_overrides') AND json_extract(i.payload_json,'$.qq')=?)`).run(before.profile.legacyKey);
        db.prepare("DELETE FROM music_legacy_identity WHERE table_name IN ('links','prelinks','link_overrides') AND json_extract(payload_json,'$.qq')=?").run(before.profile.legacyKey);
      }
      db.prepare('INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, before.profile.revision + 1, access.actorRef, before.profile.owner?.id ?? null, input.targetUserId, input.reason, stamp);
    }
    db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope, key, signature, '{"ok":true}', now().toISOString());
    return { ok: true };
  }).immediate());
  app.get('/api/v2/admin/music/:id/history', async request => {
    admin.authority(request); const id = musicAdminProfileId(request.params); adminMusicProfile(db, id);
    const { before } = SignedCursorQuery.parse(request.query);
    return musicOwnershipHistory(db, id, before);
  });
}
