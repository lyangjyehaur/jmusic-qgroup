import type { FastifyInstance } from 'fastify';
import { legacyMusicFields, type DB, type StoredMusicFields } from '@qgroup/database';
import { MusicFields, SaveMusicFields } from '@qgroup/contracts';
import { DomainError, musicNameKey, musicText } from '@qgroup/domain';
import { z } from 'zod';
import { getProfile } from './repositories';
import { hash, type Security } from './security';
type Fields = z.infer<typeof MusicFields>;
export const musicNameSQL = `COALESCE(NULLIF(f.name,''),NULLIF(l.name,''),u.nickname,'未命名成分')`;
export const musicNameJoins = `LEFT JOIN music_profile_fields f ON f.profile_id=p.id LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN users u ON u.id=p.user_id`;
export function profileFields(db: DB, profileId: string): Fields {
  const row = db.prepare(`SELECT p.id AS profileId,${musicNameSQL} AS name,f.note,f.note_at AS noteAt,f.gender,f.gender_public AS genderPublic,
    COALESCE(f.revision,0) AS revision,l.fields_json AS sourceFields FROM music_profiles p ${musicNameJoins} WHERE p.id=? AND p.erased_at IS NULL`).get(profileId) as Omit<Fields, 'genderPublic'> & { genderPublic: number | null; sourceFields: string | null } | undefined;
  if (!row) throw new DomainError('NO_PROFILE', '請先保存成分，再編輯成分資料', 404);
  if (row.genderPublic === null) {
    const fields = legacyMusicFields(row.name, row.sourceFields ?? '{}');
    return { profileId, revision: 0, ...fields };
  }
  return { profileId, name: row.name, note: row.note, noteAt: row.noteAt, gender: row.gender, genderPublic: !!row.genderPublic, revision: row.revision };
}
function mine(db: DB, userId: string) {
  const profile = getProfile(db, userId); if (!profile) throw new DomainError('NO_PROFILE', '請先保存成分，再編輯成分資料', 404);
  return profileFields(db, profile.id);
}
function normalize(input: z.infer<typeof SaveMusicFields>, before: Fields): StoredMusicFields {
  const name = input.name === before.name ? before.name : musicText(input.name);
  if (input.name !== before.name && (!musicNameKey(name) || Array.from(name).length > 16 || /[\x00-\x1f\x7f]/.test(name))) throw new DomainError('MUSIC_NAME_INVALID', '成分稱呼須為 1–16 字，不可包含控制字元');
  const note = input.note === before.note ? before.note : musicText(input.note);
  if (input.note !== before.note && Array.from(note).length > 140) throw new DomainError('MUSIC_NOTE_INVALID', '私人留言最多 140 字，可留空清除');
  const rawGender = musicText(input.gender); const lower = rawGender.toLowerCase();
  const gender = input.gender === before.gender ? before.gender : ['', 'female', 'male'].includes(lower) ? lower : rawGender;
  if (input.gender !== before.gender && (Array.from(gender).length > 12 || /[\x00-\x1f\x7f<>]/.test(gender))) throw new DomainError('MUSIC_GENDER_INVALID', '自訂性別最多 12 字，不可包含控制字元或尖括號');
  return { name, note, noteAt: before.noteAt, gender, genderPublic: input.gender === before.gender && input.genderPublic === before.genderPublic ? before.genderPublic : !!gender && input.genderPublic };
}
export function registerMusicFields(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/me/music/fields', async request => mine(db, security.scopedMember(request).id));
  app.put('/api/v2/me/music/fields', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => db.transaction(() => {
    const member = security.memberWrite(request); const input = SaveMusicFields.parse(request.body); const key = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:PUT:/api/v2/me/music/fields:' + JSON.stringify(input));
    const previous = db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(member.id, key) as { signature: string; response_json: string; response_status: number } | undefined;
    if (previous) { if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409); reply.code(previous.response_status); return JSON.parse(previous.response_json) as Fields; }
    const before = mine(db, member.id); const epoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(member.id) as { epoch: number } | undefined)?.epoch ?? 0;
    if (input.profileId !== before.profileId || input.musicEpoch !== epoch) throw new DomainError('PROFILE_ERASED', '成分已刪除、重建或移交，請重新開啟目前成分', 409);
    if (input.revision !== before.revision) throw new DomainError('MUSIC_FIELDS_CHANGED', '成分資料已變更；輸入仍保留，請核對目前資料後再保存', 409);
    const next = normalize(input, before);
    if (next.name !== before.name) {
      const names = db.prepare(`SELECT ${musicNameSQL} AS name FROM music_profiles p ${musicNameJoins} WHERE p.erased_at IS NULL AND p.id!=?`).all(before.profileId) as { name: string }[];
      if (names.some(row => musicNameKey(row.name) === musicNameKey(next.name))) throw new DomainError('MUSIC_NAME_IN_USE', '此成分稱呼已被使用，請更換；如為你的舊成分，請先找回', 409);
    }
    const stamp = now().toISOString();
    if (next.name !== before.name || next.note !== before.note || next.gender !== before.gender || next.genderPublic !== before.genderPublic) {
      next.noteAt = next.note !== before.note ? next.note ? now().getTime() / 1000 : 0 : before.noteAt;
      db.prepare(`INSERT INTO music_profile_fields VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET name=excluded.name,note=excluded.note,note_at=excluded.note_at,gender=excluded.gender,gender_public=excluded.gender_public,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(before.profileId, next.name, next.note, next.noteAt, next.gender, Number(next.genderPublic), before.revision + 1, stamp);
      db.prepare('UPDATE music_profiles SET revision=revision+1,updated_at=? WHERE id=?').run(stamp, before.profileId);
      db.prepare('INSERT INTO music_field_history(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(before.profileId, before.revision + 1, member.id, JSON.stringify(before), JSON.stringify({ profileId: before.profileId, ...next, revision: before.revision + 1 }), stamp);
    }
    const result = mine(db, member.id);
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(member.id, key, signature, JSON.stringify(result), stamp);
    db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(member.id, key, before.profileId);
    return result;
  }).immediate());
}
