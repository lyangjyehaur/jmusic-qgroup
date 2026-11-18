import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { UpdateRegistrationSettings } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import type { AdminSecurity } from './admin-security';
export { administratorRevision } from './admin-security';

export function nameRegistration(db: DB) {
  const row = db.prepare('SELECT allow_name_registration,revision FROM site_settings WHERE id=1').get() as { allow_name_registration: number; revision: number };
  return { enabled: !!row.allow_name_registration, revision: row.revision };
}
export function registerRegistrationSettings(app: FastifyInstance, db: DB, admin: AdminSecurity, now: () => Date) {
  const authority = (request: Parameters<AdminSecurity['authority']>[0], write = false) => admin.authority(request, write).adminCsrf;
  app.get('/api/v2/admin/registration', async request => ({ ...nameRegistration(db), adminCsrf: authority(request) }));
  app.post('/api/v2/admin/registration', async request => db.transaction(() => {
    const adminCsrf = authority(request, true);
    const data = UpdateRegistrationSettings.parse(request.body);
    const current = nameRegistration(db);
    if (current.revision !== data.revision) throw withApiError(new DomainError('SETTINGS_CHANGED', '註冊設定已被修改，請重新讀取後確認', 409));
    if (current.enabled !== data.enabled) {
      admin.preserve(request);
      db.prepare('UPDATE site_settings SET allow_name_registration=?,revision=revision+1 WHERE id=1').run(Number(data.enabled));
      db.prepare('INSERT INTO admin_audit(action,before_value,after_value,created_at) VALUES(?,?,?,?)').run('name_registration', Number(current.enabled), Number(data.enabled), now().toISOString());
    }
    return { ...nameRegistration(db), adminCsrf };
  }).immediate());
}
