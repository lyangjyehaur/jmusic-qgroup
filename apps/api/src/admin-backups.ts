import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { BackupId, MusicBackups } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import type { AdminSecurity } from './admin-security';
import type { PairedBackups } from './paired-backups';
import { readVerifiedErasureJournal, type ErasureJournal } from './erasure-journal';
import { createPrivacy } from './privacy';
import { exportMusic } from './music-export';
import type { LegacyMusicHistory } from './legacy-music-history';

export function registerAdminBackups(app: FastifyInstance, db: DB, admin: AdminSecurity, journal: ErasureJournal, backups: PairedBackups | undefined, now: () => Date, history?: LegacyMusicHistory) {
  app.get('/api/v2/admin/backups', async request => {
    admin.authority(request); z.object({}).strict().parse(request.query);
    try { return MusicBackups.parse({ available: !!backups || !!history, backups: [...(backups?.list() ?? []), ...(history?.list() ?? [])] }); }
    catch { throw withApiError(new DomainError('BACKUP_UNAVAILABLE', '備份清單無法驗證，請維運人員核對備份目錄；原始檔仍保留', 503)); }
  });
  app.get('/api/v2/admin/music-export', { exposeHeadRoute: false, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { backup } = z.object({ backup: BackupId.optional() }).strict().parse(request.query);
    const raw = db.transaction(() => {
      admin.authority(request);
      let entries;
      try { entries = readVerifiedErasureJournal(db, journal); }
      catch { throw withApiError(new DomainError('ERASURE_RECOVERY_REQUIRED', '刪除紀錄與資料庫無法核對，已停止匯出；請維運人員保全紀錄並完成重播', 503)); }
      if (!backup) return JSON.stringify(exportMusic(db), null, 2) + '\n';
      if (backup.startsWith('legacy-')) {
        try {
          if (!history || !history.list().some(item=>item.id===backup)) throw withApiError(new DomainError('BACKUP_NOT_FOUND', '備份不存在，請更新清單', 404));
          return JSON.stringify(history.export(backup,entries),null,2)+'\n';
        } catch(error) {
          if(error instanceof DomainError && error.code==='BACKUP_NOT_FOUND')throw error;
          throw withApiError(new DomainError('BACKUP_UNAVAILABLE','歷史備份或來源無法驗證，已停止下載；請維運人員核對原始檔',503));
        }
      }
      if (!backups) throw withApiError(new DomainError('BACKUP_UNAVAILABLE', '目前未啟用持久配對備份', 503));
      let copy: DB | undefined;
      try {
        if (!backups.list().some(item => item.id === backup)) throw withApiError(new DomainError('BACKUP_NOT_FOUND', '備份不存在或已超出保留期限，請更新清單', 404));
        copy = backups.open(backup, entries);
        // Apply all latest erasure intents, including RESET and account closure,
        // to a disposable in-memory copy. Never prune the original backup assets.
        createPrivacy(copy, { read: () => entries, append: () => { throw new Error('Read-only export journal'); } });
        return JSON.stringify(exportMusic(copy, db), null, 2) + '\n';
      } catch (error) {
        if (error instanceof DomainError && error.code === 'BACKUP_NOT_FOUND') throw error;
        throw withApiError(new DomainError('BACKUP_UNAVAILABLE', '備份或刪除紀錄無法驗證，已停止下載；請維運人員核對原始檔', 503));
      } finally { copy?.close(); }
    }).immediate();
    const stamp = backup ?? now().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return reply.header('Content-Disposition', 'attachment; filename="music-data-' + stamp + '.json"').type('application/json; charset=utf-8').send(raw);
  });
}
