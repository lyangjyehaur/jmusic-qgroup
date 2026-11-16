import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '@qgroup/database';
import { UpdateRegistrationSettings } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash, type Security } from './security';

export function nameRegistration(db: DB) {
  const row = db.prepare('SELECT allow_name_registration,revision FROM site_settings WHERE id=1').get() as { allow_name_registration: number; revision: number };
  return { enabled: !!row.allow_name_registration, revision: row.revision };
}
export function administratorRevision(db: DB, userId: string): number | undefined {
  return (db.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').get(userId) as { revision: number } | undefined)?.revision;
}
export function registerRegistrationSettings(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  function authority(request: FastifyRequest, write = false) {
    const device = write ? security.memberWrite(request) : security.scopedMember(request);
    const revision = administratorRevision(db, device.id);
    if (revision === undefined) throw new DomainError('ADMIN_REQUIRED', '需要管理員權限', 403);
    const adminCsrf = hash('qgroup-v2-admin:' + security.csrf(device) + ':' + revision);
    if (write && request.headers['x-admin-csrf'] !== adminCsrf) throw new DomainError('ADMIN_CHANGED', '管理權限已變更，請重新讀取設定', 403);
    return adminCsrf;
  }
  app.get('/api/v2/admin/registration', async request => ({ ...nameRegistration(db), adminCsrf: authority(request) }));
  app.post('/api/v2/admin/registration', async request => db.transaction(() => {
    const adminCsrf = authority(request, true);
    const data = UpdateRegistrationSettings.parse(request.body);
    const current = nameRegistration(db);
    if (current.revision !== data.revision) throw new DomainError('SETTINGS_CHANGED', '註冊設定已被修改，請重新讀取後確認', 409);
    if (current.enabled !== data.enabled) {
      db.prepare('UPDATE site_settings SET allow_name_registration=?,revision=revision+1 WHERE id=1').run(Number(data.enabled));
      db.prepare('INSERT INTO admin_audit(action,before_value,after_value,created_at) VALUES(?,?,?,?)').run('name_registration', Number(current.enabled), Number(data.enabled), now().toISOString());
    }
    return { ...nameRegistration(db), adminCsrf };
  }).immediate());
}
