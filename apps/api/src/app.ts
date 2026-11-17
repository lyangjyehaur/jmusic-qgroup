import { registerAppearance } from './appearance';
import { registerAdminBackups } from './admin-backups';
import { createPairedBackups } from './paired-backups';
import { erasureJournal as defaultErasureJournal } from './erasure-journal';
import { registerAdminMusicErasure } from './admin-music-erasure';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { SaveProfile } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { catalog, getActivity, getProfile, listActivities, saveProfile } from './repositories';

import { createSecurity, hash } from './security';
import { registerAuth } from './auth';
import { registerAccountDevices } from './account-devices';
import { registerRegistrationSettings } from './registration-settings';
import { registerAccountProfile } from './account-profile';
import { createPrivacy, registerPrivacy } from './privacy';
import type { ErasureJournal } from './erasure-journal';
import { createAdminSecurity } from './admin-security';
import { registerAdminUsers } from './admin-users';
import { registerAdminPrivacy } from './admin-privacy';
import { registerAdminMusic } from './admin-music';
import { registerAdminMusicPins } from './admin-music-pins';
import { registerMusicMatches } from './music-matches';
import { registerMusicShouts } from './music-shouts';
import { registerMusicCircles } from './music-circles';
import { registerMusicTrend, startMusicTrendSampler } from './music-trend';
import { registerMusicContact } from './music-contact';
import { registerMusicFields } from './music-fields';
import { activityViewer, registerActivityRoster } from './activity-roster';
import { registerActivityDrafts } from './activity-drafts';
import { registerActivityManagement } from './activity-management';
import { registerActivityLifecycle } from './activity-lifecycle';
import { registerActivityRegistration } from './activity-registration';
import { registerActivityInvitations } from './activity-invitations';
import { registerActivityClaims } from './activity-claims';
import { registerFinance } from './finance';
import { registerActivityRooms } from './activity-room-overview';
import { registerMusicCatalog } from './music-catalog';
import { registerAdminMusicCatalog } from './admin-music-catalog';
import { registerTimePolls } from './time-polls';
import { registerSettlements } from './settlements';
import { registerPaymentAssets } from './payment-codes';
import { registerInbox } from './inbox';
import { registerActivityHistory } from './activity-history';
import { registerActivityAttendance } from './activity-attendance';
import { registerActivityDelegation } from './activity-delegation';
import type { ActivityBotDefaults } from './activity-bot';
import { createMusicClaims, registerMusicClaims } from './music-claim';
import type { QQProvider } from './qq-provider';
import { redactRequestURL } from './request-log';
export { hash, accountScope } from './security';
export interface AppOptions { db: DB; origin: string; now?: () => Date; csrfSecret?: string; staticRoot?: string; logger?: boolean; qq?: QQProvider; botEnabledDefault?: boolean; activityBot?: ActivityBotDefaults; erasureJournal?: ErasureJournal; adminCredentialHash?: () => string; musicTrendSampling?: boolean; pairedBackupScheduling?: boolean }
export function createApp(options: AppOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.origin).origin;
  const security = createSecurity(db, origin, now, options.csrfSecret);
  const journal = options.erasureJournal ?? defaultErasureJournal(db);
  const privacy = createPrivacy(db, journal);
  const backups = createPairedBackups(db, journal, now);
  const backedUp = new WeakSet<object>();
  const admin = createAdminSecurity(db, security, origin, now, options.adminCredentialHash, request => {
    if (!backups || backedUp.has(request)) return;
    try { backups.capture(); backups.prune(); backedUp.add(request); }
    catch { throw new DomainError('BACKUP_REQUIRED', '操作尚未執行：無法完成配對備份，請維運人員檢查儲存空間、圖片與刪除紀錄', 503); }
  });
  const musicClaims = createMusicClaims(db, now);
  const app = Fastify({ logger: options.logger ? { serializers: { req(request) { return { method: request.method, url: redactRequestURL(request.url), remoteAddress: request.ip }; } }, redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: 32768, trustProxy: false });
  app.register(cookie);
  app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https://qlogo.cn', 'https://*.qlogo.cn'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } } });
  app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  if (backups && options.pairedBackupScheduling !== false) {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => { try { privacy.guard(); const last = backups.list()[0]; if (!last || now().getTime() - Date.parse(last.createdAt) >= 3600000) backups.capture(); backups.prune(); } catch (error) { app.log.error(error, 'Paired backup failed'); } };
    app.addHook('onReady', async () => { tick(); timer = setInterval(tick, 3600000); timer.unref(); });
    app.addHook('onClose', async () => { clearInterval(timer); });
  }
  if (options.musicTrendSampling) {
    let stop: (() => void) | undefined;
    app.addHook('onReady', async () => { stop = startMusicTrendSampler(db, now, error => app.log.error(error, 'Music trend sampling failed')); });
    app.addHook('onClose', async () => { stop?.(); });
  }
  // Register routes after plugins so their onRoute hooks enforce per-route limits.
  app.register(async function routes(app) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
      privacy.guard();
    });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, message: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_INPUT', message: '輸入格式不符，請檢查欄位與確認項目' });
      if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ code: 'INVALID_REQUEST', message: error.statusCode === 429 ? '操作太頻繁，請稍後再試' : '請求格式不符' });
      request.log.error(error);
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '暫時無法完成操作，請保留選擇後重試' });
    });
    app.get('/api/v2/health', async () => ({ ok: true, project: 'qgroup-unified-rebuild', schema: REBUILD_SCHEMA_VERSION }));
    registerAuth(app, db, security, now, options.qq, musicClaims);
    registerMusicClaims(app, db, security, musicClaims);
    registerAccountDevices(app, db, security, now);
    registerRegistrationSettings(app, db, admin, now);
    registerAdminUsers(app, db, admin, now);
    registerAppearance(app, db, admin, now);
    registerAdminBackups(app, db, admin, journal, backups, now);
    registerAdminPrivacy(app, db, admin, now);
    registerAdminMusic(app, db, admin, now);
    registerAdminMusicPins(app, db, admin, now);
    registerAdminMusicErasure(app, db, admin, now, privacy);
    registerAccountProfile(app, db, security, now, options.botEnabledDefault);
    registerPrivacy(app, db, security, now, privacy);
    registerMusicContact(app, db, security, now);
    registerMusicMatches(app, db, security);
    registerMusicCircles(app, db, security);
    registerMusicShouts(app, db, security, admin, now);
    registerMusicTrend(app, db, security, now);
    registerMusicFields(app, db, security, now);
    registerActivityRoster(app, db, security, options.qq?.clientId);
    registerActivityDrafts(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityManagement(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityLifecycle(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityRegistration(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityInvitations(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityClaims(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityDelegation(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerFinance(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerPaymentAssets(app, db, security, now);
    registerSettlements(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerTimePolls(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerActivityRooms(app, db, security);
    registerMusicCatalog(app, db, security, now);
    registerAdminMusicCatalog(app, db, admin, now);
    registerInbox(app, db, security, now);
    registerActivityHistory(app, db, security);
    registerActivityAttendance(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    app.get('/api/v2/activities', async request => {
      const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), period: z.enum(['upcoming', 'history']).default('upcoming') }).strict().parse(request.query);
      return listActivities(db, query.page, query.period, now());
    });
    app.get('/api/v2/activities/:id', async request => {
      const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
      return db.transaction(()=>getActivity(db, id, now(), activityViewer(security, request)))();
    });
    app.get('/api/v2/music/entries', async () => ({ entries: catalog(db) }));
    app.get('/api/v2/me/music', async request => getProfile(db, security.scopedMember(request).id));
    app.put('/api/v2/me/music', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const viewer = security.memberWrite(request);
      const input = SaveProfile.parse(request.body);
      const requestKey = z.string().uuid().parse(request.headers['idempotency-key']);
      const signature = hash('v2:PUT:/api/v2/me/music:' + JSON.stringify(input));
      return db.transaction(() => {
        // Revalidate inside the write transaction; revoked/switched sessions cannot replay results.
        const current = security.memberWrite(request);
        if (current.id !== viewer.id) throw new DomainError('ACCOUNT_CHANGED', '帳號已變更', 409);
        const previous = db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(viewer.id, requestKey) as { signature: string; response_json: string; response_status: number } | undefined;
        if (previous) {
          if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
          reply.code(previous.response_status);
          return JSON.parse(previous.response_json) as ReturnType<typeof saveProfile>;
        }
        const result = saveProfile(db, viewer.id, input, now());
        db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(viewer.id, requestKey, signature, JSON.stringify(result), 200, now().toISOString());
        db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(viewer.id, requestKey, result.id);
        return result;
      }).immediate();
    });
    if (options.staticRoot) {
      app.register(staticFiles, { root: options.staticRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.method !== 'GET' || request.url.startsWith('/api/') || request.url.split('?')[0]!.includes('.')) return reply.code(404).send({ code: 'NOT_FOUND', message: '找不到此入口' });
        return reply.type('text/html').sendFile('index.html', { maxAge: 0 });
      });
    }
  });
  return app;
}
