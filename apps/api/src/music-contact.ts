import { musicAvatars, withMusicAvatar } from './music-identity';
import { MusicProfilePath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LookupMusicProfile, SaveMusicContact, type MusicContact, type MemberMusicProfile } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { getProfile } from './repositories';
import { hash, type Security } from './security';
import { musicNoteAllowed } from './music-match-data';
import { resolveMusicProfileId } from './music-profile-id';
import { musicNameJoins, musicNameSQL, profileFields } from './music-fields';

type Contact = z.infer<typeof MusicContact>;
export function musicContact(db: DB, userId: string): Contact {
  const profile = getProfile(db, userId);
  if (!profile) throw withApiError(new DomainError('NO_PROFILE', '請先保存成分，再設定聯絡 QQ', 404));
  return db.prepare(`SELECT p.id AS profileId,COALESCE(c.contact_qq,'') AS contactQQ,COALESCE(c.source,'self_reported') AS source,COALESCE(c.revision,0) AS revision
    FROM music_profiles p LEFT JOIN music_profile_contacts c ON c.profile_id=p.id WHERE p.id=?`).get(profile.id) as Contact;
}
function memberProfile(db: DB, query: string, viewerId: string, clientId?: string): z.infer<typeof MemberMusicProfile> {
  const id = resolveMusicProfileId(db, query);
  const profile = db.prepare(`SELECT p.id,${musicNameSQL} AS name,
    COALESCE(c.contact_qq,'') AS contactQQ,CASE WHEN c.contact_qq!='' THEN c.source ELSE '' END AS contactSource
    FROM music_profiles p ${musicNameJoins}
    LEFT JOIN music_profile_contacts c ON c.profile_id=p.id WHERE p.id=?`).get(id) as Omit<z.infer<typeof MemberMusicProfile>, 'selections'>;
  const selections = db.prepare(`SELECT s.entry_id AS entryId,e.name,e.kind,s.level FROM music_selections s JOIN music_entries e ON e.id=s.entry_id
    WHERE s.profile_id=? ORDER BY s.position`).all(profile.id) as z.infer<typeof MemberMusicProfile>['selections'];
  const fields = profileFields(db, profile.id);
  const owner = db.prepare('SELECT 1 FROM music_profiles WHERE id=? AND user_id=?').get(profile.id, viewerId);
  return { ...withMusicAvatar(profile, musicAvatars(db, clientId)), gender: owner || fields.genderPublic ? fields.gender : '',
    note: musicNoteAllowed(db, viewerId, profile.id) ? fields.note : '', selections };
}
export function registerMusicContact(app: FastifyInstance, db: DB, security: Security, now: () => Date, clientId?: string) {
  app.get('/api/v2/me/music/contact', async request => musicContact(db, security.scopedMember(request).id));
  app.put('/api/v2/me/music/contact', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => db.transaction(() => {
    const member = security.memberWrite(request); const input = SaveMusicContact.parse(request.body);
    const key = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:PUT:/api/v2/me/music/contact:' + JSON.stringify(input));
    const previous = db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(member.id, key) as { signature: string; response_json: string; response_status: number } | undefined;
    if (previous) {
      if (previous.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409));
      reply.code(previous.response_status); return JSON.parse(previous.response_json) as Contact;
    }
    const before = musicContact(db, member.id);
    const epoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(member.id) as { epoch: number } | undefined)?.epoch ?? 0;
    if (input.profileId !== before.profileId || input.musicEpoch !== epoch) throw withApiError(new DomainError('PROFILE_ERASED', '成分已刪除或重建，請重新開啟目前成分', 409));
    if (input.revision !== before.revision) throw withApiError(new DomainError('CONTACT_CHANGED', '聯絡 QQ 已變更；請核對目前資料後再保存', 409));
    if (input.contactQQ !== before.contactQQ && before.source === 'legacy') throw withApiError(new DomainError('LEGACY_CONTACT_FIXED', '此 QQ 僅由管理員更正', 409));
    const duplicate = input.contactQQ && db.prepare(`SELECT 1 FROM music_profile_contacts WHERE contact_qq=? AND profile_id!=?
      UNION ALL SELECT 1 FROM music_legacy_identity i WHERE i.table_name='profile_contacts' AND json_extract(i.payload_json,'$.number')=?
      AND NOT EXISTS(SELECT 1 FROM music_legacy_profiles l WHERE l.legacy_key=json_extract(i.payload_json,'$.qq')) LIMIT 1`).get(input.contactQQ, before.profileId, input.contactQQ);
    if (duplicate) throw withApiError(new DomainError('CONTACT_IN_USE', '此 QQ 已有成分資料，請找回原成分或聯絡管理員核對', 409));
    const stamp = now().toISOString();
    if (input.contactQQ !== before.contactQQ) {
      db.prepare(`INSERT INTO music_profile_contacts VALUES(?,?,'self_reported',?,?) ON CONFLICT(profile_id) DO UPDATE
        SET contact_qq=excluded.contact_qq,revision=excluded.revision,updated_at=excluded.updated_at`).run(before.profileId, input.contactQQ, before.revision + 1, stamp);
      // The legacy adapter must project the canonical contact, including an explicit clear.
      db.prepare('UPDATE music_legacy_profiles SET contact_qq=? WHERE profile_id=?').run(input.contactQQ, before.profileId);
      db.prepare('UPDATE music_profiles SET revision=revision+1,updated_at=? WHERE id=?').run(stamp, before.profileId);
      const after = musicContact(db, member.id);
      db.prepare('INSERT INTO music_contact_history(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(before.profileId, after.revision, member.id, JSON.stringify(before), JSON.stringify(after), stamp);
    }
    const result = musicContact(db, member.id);
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(member.id, key, signature, JSON.stringify(result), stamp);
    db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(member.id, key, before.profileId);
    return result;
  }).immediate());
  // Numbers stay in the JSON body, outside browser history and request URL logs.
  app.post('/api/v2/music/profiles/lookup', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const viewer = security.memberWrite(request);
    if (!getProfile(db, viewer.id)) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好成分', 403));
    return memberProfile(db, LookupMusicProfile.parse(request.body).query, viewer.id, clientId);
  })());
  app.get('/api/v2/music/profiles/:id', async request => db.transaction(() => {
    const viewer = security.scopedMember(request);
    if (!getProfile(db, viewer.id)) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好成分', 403));
    const { id } = MusicProfilePath.parse(request.params);
    return memberProfile(db, id, viewer.id, clientId);
  })());
}
