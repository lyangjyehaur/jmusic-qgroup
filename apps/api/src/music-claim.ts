import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { ConfirmMusicClaim, StartMusicClaim, type MusicClaimStatus } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { getProfile } from './repositories';
import { hash, type Device, type Security } from './security';
import { clearMusicClaims } from './music-claim-state';
import { invalidateMusicOwnership } from './music-ownership';

interface Intent { id: string; current_token_hash: string; target_user_id: string | null; profile_id: string; profile_revision: number; pin_proof: string; input_digest: string; music_epoch: number | null; stage: 'pending' | 'authorized' | 'completed'; attempt_id: string | null; app_id: string; subject: string; expires_at: string; created_at: string }
interface Legacy { id: string; user_id: string | null; revision: number; name: string; legacy_key: string; pin_hash: string }
const unavailable = () => new DomainError('CLAIM_UNAVAILABLE', '找回請求已失效、成分已變更或已有關聯；請重新找回或聯絡管理員', 409);
const uid = (device: Device) => device.kind === 'member' ? device.id : null;
export function createMusicClaims(db: DB, now: () => Date) {
  const epoch = (id: string) => (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(id) as { epoch: number } | undefined)?.epoch ?? 0;
  const legacy = (id: string) => db.prepare(`SELECT p.id,p.user_id,p.revision,COALESCE(NULLIF(f.name,''),l.name) AS name,l.legacy_key,l.pin_hash FROM music_profiles p JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN music_profile_fields f ON f.profile_id=p.id
    WHERE p.id=? AND p.erased_at IS NULL`).get(id) as Legacy | undefined;
  function current(device: Device, id?: string): Intent | undefined {
    return db.prepare(`SELECT * FROM music_claim_intents WHERE current_token_hash=? AND target_user_id IS ? ${id ? 'AND id=?' : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(device.tokenHash, uid(device), ...(id ? [id] : [])) as Intent | undefined;
  }
  function valid(row: Intent) {
    const profile = legacy(row.profile_id);
    if (row.expires_at <= now().toISOString() || !profile || profile.user_id || profile.revision !== row.profile_revision || hash('music-claim-pin:' + profile.pin_hash) !== row.pin_proof) throw unavailable();
    if (row.target_user_id && (getProfile(db, row.target_user_id) || epoch(row.target_user_id) !== row.music_epoch || db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(row.target_user_id))) throw unavailable();
    return profile;
  }
  function charge(qq: string, ip: string) {
    // Commit separately: wrong PIN and later business conflicts still consume attempts.
    db.transaction(() => {
      const seconds = now().getTime() / 1000;
      db.prepare('DELETE FROM music_claim_attempts WHERE created<?').run(seconds - 3600);
      const buckets = [['qq:' + hash(qq), 8, 3600], ['ip:' + hash(ip), 30, 900]] as const;
      for (const [bucket, limit, window] of buckets) {
        const count = (db.prepare('SELECT count(*) n FROM music_claim_attempts WHERE bucket=? AND created>?').get(bucket, seconds - window) as { n: number }).n;
        if (count >= limit) throw new DomainError('PIN_RATE_LIMIT', '找回嘗試過多，請稍後重試或聯絡管理員', 429);
      }
      for (const [bucket] of buckets) db.prepare('INSERT INTO music_claim_attempts VALUES(?,?)').run(bucket, seconds);
    }).immediate();
  }
  function start(device: Device, input: z.infer<typeof StartMusicClaim>) {
    return db.transaction(() => {
      const signature = hash('music-claim:' + input.legacyQQ + ':' + hash(input.pin));
      const prior = db.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(input.requestId) as Intent | undefined;
      if (prior) {
        if (prior.current_token_hash !== device.tokenHash || prior.target_user_id !== uid(device) || prior.input_digest !== signature) throw new DomainError('REQUEST_CONFLICT', '這個找回操作編號已用於另一份內容', 409);
        if (prior.stage !== 'completed') valid(prior);
        return status(device, prior.id);
      }
      const profile = db.prepare(`SELECT p.id,p.user_id,p.revision,COALESCE(NULLIF(f.name,''),l.name) AS name,l.legacy_key,l.pin_hash FROM music_legacy_profiles l JOIN music_profiles p ON p.id=l.profile_id LEFT JOIN music_profile_fields f ON f.profile_id=p.id WHERE l.legacy_key=? AND p.erased_at IS NULL`).get(input.legacyQQ) as Legacy | undefined;
      const expected = profile?.pin_hash ?? '';
      if (!/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(hash('jpm-pin|' + input.pin), 'hex'), Buffer.from(expected, 'hex'))) throw new DomainError('PIN_INVALID', '舊帳號或口令不正確；忘記口令請聯絡管理員', 403);
      if (!profile || profile.user_id) throw new DomainError('PROFILE_LINKED', '此成分已關聯帳號，請使用對應帳號登入；無法登入請聯絡管理員', 409);
      if (device.kind === 'member' && getProfile(db, device.id)) throw new DomainError('PROFILE_EXISTS', '目前帳號已有成分，請聯絡管理員核對；原資料不會覆蓋', 409);
      clearMusicClaims(db, device.tokenHash);
      db.prepare(`INSERT INTO music_claim_intents(id,current_token_hash,target_user_id,profile_id,profile_revision,pin_proof,input_digest,music_epoch,stage,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`).run(input.requestId, device.tokenHash, uid(device), profile.id, profile.revision, hash('music-claim-pin:' + expected), signature, device.kind === 'member' ? epoch(device.id) : null, new Date(now().getTime() + 600000).toISOString(), now().toISOString());
      return status(device, input.requestId);
    }).immediate();
  }
  function status(device: Device, id?: string): z.infer<typeof MusicClaimStatus> {
    const row = current(device, id); if (!row) return { status: 'none' };
    const profile = legacy(row.profile_id);
    let stage: 'unavailable' | Intent['stage'] = row.stage;
    if (row.stage === 'completed') { if (!profile || profile.user_id !== uid(device)) stage = 'unavailable'; }
    else try { valid(row); } catch { stage = 'unavailable'; }
    return { status: stage, claimId: row.id, expiresAt: row.expires_at, profileId: row.profile_id, name: profile?.name ?? '', legacyQQ: profile?.legacy_key ?? '', targetNickname: device.kind === 'member' ? device.nickname : '' };
  }
  function attach(device: Device, id: string, attemptId: string, mode: string) {
    const row = current(device, id); if (!row || row.stage === 'completed') throw unavailable(); valid(row);
    if (mode !== (device.kind === 'member' ? 'bind' : 'login')) throw new DomainError('CLAIM_AUTH_MODE', '請授權目前帳號；找回過程不切換到其他帳號', 409);
    db.prepare("UPDATE music_claim_intents SET stage='pending',attempt_id=?,app_id='',subject='' WHERE id=?").run(attemptId, row.id);
  }
  function forAttempt(device: Device, attemptId: string, userId: string): Intent | undefined {
    const row = db.prepare('SELECT * FROM music_claim_intents WHERE current_token_hash=? AND attempt_id=?').get(device.tokenHash, attemptId) as Intent | undefined;
    if (!row) return;
    valid(row);
    if (row.target_user_id && row.target_user_id !== userId || getProfile(db, userId) || db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(userId)) throw unavailable();
    return row;
  }
  function authorize(row: Intent, tokenHash: string, userId: string, appId: string, subject: string) {
    db.prepare("UPDATE music_claim_intents SET current_token_hash=?,target_user_id=?,music_epoch=?,stage='authorized',app_id=?,subject=? WHERE id=?")
      .run(tokenHash, userId, epoch(userId), appId, subject, row.id);
  }
  function finish(device: Extract<Device, { kind: 'member' }>, id: string) {
    const row = current(device, id); if (!row) throw unavailable();
    if (row.stage === 'completed') return status(device, id);
    const profile = valid(row);
    if (row.stage !== 'authorized' || !row.attempt_id || !db.prepare(`SELECT 1 FROM login_attempts a JOIN external_identities e ON e.provider='qq' AND e.client_id=a.app_id AND e.subject=a.openid
      WHERE a.id=? AND a.status='used' AND a.app_id=? AND a.openid=? AND e.user_id=?`).get(row.attempt_id, row.app_id, row.subject, device.id)) throw new DomainError('CLAIM_OAUTH_REQUIRED', '請完成本次 QQ 授權，再確認關聯', 409);
    const stamp = now().toISOString();
    db.prepare('UPDATE music_profiles SET user_id=?,revision=revision+1,updated_at=? WHERE id=?').run(device.id, stamp, profile.id);
    db.prepare("UPDATE music_legacy_profiles SET ownership_source='oauth' WHERE profile_id=?").run(profile.id);
    invalidateMusicOwnership(db, profile.id, [device.id], row.id);
    db.prepare('INSERT INTO music_profile_audit(profile_id,revision,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(profile.id, profile.revision + 1, device.id, JSON.stringify({ userId: null, action: 'legacy_claim' }), JSON.stringify({ userId: device.id, action: 'legacy_claim' }), stamp);
    db.prepare("INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,'music_claimed',?,?)").run(device.id, JSON.stringify({ profileId: profile.id }), stamp);
    // A different browser's outstanding proof can no longer act on this profile.
    db.prepare('DELETE FROM music_claim_intents WHERE profile_id=? AND id!=?').run(profile.id, row.id);
    db.prepare("UPDATE music_claim_intents SET stage='completed',pin_proof='',input_digest='' WHERE id=?").run(row.id);
    return status(device, id);
  }
  function cancel(device: Device, id: string) {
    const row = current(device, id);
    if (row?.stage === 'completed') return status(device, id);
    if (row?.attempt_id) db.prepare("UPDATE login_attempts SET status='failed',union_id='' WHERE id=? AND status IN ('pending','exchanging','verified')").run(row.attempt_id);
    db.prepare("DELETE FROM music_claim_intents WHERE current_token_hash=? AND id=? AND stage!='completed'").run(device.tokenHash, id);
    return { status: 'none' as const };
  }
  return { charge, start, status, attach, forAttempt, authorize, finish, cancel };
}
export type MusicClaims = ReturnType<typeof createMusicClaims>;
export function registerMusicClaims(app: FastifyInstance, db: DB, security: Security, claims: MusicClaims) {
  app.get('/api/v2/music/claim', async request => {const device=security.scoped(request),query=z.object({requestId:z.string().uuid().optional()}).strict().parse(request.query);return claims.status(device,query.requestId);});
  app.post('/api/v2/music/claim/start', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async request => {
    security.write(request); const input = StartMusicClaim.parse(request.body); claims.charge(input.legacyQQ, request.ip);
    return claims.start(security.write(request), input);
  });
  app.post('/api/v2/music/claim/finish', async request => db.transaction(() => {
    const device = security.memberWrite(request); const input = ConfirmMusicClaim.parse(request.body); return claims.finish(device, input.claimId);
  }).immediate());
  app.post('/api/v2/music/claim/cancel', async request => db.transaction(() => {
    const device = security.write(request); const input = ConfirmMusicClaim.parse(request.body); return claims.cancel(device, input.claimId);
  }).immediate());
}
