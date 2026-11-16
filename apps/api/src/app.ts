import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { SaveProfile, type Viewer } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { catalog, getActivity, getProfile, listActivities, saveProfile } from './repositories';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const accountScope = (id: string) => hash('kanban-drafts-v1:' + id);
interface Identity { id: string; nickname: string; tokenHash: string; scope: string }
export interface AppOptions { db: DB; origin: string; now?: () => Date; csrfSecret?: string; staticRoot?: string; logger?: boolean }
export function createApp(options: AppOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.origin).origin;
  const csrfSecret = options.csrfSecret ?? randomBytes(32).toString('hex');
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32768, trustProxy: false });
  app.register(cookie);
  app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } } });
  app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  function identity(request: FastifyRequest): Identity | null {
    const token = request.cookies.kanban_session;
    if (!token || token.length > 512) return null;
    const tokenHash = hash(token);
    const row = db.prepare(`SELECT u.id,u.nickname FROM browser_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)`).get(tokenHash) as { id: string; nickname: string } | undefined;
    return row ? { ...row, tokenHash, scope: accountScope(row.id) } : null;
  }
  function requireIdentity(request: FastifyRequest) {
    const viewer = identity(request);
    if (!viewer) throw new DomainError('LOGIN_REQUIRED', '請先登入同一個群聚帳號', 401);
    return viewer;
  }
  function requireScopedIdentity(request: FastifyRequest) {
    const viewer = requireIdentity(request);
    if (request.headers['x-account-scope'] !== viewer.scope) throw new DomainError('ACCOUNT_CHANGED', '目前帳號已變更；請重新整理並確認帳號', 409);
    return viewer;
  }
  const csrf = (viewer: Identity) => createHmac('sha256', csrfSecret).update(viewer.tokenHash + ':' + viewer.scope).digest('hex');
  function requireWrite(request: FastifyRequest) {
    const viewer = requireIdentity(request);
    if (request.headers.origin !== origin) throw new DomainError('ORIGIN_REJECTED', '請從本站重新開啟操作', 403);
    if (request.headers['x-account-scope'] !== viewer.scope) throw new DomainError('ACCOUNT_CHANGED', '目前帳號已變更；請重新整理並確認帳號', 409);
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf(viewer)))) throw new DomainError('CSRF_REJECTED', '操作驗證已失效，請重新整理', 403);
    return viewer;
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_INPUT', message: '輸入格式不符，請檢查選擇與版本' });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ code: 'INVALID_REQUEST', message: error.statusCode === 429 ? '操作太頻繁，請稍後再試' : '請求格式不符' });
    request.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '暫時無法完成操作，請保留選擇後重試' });
  });
  app.get('/api/v2/health', async () => ({ ok: true, project: 'qgroup-unified-rebuild', schema: 1 }));
  app.get('/api/v2/session', async (request): Promise<Viewer> => {
    const viewer = identity(request);
    return viewer ? { authenticated: true, nickname: viewer.nickname, scope: viewer.scope, csrf: csrf(viewer) } : { authenticated: false };
  });
  app.get('/api/v2/activities', async request => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), period: z.enum(['upcoming', 'history']).default('upcoming') }).strict().parse(request.query);
    return listActivities(db, query.page, query.period, now());
  });
  app.get('/api/v2/activities/:id', async request => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
    return getActivity(db, id, now());
  });
  app.get('/api/v2/music/entries', async () => ({ entries: catalog(db) }));
  app.get('/api/v2/me/music', async request => getProfile(db, requireScopedIdentity(request).id));
  app.put('/api/v2/me/music', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const viewer = requireWrite(request);
    const input = SaveProfile.parse(request.body);
    const requestKey = z.string().uuid().parse(request.headers['idempotency-key']);
    const signature = hash('v2:PUT:/api/v2/me/music:' + JSON.stringify(input));
    return db.transaction(() => {
      // Revalidate inside the write transaction; revoked/switched sessions cannot replay results.
      const current = requireWrite(request);
      if (current.id !== viewer.id) throw new DomainError('ACCOUNT_CHANGED', '帳號已變更', 409);
      const previous = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(viewer.id, requestKey) as { signature: string; response_json: string } | undefined;
      if (previous) {
        if (previous.signature !== signature) throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
        return JSON.parse(previous.response_json) as ReturnType<typeof saveProfile>;
      }
      const result = saveProfile(db, viewer.id, input, now());
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(viewer.id, requestKey, signature, JSON.stringify(result), 200, now().toISOString());
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
  return app;
}
