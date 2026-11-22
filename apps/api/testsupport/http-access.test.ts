import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createSecurity } from '../src/security';
import { createAdminSecurity } from '../src/admin-security';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import type { FastifyRequest } from 'fastify';
import { checkHttpOperations, sharedSchemaCatalog } from '../../../tools/rebuild/build-http-contracts';
import { readHttpAccessBindings } from '../../../tools/rebuild/http-access';
import review from '../../../tools/rebuild/schemas/http-access-review.json';
import { assertHttpOpenAPI, httpOpenAPI } from '../../../tools/rebuild/http-openapi';

const root = fileURLToPath(new URL('../../..', import.meta.url)), rows = checkHttpOperations(root);
const document = () => httpOpenAPI(rows, sharedSchemaCatalog());
const accessDocument = document();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const op = (id: string) => {
  const row = rows.find(row => row.id === id)!;
  return accessDocument.paths[row.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')]![row.method.toLowerCase()] as Record<string, unknown>;
};
it('binds every actual v2 identity boundary while keeping full domain authorization unaccepted', async () => {
  const spec = document();await expect(assertHttpOpenAPI(spec)).resolves.toBeUndefined();
  expect(rows.filter(row => row.access)).toHaveLength(201);expect(rows.filter(row => !row.access)).toHaveLength(0);
  expect(rows.filter(row => row.access).map(row => row.id)).toEqual(review.operations.map(row => row.id));
  expect(rows.every(row => !row.access || row.access.boundaryReviewed && !row.access.domainAuthorizationComplete)).toBe(true);
  expect(spec['x-qgroup-erasure-recovery-gate-required']).toBe(true);
  expect(spec['x-qgroup-boundary-coverage-complete']).toBe(true);
  expect(spec['x-qgroup-permission-bindings-complete']).toBe(false);expect(spec['x-qgroup-release-eligible']).toBe(false);
});
it('documents the device scope and separate member restriction instead of promoting visitors to members', () => {
  expect(op('GET /api/v2/time-polls').security).toEqual([{ BrowserSession: [], AccountScope: [] }]);
  expect(op('GET /api/v2/time-polls/:id/manage').security).toEqual([{ MemberSession: [], AccountScope: [] }]);
  expect(op('PUT /api/v2/me/music').security).toEqual([{ MemberSession: [], AccountScope: [], WriteOrigin: [], DeviceCSRF: [] }]);
  expect(op('POST /api/v2/auth/qq/start').security).toEqual([{ BrowserSession: [], AccountScope: [], WriteOrigin: [], DeviceCSRF: [] }]);
  expect(op('POST /api/v2/auth/qq/start')['x-qgroup-access']).toMatchObject({ conditions: expect.arrayContaining(['Binding requires a member; login permits a visitor or member.']) });
});
it('documents account administrator and independent rescue alternatives including both write CSRF tokens', () => {
  expect(op('GET /api/v2/admin/session').security).toEqual([
    { AccountAdministrator: [], AccountScope: [] }, { BrowserSession: [], AccountScope: [], AdminSession: [] },
  ]);
  expect(op('POST /api/v2/admin/registration').security).toEqual([
    { AccountAdministrator: [], AccountScope: [], WriteOrigin: [], DeviceCSRF: [], AdminCSRF: [] },
    { BrowserSession: [], AccountScope: [], AdminSession: [], WriteOrigin: [], DeviceCSRF: [], AdminCSRF: [] },
  ]);
  expect(op('POST /api/v2/admin/login').security).toEqual([{ BrowserSession: [], AccountScope: [], WriteOrigin: [], DeviceCSRF: [] }]);
  expect(op('GET /api/v2/admin/operations/:key').security).toEqual([
    { AccountAdministrator: [], AccountScope: [], AdminScope: [] }, { BrowserSession: [], AccountScope: [], AdminSession: [], AdminScope: [] },
  ]);
});
it('retains anonymous public views, visitor bootstrapping and proof-only receipt recovery', () => {
  expect(op('GET /api/v2/activities').security).toEqual([{}]);expect(op('GET /api/v2/session').security).toEqual([{}]);
  expect(op('GET /api/v2/activities/:id').security).toEqual([{}, { BrowserSession: [], AccountScope: [] }]);
  expect(op('GET /api/v2/activities/:id/roster')['x-qgroup-access']).toMatchObject({ mode: 'optional-scoped-member' });
  const receipt = op('POST /api/v2/privacy/receipt');expect(receipt).not.toHaveProperty('security');
  expect(receipt['x-qgroup-body-proof']).toEqual({ schema: 'ErasureProof', fields: ['requestId', 'secret'], browserSessionRequired: false });
});
it('rejects missing or relocated reviewed operations instead of silently assigning an access mode by URL', () => {
  expect(() => readHttpAccessBindings(root, rows.filter(row => row.id !== 'GET /api/v2/session'))).toThrow('Invalid HTTP access review binding');
  expect(() => readHttpAccessBindings(root, rows.map(row => row.id === 'GET /api/v2/session' ? { ...row, file: 'apps/api/src/other.ts' } : row))).toThrow('Invalid HTTP access review binding');
  expect(() => readHttpAccessBindings(root, [...rows, rows[0]!])).toThrow('Duplicate HTTP operation');
});
it.each(['apps/api/src/security.ts', 'apps/api/src/admin-security.ts', 'apps/api/src/time-polls.ts'])('requires renewed manual boundary review when a pinned source changes: %s', file => {
  const stage = mkdtempSync(join(tmpdir(), 'qgroup-http-access-'));cleanups.push(() => rmSync(stage, { recursive: true, force: true }));
  for (const source of Object.keys(review.sourcePins)) { const path = join(stage, source);mkdirSync(dirname(path), { recursive: true });writeFileSync(path, readFileSync(join(root, source))); }
  expect(readHttpAccessBindings(stage, rows).size).toBe(201);
  writeFileSync(join(stage, file), '\n// Changed synthetic source\n', { flag: 'a' });
  expect(() => readHttpAccessBindings(stage, rows)).toThrow('HTTP access source changed; review required: ' + file);
});
it('checks current device scope, origin and CSRF before member writes without giving visitor sessions member access', () => {
  const db = openDatabase(':memory:');fixture(db);cleanups.push(() => { db.close(); });
  const security = createSecurity(db, 'https://rebuild.example', () => new Date('2026-11-17T08:00:00.000Z'), 'synthetic-http-access');
  const member = { cookies: { kanban_session: 'fixture-alice' }, headers: {} } as unknown as FastifyRequest;
  const device = security.read(member)!;
  member.headers = { 'x-account-scope': device.scope, origin: 'https://rebuild.example', 'x-csrf-token': security.csrf(device) };
  expect(security.memberWrite(member).id).toBe('alice');
  for (const [header, value, code] of [['x-account-scope', 'stale', 'ACCOUNT_CHANGED'], ['origin', 'https://other.example', 'ORIGIN_REJECTED'], ['x-csrf-token', 'wrong', 'CSRF_REJECTED']]) {
    expect(() => security.memberWrite({ ...member, headers: { ...member.headers, [header!]: value } } as FastifyRequest)).toThrow(expect.objectContaining({ code }));
  }
  db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(hash('synthetic-visitor'), '2026-11-18T08:00:00.000Z', 'before');
  const visitor = { cookies: { kanban_session: 'synthetic-visitor' }, headers: {} } as unknown as FastifyRequest;
  visitor.headers = { 'x-account-scope': security.read(visitor)!.scope };
  expect(security.scoped(visitor).kind).toBe('visitor');expect(() => security.scopedMember(visitor)).toThrow(expect.objectContaining({ code: 'LOGIN_REQUIRED' }));
});
it('keeps a valid rescue administrator as a visitor and rechecks credential expiry and admin CSRF', () => {
  const db = openDatabase(':memory:');fixture(db);cleanups.push(() => { db.close(); });
  const now = () => new Date('2026-11-17T08:00:00.000Z'), origin = 'https://rebuild.example';
  const security = createSecurity(db, origin, now, 'synthetic-http-access'), credential = hash('synthetic-rescue-key');
  db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(hash('synthetic-visitor'), '2026-11-18T08:00:00.000Z', 'before');
  db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(hash('synthetic-admin'), credential, '2026-11-17T09:00:00.000Z', 'before');
  const request = { cookies: { kanban_session: 'synthetic-visitor', kanban_admin: 'synthetic-admin' }, headers: {} } as unknown as FastifyRequest;
  const device = security.read(request)!;request.headers = { 'x-account-scope': device.scope, origin, 'x-csrf-token': security.csrf(device) };
  const admin = createAdminSecurity(db, security, origin, now, () => credential);
  const access = admin.authority(request);expect(access.method).toBe('credential');expect(access.userId).toBeNull();expect(access.device.kind).toBe('visitor');
  expect(() => security.scopedMember(request)).toThrow(expect.objectContaining({ code: 'LOGIN_REQUIRED' }));
  expect(() => admin.authority(request, true)).toThrow(expect.objectContaining({ code: 'ADMIN_CHANGED' }));
  request.headers['x-admin-csrf'] = access.adminCsrf;expect(admin.authority(request, true).method).toBe('credential');
  db.prepare('UPDATE admin_sessions SET expires_at=?').run(now().toISOString());expect(() => admin.authority(request)).toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
});
it('matches actual anonymous, visitor, member and proof boundaries using the isolated API', async () => {
  const db = openDatabase(':memory:');fixture(db);const app = createApp({ db, origin: 'https://rebuild.example', now: () => new Date('2026-11-17T08:00:00.000Z') });
  cleanups.push(async () => { await app.close();db.close(); });await app.ready();
  expect((await app.inject({ url: '/api/v2/activities' })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v2/time-polls' })).json().code).toBe('SESSION_EXPIRED');
  const bootstrap = await app.inject({ url: '/api/v2/session' }), cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const headers = { cookie, 'x-account-scope': bootstrap.json().scope };
  expect((await app.inject({ url: '/api/v2/time-polls', headers })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v2/me/music', headers })).json().code).toBe('LOGIN_REQUIRED');
  const proof = { requestId: '00000000-0000-4000-8000-000000000001', secret: 'a'.repeat(64) };
  const receipt = await app.inject({ method: 'POST', url: '/api/v2/privacy/receipt', payload: proof });
  expect(receipt.statusCode).toBe(404);expect(receipt.json().code).toBe('RECEIPT_NOT_FOUND');
});

it('rejects an added operation until its identity boundary has been reviewed', () => {
  expect(() => readHttpAccessBindings(root, [...rows, { ...rows[0]!, id: 'GET /api/v2/unreviewed', file: 'apps/api/src/app.ts' }])).toThrow('HTTP operation has no reviewed identity boundary');
});
async function isolatedBoundaryApp(credential = '') {
  const db = openDatabase(':memory:');fixture(db);
  const origin = 'https://rebuild.example';
  const app = createApp({ db, origin, now: () => new Date('2026-11-17T08:00:00.000Z'), adminCredentialHash: () => credential });
  cleanups.push(async () => { await app.close();db.close(); });await app.ready();
  const session = async (cookie = '') => {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } });
    return { cookie: cookie || String(response.headers['set-cookie']).split(';')[0]!, viewer: response.json() };
  };
  return { db, app, origin, session };
}
it('keeps all optional financial reads distinct from the anonymous activity projection when a valid cookie lacks scope', async () => {
  const { app, session } = await isolatedBoundaryApp();const visitor = await session();
  const urls = [
    '/activities/listen/finance', '/activities/listen/settlement', '/activities/listen/settlement/history',
    '/activities/listen/settlement/history/1', '/activities/listen/payment-code', '/activities/listen/settlement/asset-versions',
    '/activities/listen/settlement/history/1/assets', '/activities/listen/settlement/history/1/payment-code',
    '/activities/listen/settlement/history/1/payment-codes/other', '/activities/listen/settlement/history/1/receipts/0123456789abcdef',
  ];
  for (const url of urls) for (const cookie of [visitor.cookie, 'kanban_session=fixture-alice']) {
    const response = await app.inject({ url: '/api/v2' + url, headers: { cookie } });
    expect(response.statusCode, url).toBe(409);expect(response.json().code, url).toBe('ACCOUNT_CHANGED');
  }
  for (const cookie of [visitor.cookie, 'kanban_session=fixture-alice']) expect((await app.inject({ url: '/api/v2/activities/listen', headers: { cookie } })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v2/activities/listen/finance' })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v2/activities/listen/finance', headers: { cookie: visitor.cookie, 'x-account-scope': visitor.viewer.scope } })).statusCode).toBe(200);
  for (const row of rows.filter(row => row.access?.mode === 'optional-scoped-device')) {
    expect(op(row.id).security).toEqual([{}, { BrowserSession: [], AccountScope: [] }]);
  }
  expect(rows.filter(row => row.access?.mode === 'optional-scoped-device')).toHaveLength(10);
});
it('keeps rescue administrator delivery inspection separate from member authority to retry activity or poll notifications', async () => {
  const key = 'synthetic-boundary-rescue-' + 'x'.repeat(32);
  const { app, origin, session } = await isolatedBoundaryApp(hash(key));const visitor = await session();
  const headers = { cookie: visitor.cookie, origin, 'x-account-scope': visitor.viewer.scope, 'x-csrf-token': visitor.viewer.csrf };
  const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers, payload: { key, confirm: true } });expect(login.statusCode).toBe(200);
  headers.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
  expect((await app.inject({ url: '/api/v2/admin/bot/deliveries', headers })).statusCode).toBe(200);
  const scoped = await app.inject({ url: '/api/v2/activities/listen/bot-deliveries', headers });expect(scoped.statusCode).toBe(401);expect(scoped.json().code).toBe('LOGIN_REQUIRED');
  expect(op('GET /api/v2/admin/bot/deliveries').security).toEqual([{ AccountAdministrator: [], AccountScope: [] }, { BrowserSession: [], AccountScope: [], AdminSession: [] }]);
  expect(op('GET /api/v2/activities/:id/bot-deliveries').security).toEqual([{ MemberSession: [], AccountScope: [] }]);
  expect(op('POST /api/v2/time-polls/:id/bot-deliveries/:deliveryId/retry').security).toEqual([{ MemberSession: [], AccountScope: [], WriteOrigin: [], DeviceCSRF: [] }]);
});
it('preserves recipient-bound delegation previews even though unrestricted invitation previews can be anonymous', async () => {
  const { app, db, session } = await isolatedBoundaryApp();
  db.prepare(`INSERT INTO management_invitations(id,event_id,kind,token,target_name,recipient_id,permissions_json,initiator_id,status,expires_at,created_at)
    VALUES('synthetic-invitation','listen','cohost',?,'受邀者','bob','["attendance"]','alice','pending','2026-11-18T08:00:00.000Z','before')`).run('x'.repeat(32));
  const url = '/api/v2/activities/listen/delegation/preview/' + 'x'.repeat(32);
  const anonymous = await app.inject({ url });expect(anonymous.statusCode).toBe(403);expect(anonymous.json().code).toBe('MANAGEMENT_RECIPIENT');
  const bob = await session('kanban_session=fixture-bob');
  expect((await app.inject({ url, headers: { cookie: bob.cookie, 'x-account-scope': bob.viewer.scope } })).statusCode).toBe(200);
  expect((await app.inject({ url, headers: { cookie: bob.cookie } })).json().code).toBe('MANAGEMENT_RECIPIENT');
  expect(op('GET /api/v2/activities/:id/delegation/preview/:token')['x-qgroup-access']).toMatchObject({ mode: 'optional-scoped-member', conditions: expect.arrayContaining(['A recipient-bound invitation requires the intended member; anonymous and other members are rejected for that invitation.']) });
});
