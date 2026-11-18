import { withApiError } from './error-display';
import type { DB } from '@qgroup/database';
import { AdminMusicHistory } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';

export function musicOwnershipHistory(db: DB, profileId: string, before: number): z.infer<typeof AdminMusicHistory> {
  // Imported rows precede unified writes. A negative cursor keeps the original
  // row order and IDs intact without rewriting private migration evidence.
  const rows = db.prepare(`SELECT * FROM (
    SELECT h.id,h.revision,h.before_user_id AS beforeUserId,h.after_user_id AS afterUserId,h.reason,h.created_at AS createdAt,
      CASE WHEN h.actor_ref LIKE 'account:%' THEN COALESCE(u.nickname,'帳號管理員') ELSE '救援憑證' END AS actor,
      'unified' AS source,NULL AS legacyId,NULL AS createdSeconds
    FROM music_ownership_history h LEFT JOIN users u ON h.actor_ref='account:'||u.id WHERE h.profile_id=?
    UNION ALL
    SELECT i.row_number-9007199254740991,NULL,NULLIF(json_extract(i.payload_json,'$.before_user_id'),''),
      NULLIF(json_extract(i.payload_json,'$.after_user_id'),''),'',json_extract(i.payload_json,'$.created'),
      CASE WHEN json_extract(i.payload_json,'$.actor') LIKE 'account:%' THEN COALESCE(u.nickname,'帳號管理員') ELSE '舊版管理員' END,
      'legacy',json_extract(i.payload_json,'$.id'),json_extract(i.payload_json,'$.created')
    FROM music_legacy_identity i JOIN music_legacy_profiles l ON l.legacy_key=json_extract(i.payload_json,'$.qq')
      LEFT JOIN users u ON json_extract(i.payload_json,'$.actor')='account:'||u.id
    WHERE i.table_name='link_audit' AND l.profile_id=?
  ) WHERE id<? ORDER BY id DESC LIMIT 51`).all(profileId, profileId, before) as (Omit<z.infer<typeof AdminMusicHistory>['history'][number], 'createdAt'> & { createdAt: number | string })[];
  const invalid = () => withApiError(new DomainError('MUSIC_HISTORY_INVALID', '原關聯歷史格式異常，請聯絡管理員核對來源；原資料保留', 503));
  const history = rows.slice(0,50).map(row => {
    if (row.source === 'unified') return row;
    if (typeof row.createdSeconds !== 'number' || !Number.isFinite(row.createdSeconds) || row.createdSeconds < 0 || row.createdSeconds > 8640000000000 || !Number.isSafeInteger(row.legacyId) || row.legacyId! < 1) throw invalid();
    return { ...row, createdAt: new Date(row.createdSeconds * 1000).toISOString() };
  });
  const result = AdminMusicHistory.safeParse({ history, nextCursor: rows.length > 50 ? rows[49]!.id : null });
  if (!result.success) throw invalid();
  return result.data;
}
