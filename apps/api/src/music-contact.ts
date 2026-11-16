import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LookupMusicProfile, SaveMusicContact, type MusicContact, type MemberMusicProfile } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { getProfile } from './repositories';
import { hash, type Security } from './security';

type Contact = z.infer<typeof MusicContact>;
export function musicContact(db: DB, userId: string): Contact {
  const profile = getProfile(db, userId);
  if (!profile) throw new DomainError('NO_PROFILE', '請先保存成分，再設定聯絡 QQ', 404);
  return db.prepare(`SELECT p.id AS profileId,COALESCE(c.contact_qq,'') AS contactQQ,COALESCE(c.source,'self_reported') AS source,COALESCE(c.revision,0) AS revision
    FROM music_profiles p LEFT JOIN music_profile_contacts c ON c.profile_id=p.id WHERE p.id=?`).get(profile.id) as Contact;
}
function memberProfile(db: DB, query: string): z.infer<typeof MemberMusicProfile> {
  const profile = db.prepare(`SELECT p.id,COALESCE(NULLIF(l.name,''),u.nickname,'未命名成分') AS name,
    COALESCE(c.contact_qq,'') AS contactQQ,CASE WHEN c.contact_qq!='' THEN c.source ELSE '' END AS contactSource
    FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN users u ON u.id=p.user_id
    LEFT JOIN music_profile_contacts c ON c.profile_id=p.id WHERE p.erased_at IS NULL AND (p.id=? OR l.legacy_key=? OR (c.contact_qq!='' AND c.contact_qq=?))
    ORDER BY CASE WHEN p.id=? THEN 0 ELSE 1 END LIMIT 1`).get(query, query, query, query) as Omit<z.infer<typeof MemberMusicProfile>, 'selections'> | undefined;
  if (!profile) throw new DomainError('NOT_FOUND', '找不到這份成分；請核對固定成分 ID 或聯絡 QQ', 404);
  const selections = db.prepare(`SELECT s.entry_id AS entryId,e.name,e.kind,s.level FROM music_selections s JOIN music_entries e ON e.id=s.entry_id
    WHERE s.profile_id=? ORDER BY s.position`).all(profile.id) as z.infer<typeof MemberMusicProfile>['selections'];
  return { ...profile, selections };
}
export function registerMusicContact(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/me/music/contact', async request => musicContact(db, security.scopedMember(request).id));
  app.put('/api/v2/me/music/contact', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => db.transaction(() => {
    const member = security.memberWrite(request); const input = SaveMusicContact.parse(request.body);
    const key = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:PUT:/api/v2/me/music/contact:' + JSON.stringify(input));
    const previous = db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(member.id, key) as { signature: string; response_json: string; response_status: number } | undefined;
    if (previous) {
      if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
      reply.code(previous.response_status); return JSON.parse(previous.response_json) as Contact;
    }
    const before = musicContact(db, member.id);
    const epoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(member.id) as { epoch: number } | undefined)?.epoch ?? 0;
    if (input.profileId !== before.profileId || input.musicEpoch !== epoch) throw new DomainError('PROFILE_ERASED', '成分已刪除或重建，請重新開啟目前成分', 409);
    if (input.revision !== before.revision) throw new DomainError('CONTACT_CHANGED', '聯絡 QQ 已變更；請核對目前資料後再保存', 409);
    if (input.contactQQ !== before.contactQQ && before.source === 'legacy') throw new DomainError('LEGACY_CONTACT_FIXED', '舊成分的 QQ 是原資料查詢標識，更正請聯絡管理員', 409);
    const duplicate = input.contactQQ && db.prepare(`SELECT 1 FROM music_profile_contacts WHERE contact_qq=? AND profile_id!=?
      UNION ALL SELECT 1 FROM music_legacy_identity i WHERE i.table_name='profile_contacts' AND json_extract(i.payload_json,'$.number')=?
      AND NOT EXISTS(SELECT 1 FROM music_legacy_profiles l WHERE l.legacy_key=json_extract(i.payload_json,'$.qq')) LIMIT 1`).get(input.contactQQ, before.profileId, input.contactQQ);
    if (duplicate) throw new DomainError('CONTACT_IN_USE', '此 QQ 已有成分資料，請找回原成分或聯絡管理員核對', 409);
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
  app.post('/api/v2/music/profiles/lookup', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const viewer = security.memberWrite(request);
    if (!getProfile(db, viewer.id)) throw new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好成分', 403);
    return memberProfile(db, LookupMusicProfile.parse(request.body).query);
  });
  app.get('/api/v2/music/profiles/:id', async request => {
    const viewer = security.scopedMember(request);
    if (!getProfile(db, viewer.id)) throw new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好成分', 403);
    const { id } = z.object({ id: z.string().regex(/^m_[a-f0-9]{24,40}$/) }).parse(request.params);
    return memberProfile(db, id);
  });
}
