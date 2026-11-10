"""Consume bot_outbox. Only delivery state is written; business tables are read-only."""
import json
import logging
from datetime import datetime, timedelta, timezone

from qgroup_core import storage
from qgroup_core.common import now
from .api import hint


class OutboxWorker:
    def __init__(self, config, api):
        self.config = config
        self.api = api

    def _connect(self):
        return storage.connect(self.config.db)

    def claim(self):
        stamp = now()
        stale = (datetime.now(timezone.utc) - timedelta(seconds=self.config.claim_timeout)) \
            .isoformat(timespec='seconds')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('''SELECT * FROM bot_outbox
                WHERE (status='pending' AND (due_at IS NULL OR due_at<=?))
                   OR (status='sending' AND (claimed_at IS NULL OR claimed_at<=?))
                ORDER BY COALESCE(due_at,created_at), id LIMIT ?''',
                (stamp, stale, self.config.batch)).fetchall()
            for row in rows:
                db.execute("UPDATE bot_outbox SET status='sending',claimed_at=? WHERE id=?",
                           (stamp, row['id']))
            db.commit()
            return [dict(row) for row in rows]

    def _event_state(self, event_id):
        with self._connect() as db:
            return db.execute('SELECT lifecycle,archived_at FROM events WHERE id=?',
                              (event_id,)).fetchone()

    def _skip_reason(self, row):
        if row['channel'] == 'private' and not row['target']:
            return 'no binding: member_openid <-> user_id 尚未建立'
        if row['kind'] in ('deadline_reminder', 'estimated_over_reminder'):
            state = self._event_state(row['event_id'])
            if state is None:
                return '活動不存在'
            if state['archived_at'] or state['lifecycle'] in ('ended', 'cancelled'):
                return '活動已結束／取消／歸檔，排程提醒過期'
        return None

    def _mark(self, row_id, status, error='', sent=False):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('''UPDATE bot_outbox SET status=?,last_error=?,sent_at=?,
                attempts=attempts+? WHERE id=?''',
                (status, error[:300], now() if sent else None,
                 1 if error else 0, row_id))
            db.commit()

    def deliver(self, row):
        label = '%s/%s' % (row['kind'], str(row['event_id'])[:8])
        reason = self._skip_reason(row)
        if reason:
            self._mark(row['id'], 'skipped', reason)
            logging.info('[outbox] skip %s：%s', label, reason)
            return 'skipped'
        try:
            payload = json.loads(row['payload_json'])
        except (ValueError, TypeError):
            self._mark(row['id'], 'failed', 'payload_json 無法解析')
            return 'failed'

        if self.config.dry_run:
            logging.info('[outbox] DRY-RUN %s → %s…\n%s', label,
                         self.config.group[:10], payload.get('text', '')[:400])
            self._mark(row['id'], 'sent', 'dry-run', sent=True)
            return 'sent'

        target = row['target'] or self.config.group
        body = {'msg_type': payload.get('msg_type', 0)}
        if body['msg_type'] == 0:
            content = payload.get('text', '')
            if not content.strip():
                self._mark(row['id'], 'failed', '文字訊息內容為空，拒絕發送')
                return 'failed'
            body['content'] = content
        else:
            # Rich media must carry its own API fields; never send an empty card.
            extra = {key: value for key, value in payload.items()
                     if key in ('content', 'media', 'file_info', 'markdown', 'image')}
            if not extra:
                self._mark(row['id'], 'failed', '非文字訊息缺少內容欄位，拒絕發送')
                return 'failed'
            body.update(extra)
        if payload.get('keyboard'):
            body['keyboard'] = payload['keyboard']
        path = ('/v2/users/%s/messages' if row['channel'] == 'private'
                else '/v2/groups/%s/messages') % target
        ok, code, _ = self.api.post(path, body)
        if ok:
            self._mark(row['id'], 'sent', '', sent=True)
            logging.info('[outbox] sent %s → %s…', label, target[:10])
            return 'sent'
        error = 'code=%s %s' % (code, hint(code))
        attempts = row['attempts'] + 1
        status = 'failed' if attempts >= self.config.max_attempts else 'pending'
        self._mark(row['id'], status, error)
        logging.warning('[outbox] %s %s（第 %d 次）', status, label, attempts)
        return status

    def poll_once(self):
        rows = self.claim()
        results = [self.deliver(row) for row in rows]
        return {'claimed': len(rows), 'sent': results.count('sent'),
                'skipped': results.count('skipped'), 'failed': results.count('failed')}
