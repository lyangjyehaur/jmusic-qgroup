import { withApiError } from './error-display';
import { registerHttpResponseValidation } from './http-responses';
import { runtimeInfo } from '@qgroup/runtime';
import { clientAddress } from './client-address';
import { registerActivityAccess } from './activity-access';
import { registerAdminBot } from './admin-bot';
import { registerAdminOperations } from './admin-operations';
import { registerBotDeliveries } from './bot-deliveries';
import { registerMusicRooms } from './music-rooms';
import { registerAppearance } from './appearance';
import { registerLegacyLocal } from './legacy-local';
import { registerLegacyFinance } from './legacy-finance';
import { registerCreateIntents } from './create-intents';
import { registerAdminBackups } from './admin-backups';
import { createPairedBackups } from './paired-backups';
import { createLegacyMusicHistory, type LegacyHistoryConfig } from './legacy-music-history';
import { erasureJournal as defaultErasureJournal } from './erasure-journal';
import { registerAdminMusicErasure } from './admin-music-erasure';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { ActivitiesQuery,PageQuery, ANALYTICS_HOST, ANALYTICS_ORIGIN, displayLanguage } from '@qgroup/contracts';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { staticCacheControl } from './static-cache';
import { z } from 'zod';
import { assertDatabaseUsable, REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { SaveProfile } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { apiFailure } from './error-response';
import { catalog, getActivity, getProfile, listActivities, listMyActivities, saveProfile } from './repositories';

import { createSecurity, hash } from './security';
import { registerAuth } from './auth';
import { registerAccountDevices } from './account-devices';
import { registerRegistrationSettings } from './registration-settings';
import { registerAccountProfile } from './account-profile';
import { createPrivacy, registerPrivacy } from './privacy';
import { registerPrivacyConsent } from './privacy-consent';
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
import { registerPublicAPI } from './public-api';
export { hash, accountScope } from './security';
export interface AppOptions { db: DB; origin: string; now?: () => Date; csrfSecret?: string; staticRoot?: string; logger?: boolean; qq?: QQProvider; botEnabledDefault?: boolean; activityBot?: ActivityBotDefaults; erasureJournal?: ErasureJournal; adminCredentialHash?: () => string; publicAPIKeys?: () => string; musicTrendSampling?: boolean; pairedBackupScheduling?: boolean; legacyHistory?: import('zod').infer<typeof LegacyHistoryConfig>; runtimeInfo?:ReturnType<typeof runtimeInfo> }
export function createApp(options: AppOptions) {
  const { db } = options;
  assertDatabaseUsable(db);
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.origin).origin;
  const security = createSecurity(db, origin, now, options.csrfSecret);
  const journal = options.erasureJournal ?? defaultErasureJournal(db);
  const privacy = createPrivacy(db, journal);
  const backups = createPairedBackups(db, journal, now);
  const history = options.legacyHistory && createLegacyMusicHistory(db, options.legacyHistory);
  const backedUp = new WeakSet<object>();
  const admin = createAdminSecurity(db, security, origin, now, options.adminCredentialHash, request => {
    if (!backups || backedUp.has(request)) return;
    try { backups.capture(); backups.prune(); backedUp.add(request); }
    catch { throw withApiError(new DomainError('BACKUP_REQUIRED', '操作尚未執行：無法完成配對備份，請維運人員檢查儲存空間、圖片與刪除紀錄', 503)); }
  });
  const musicClaims = createMusicClaims(db, now);
  const app = Fastify({ logger: options.logger ? { serializers: { req(request) { return { method: request.method, url: redactRequestURL(request.url), remoteAddress: clientAddress(request) }; } }, redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: 32768, trustProxy: false });
  app.register(cookie);
  const analyticsHosts=origin===ANALYTICS_ORIGIN?[ANALYTICS_HOST]:[];
  app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'",...analyticsHosts], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https://qlogo.cn', 'https://*.qlogo.cn'], connectSrc: ["'self'",...analyticsHosts], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } } });
  // Only routes registered by the static plugin get this exemption. A URL
  // prefix or client header cannot exempt an API, shell or auth operation.
  app.addHook('onRoute',route=>{
    const config=route.config as typeof route.config & {rootPath?:unknown;file?:unknown};
    const methods=Array.isArray(route.method)?route.method:[route.method];
    if(options.staticRoot&&typeof config?.rootPath==='string'&&resolve(config.rootPath)===resolve(options.staticRoot)&&typeof config.file==='string'&&methods.every(method=>method==='GET'||method==='HEAD'))config.rateLimit=false;
  });
  app.register(rateLimit, { max: 180, timeWindow: '1 minute',keyGenerator:clientAddress });
  // Independent of browser sessions, write recovery hooks and browser errors.
  registerPublicAPI(app, db, now, options.publicAPIKeys ?? (() => process.env.KANBAN_PUBLIC_API_KEYS ?? ''), privacy.assertReadable);
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
    registerHttpResponseValidation(app);
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') || /^\/music\/api(?:[/?]|$)/.test(request.url) || request.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
      privacy.guard();
    });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) return reply.code(error.status).send(apiFailure(error));
      if (error instanceof z.ZodError) return reply.code(400).send(apiFailure(withApiError(new DomainError('INVALID_INPUT','輸入格式不符，請檢查欄位與確認項目'))));
      if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send(apiFailure(withApiError(new DomainError('INVALID_REQUEST',error.statusCode === 429 ? '操作太頻繁，請稍後再試' : '請求格式不符'))));
      request.log.error(error);
      return reply.code(500).send(apiFailure(withApiError(new DomainError('INTERNAL_ERROR','暫時無法完成操作，請保留選擇後重試'))));
    });
    const health=async()=>{try{if(!(db.prepare('SELECT 1 AS alive').get() as {alive:number}).alive)throw Error();return {ok:true,project:'qgroup-unified-rebuild',schema:REBUILD_SCHEMA_VERSION};}catch{throw withApiError(new DomainError('HEALTH_UNAVAILABLE','資料庫無法讀取',503));}};
    app.get('/api/v2/health',health);app.get('/api/health',health);
    app.get('/api/v2/version',async()=>options.runtimeInfo??runtimeInfo('web',{}));
    registerAuth(app, db, security, now, options.qq, musicClaims);
    registerMusicClaims(app, db, security, musicClaims);
    registerAccountDevices(app, db, security, now);
    registerRegistrationSettings(app, db, admin, now);
    registerAdminUsers(app, db, admin, now);
    registerAdminOperations(app, db, admin);
    registerAppearance(app, db, admin, now);
    registerAdminBot(app, db, admin, now, { enabled: options.botEnabledDefault, ...options.activityBot });
    registerBotDeliveries(app, db, security, admin, now, { enabled: options.botEnabledDefault, ...options.activityBot });
    registerAdminBackups(app, db, admin, journal, backups, now, history);
    registerAdminPrivacy(app, db, admin, now);
    registerAdminMusic(app, db, admin, now);
    registerAdminMusicPins(app, db, admin, now);
    registerAdminMusicErasure(app, db, admin, now, privacy);
    registerAccountProfile(app, db, security, now, options.botEnabledDefault);
    registerPrivacy(app, db, security, now, privacy);
    registerPrivacyConsent(app, db, security, now);
    registerMusicContact(app, db, security, now);
    registerMusicMatches(app, db, security);
    registerMusicRooms(app, db, security);
    registerMusicCircles(app, db, security);
    registerMusicShouts(app, db, security, admin, now);
    registerMusicTrend(app, db, security, now);
    registerMusicFields(app, db, security, now);
    registerActivityRoster(app, db, security, options.qq?.clientId);
    registerActivityAccess(app, db, security, now);
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
    registerLegacyLocal(app, db, security);
    registerLegacyFinance(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    registerCreateIntents(app, db, security);
    registerActivityHistory(app, db, security);
    registerActivityAttendance(app, db, security, now, {enabled:options.botEnabledDefault,...options.activityBot});
    app.get('/api/v2/me/activities', async request => {
      const user=security.scopedMember(request),query=PageQuery.parse(request.query);
      return db.transaction(()=>listMyActivities(db,user.id,query.page,now()))();
    });
    app.get('/api/v2/activities', async request => {
      const query = ActivitiesQuery.parse(request.query);
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
        if (current.id !== viewer.id) throw withApiError(new DomainError('ACCOUNT_CHANGED', '帳號已變更', 409));
        const previous = db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(viewer.id, requestKey) as { signature: string; response_json: string; response_status: number } | undefined;
        if (previous) {
          if (previous.signature !== signature) throw withApiError(new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409));
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
      const shell=readFileSync(join(options.staticRoot,'index.html'),'utf8');
      const sendShell=(request:import('fastify').FastifyRequest,reply:import('fastify').FastifyReply)=>{
        const language=displayLanguage(request.headers['accept-language']);
        return reply.header('Content-Language',language).header('Vary','Accept-Language').header('Cache-Control','no-store').type('text/html').send(shell.replace(/<html lang="[^"]*"/,`<html lang="${language}"`));
      };
      app.get('/',sendShell);app.get('/index.html',sendShell);
      app.register(staticFiles, { root: options.staticRoot, wildcard: false, preCompressed:true, cacheControl:false, etag:true, dotfiles:'deny', globIgnore:['index.html','**/*.br','**/*.gz','**/*.deflate'], setHeaders(response,path) {
        response.header('Cache-Control',staticCacheControl(options.staticRoot!,path));
      } });
      app.setNotFoundHandler((request, reply) => {
        if (!['GET','HEAD'].includes(request.method) || request.url.startsWith('/api/') || /^\/music\/api(?:[/?]|$)/.test(request.url) || (request.url.split('?')[0]!.includes('.')&&!['/music/index.html','/music/admin.html','/privacy.html','/music/privacy.html','/contact.html','/guide.html'].includes(request.url.split('?')[0]!))) return reply.code(404).send({ code: 'NOT_FOUND', message: '找不到此入口' });
        return sendShell(request,reply);
      });
    }
  });
  return app;
}
