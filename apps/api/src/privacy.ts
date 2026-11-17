import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eraseLegacyProfile, detachLegacyAccount, type DB } from '@qgroup/database';
import { EraseData, ErasureProof, type ErasureResult } from '@qgroup/contracts';
import { z } from 'zod';
import { DomainError } from '@qgroup/domain';
import { getProfile } from './repositories';
import type { Security } from './security';
import { hash } from './security';
import { erasureJournal, type ErasureJournal, type ErasureIntent, type StoredIntent } from './erasure-journal';
import { prunePrivateImages } from './privacy-assets';
import { clearMusicClaims } from './music-claim-state';

type Result = z.infer<typeof ErasureResult>;
const sharedChecks: Record<string, string[]> = {
  music_catalog_actions: ['actor_id'],
  events: ['owner_id'], registrations: ['user_id'], roster_parties: ['manager_id'], attendees: ['user_id', 'manager_id'],
  event_audit: ['actor_id'], attendee_consents: ['actor_id'], event_roles: ['user_id'], management_invitations: ['recipient_id', 'initiator_id', 'accepted_by'],
  settlement_history: ['actor_id'], finance_reports: ['reporter_id'], finance_report_actions: ['actor_id'], finance_entries: ['actor_id'],
  attendee_claims: ['issuer_id', 'requester_id'], attendee_payment_origins: ['payer_user_id'], time_polls: ['owner_id'], time_poll_history: ['actor_id'],
  // New account/music audit may also contain historical names and ownership. Do not claim these were erased.
  account_audit: ['user_id'], admin_role_history: ['user_id'], music_profile_audit: ['actor_id'], music_contact_history: ['actor_id'], music_field_history: ['actor_id'], bot_outbox: ['recipient_user_id'],
};
export function sharedRecords(db: DB, userId: string) {
  const retained = Object.fromEntries(Object.entries(sharedChecks).flatMap(([table, columns]) => {
    const count = (db.prepare(`SELECT count(*) n FROM ${table} WHERE ${columns.map(column => `${column}=?`).join(' OR ')}`).get(...columns.map(() => userId)) as { n: number }).n;
    return count ? [[table, count]] : [];
  }));
  const legacyHistory = (db.prepare("SELECT count(*) n FROM music_legacy_identity WHERE table_name='link_audit' AND (json_extract(payload_json,'$.before_user_id')=? OR json_extract(payload_json,'$.after_user_id')=? OR json_extract(payload_json,'$.actor')=?)").get(userId, userId, 'account:' + userId) as { n: number }).n;
  if (legacyHistory) retained.music_ownership_history = legacyHistory;
  const ownershipHistory = (db.prepare("SELECT count(*) n FROM music_ownership_history WHERE before_user_id=? OR after_user_id=? OR actor_ref=?").get(userId, userId, 'account:' + userId) as { n: number }).n;
  if (ownershipHistory) retained.music_ownership_history = (retained.music_ownership_history ?? 0) + ownershipHistory;
  const pinHistory = (db.prepare('SELECT count(*) n FROM music_pin_history WHERE user_id=? OR actor_ref=?').get(userId, 'account:' + userId) as { n: number }).n;
  if (pinHistory) retained.music_pin_history = pinHistory;
  return retained;
}
function activeWork(db: DB, userId: string) {
  const activeEvents = (db.prepare("SELECT count(*) n FROM events WHERE owner_id=? AND lifecycle NOT IN ('ended','cancelled') AND status!='deleted' AND archived_at IS NULL").get(userId) as { n: number }).n;
  const activePolls = (db.prepare("SELECT count(*) n FROM time_polls WHERE owner_id=? AND status IN ('open','closed')").get(userId) as { n: number }).n;
  return { activeEvents, activePolls };
}
function eraseMusic(db: DB, profileId: string, userId: string, createdAt: string) {
  if (db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) db.prepare('INSERT INTO music_account_epochs VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1').run(userId);
  // Keep an ID-only tombstone, including when replay precedes an older profile snapshot.
  db.prepare(`INSERT INTO music_profiles(id,user_id,revision,updated_at,erased_at) VALUES(?,NULL,0,?,?)
    ON CONFLICT(id) DO UPDATE SET user_id=NULL,erased_at=excluded.erased_at`).run(profileId, createdAt, createdAt);
  eraseLegacyProfile(db, profileId, createdAt);
  db.prepare('DELETE FROM music_claim_intents WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_profile_contacts WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_contact_history WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_ownership_history WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_pin_history WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_field_history WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_profile_fields WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(profileId);
  db.prepare('DELETE FROM music_profile_audit WHERE profile_id=?').run(profileId);
  db.prepare(`UPDATE request_results SET response_status=410,response_json=? WHERE (user_id,request_key) IN
    (SELECT user_id,request_key FROM music_profile_receipts WHERE profile_id=?)`).run(JSON.stringify({ code: 'PROFILE_ERASED', message: '這份成分已刪除，原保存操作不會重建資料' }), profileId);
}
function closeAccount(db: DB, userId: string, requestId: string, createdAt: string): Result['status'] {
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return 'completed';
  const existing = db.prepare('SELECT status FROM privacy_requests WHERE user_id=?').get(userId) as { status: Result['status'] } | undefined;
  if (existing) return existing.status === 'completed' ? 'completed' : 'shared_review';
  const role = db.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').get(userId) as { revision: number } | undefined;
  if (role) {
    db.prepare('UPDATE user_admin_roles SET is_admin=0,revision=revision+1,updated_at=? WHERE user_id=?').run(createdAt, userId);
    db.prepare("INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,'account_closure',1,0,?,?)").run(userId, role.revision + 1, createdAt);
  }
  db.prepare("UPDATE time_polls SET vote_revision=vote_revision+1 WHERE status IN ('open','closed') AND id IN (SELECT poll_id FROM time_poll_ballots WHERE user_id=?)").run(userId);
  db.prepare('DELETE FROM time_poll_votes WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM time_poll_ballots WHERE user_id=?').run(userId);
  db.prepare(`DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(SELECT 1 FROM external_identities x WHERE x.user_id=? AND x.provider='qq'
    AND x.client_id=login_attempts.app_id AND x.subject=login_attempts.openid)`).run(userId);
  const sessions = db.prepare('SELECT token_hash FROM browser_sessions WHERE user_id=?').all(userId) as { token_hash: string }[];
  for (const { token_hash: token } of sessions) {
    clearMusicClaims(db, token);
    for (const table of ['login_attempts', 'auth_requests', 'browser_accounts', 'browser_sessions', 'visitor_sessions']) db.prepare(`DELETE FROM ${table} WHERE token_hash=?`).run(token);
  }
  db.prepare('DELETE FROM browser_accounts WHERE user_id=?').run(userId);
  for (const table of ['external_profiles', 'external_identities', 'qq_accounts', 'qq_attempts', 'login_attempts', 'privacy_consents', 'user_payment_codes', 'notifications', 'request_results', 'device_links', 'admin_user_metadata']) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  db.exec(`DELETE FROM image_assets WHERE NOT EXISTS(SELECT 1 FROM user_payment_codes WHERE digest=image_assets.digest)
    AND NOT EXISTS(SELECT 1 FROM settlement_code_images WHERE digest=image_assets.digest)
    AND NOT EXISTS(SELECT 1 FROM settlement_receipt_images WHERE digest=image_assets.digest)`);
  db.prepare('DELETE FROM event_access WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM music_claim_intents WHERE target_user_id=?').run(userId);
  db.prepare("UPDATE music_legacy_profiles SET ownership_source='closed_account' WHERE profile_id IN (SELECT id FROM music_profiles WHERE user_id=?)").run(userId);
  db.prepare('UPDATE music_profiles SET user_id=NULL WHERE user_id=?').run(userId);
  db.prepare("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=?").run(randomBytes(32).toString('hex'), userId);
  detachLegacyAccount(db, userId);
  const status = Object.keys(sharedRecords(db, userId)).length ? 'shared_review' : 'completed';
  db.prepare('INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(requestId, userId, status, createdAt, createdAt);
  return status;
}
export function createPrivacy(db: DB, journal: ErasureJournal = erasureJournal(db)) {
  let recoveryRequired = false;
  let journalFailed = false;
  function apply(entry: StoredIntent) {
    const legacy = 'user_id' in entry;
    const requestId = legacy ? entry.request_id : entry.requestId;
    if (db.prepare('SELECT 1 FROM erasure_applied WHERE request_id=?').get(requestId)) {
      if (!legacy) {
        const receipt = db.prepare('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?').get(requestId) as { signature: string; secret_hash: string } | undefined;
        if (receipt?.signature !== entry.signature || receipt.secret_hash !== entry.secretHash) throw new Error('Conflicting erasure journal intent');
      }
      return;
    }
    let status: Result['status'] = 'completed';
    if (!legacy && entry.kind !== 'account' && entry.profileId) eraseMusic(db, entry.profileId, entry.userId, entry.createdAt);
    if (legacy || entry.kind !== 'music') status = closeAccount(db, legacy ? entry.user_id : entry.userId, requestId, legacy ? entry.created_at : entry.createdAt);
    if (!legacy) {
      const result: Result = { requestId, target: entry.kind, status };
      db.prepare('INSERT INTO privacy_receipts VALUES(?,?,?,?)').run(requestId, entry.secretHash, entry.signature, JSON.stringify(result));
    }
    db.prepare('INSERT INTO erasure_applied VALUES(?)').run(requestId);
  }
  function recover() {
    if (journalFailed) throw new Error('Erasure journal durability failed; restart and verify the ledger');
    db.transaction(() => { for (const entry of journal.read()) apply(entry); }).immediate();
    prunePrivateImages(db);
    recoveryRequired = false;
  }
  recover(); // Fail closed before any routes are registered or sockets are opened.
  return {
    guard() {
      if (journalFailed || recoveryRequired) {
        try { recover(); } catch { throw new DomainError('ERASURE_RECOVERY_REQUIRED', '資料刪除仍待恢復，暫停操作；請稍後重試', 503); }
      }
    },
    receipt(requestId: string, secret: string) {
      const row = db.prepare('SELECT secret_hash,result_json FROM privacy_receipts WHERE request_id=?').get(requestId) as { secret_hash: string; result_json: string } | undefined;
      const candidate = Buffer.from(hash(secret), 'hex');
      if (!row || !timingSafeEqual(candidate, Buffer.from(row.secret_hash, 'hex'))) throw new DomainError('RECEIPT_NOT_FOUND', '尚未找到此操作的結果；請回原帳號確認後重試', 404);
      return JSON.parse(row.result_json) as Result;
    },
    submit(entry: ErasureIntent) {
      const existing = db.prepare('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?').get(entry.requestId) as { signature: string; secret_hash: string } | undefined;
      if (existing) {
        if (existing.signature !== entry.signature || existing.secret_hash !== entry.secretHash) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
        return;
      }
      recoveryRequired = true;
      try { journal.append(entry); } catch (error) { journalFailed = true; throw error; }
      apply(entry);
      // The outer write transaction must commit before clearing the recovery flag.
    },
  };
}
export type PrivacyService = ReturnType<typeof createPrivacy>;
export function registerPrivacy(app: FastifyInstance, db: DB, security: Security, now: () => Date, privacy: PrivacyService) {
  app.get('/api/v2/me/privacy', async request => {
    const device = security.scopedMember(request);
    return { profile: getProfile(db, device.id), ...activeWork(db, device.id) };
  });
  app.post('/api/v2/privacy/receipt', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    // Possession of a random 256-bit receipt secret proves access even after login revocation.
    // The secret is sent only in a JSON body, never a URL or log.
    const proof = ErasureProof.parse(request.body);
    return privacy.receipt(proof.requestId, proof.secret);
  });
  app.post('/api/v2/me/privacy/erase', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const input = EraseData.parse(request.body);
    db.transaction(() => {
      const device = security.memberWrite(request);
      const signature = hash('v2:privacy:' + device.id + ':' + JSON.stringify(input));
      const previous = db.prepare('SELECT signature FROM privacy_receipts WHERE request_id=?').get(input.requestId) as { signature: string } | undefined;
      if (previous) {
        if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
        return;
      }
      const profile = getProfile(db, device.id);
      if ((profile?.id ?? null) !== input.profileId || (profile?.revision ?? 0) !== input.profileRevision) throw new DomainError('PROFILE_CHANGED', '成分已變更，請重新讀取並核對刪除範圍', 409);
      if (input.target !== 'account' && !profile) throw new DomainError('NO_PROFILE', '目前沒有可刪除的成分', 409);
      if (input.target !== 'music') {
        const active = activeWork(db, device.id);
        if (active.activePolls) throw new DomainError('ACTIVE_POLLS', '請先定案或取消仍由你管理的時間投票，再關閉帳號', 409);
        if (active.activeEvents) throw new DomainError('ACTIVE_EVENTS', '請先轉交、結束或取消仍由你管理的活動，再關閉帳號', 409);
      }
      privacy.submit({ version: 1, kind: input.target, userId: device.id, profileId: input.profileId, requestId: input.requestId, secretHash: hash(input.secret), signature, createdAt: now().toISOString() });
    }).immediate();
    privacy.guard(); // Finish committed image pruning before acknowledging completion.
    return privacy.receipt(input.requestId, input.secret);
  });
}
