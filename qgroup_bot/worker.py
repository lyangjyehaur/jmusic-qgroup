"""Outbox delivery with bounded retries, claim fencing and send-time access checks."""
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from qgroup_core import storage, bot_outbox, bot_views, bot_settings, bot_groups
from qgroup_core.common import now
from .api import hint, classify_error
from . import observability as obs


class OutboxWorker:
    def __init__(self, config, api):
        self.config = config
        self.api = api
        # Cache refusals separately per destination. Writing a fresh refusal
        # must not silently skip the remaining rows of that same batch.
        self.authorization_blocks = {}

    def _connect(self):
        return storage.connect(self.config.db)

    def claim(self):
        stamp = now()
        stale = (datetime.now(timezone.utc) - timedelta(seconds=self.config.claim_timeout)).isoformat(timespec='seconds')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('''SELECT * FROM bot_outbox
                WHERE (status='pending' AND (due_at IS NULL OR due_at<=?)
                       AND (retry_at IS NULL OR retry_at<=?))
                   OR (status='sending' AND (claimed_at IS NULL OR claimed_at<=?))
                ORDER BY COALESCE(due_at,created_at),id LIMIT ?''',
                (stamp, stamp, stale, self.config.batch)).fetchall()
            claimed = []
            for row in rows:
                token = uuid.uuid4().hex
                db.execute("UPDATE bot_outbox SET status='sending',claimed_at=?,claim_token=? WHERE id=?",
                           (stamp, token, row['id']))
                claimed.append(dict(row, claim_token=token))
            return claimed

    def _owned(self, row):
        with self._connect() as db:
            return bool(db.execute("SELECT 1 FROM bot_outbox WHERE id=? AND status='sending' AND claim_token=?",
                                   (row['id'], row.get('claim_token', ''))).fetchone())

    def _event_state(self, event_id):
        with self._connect() as db:
            return db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()

    def _skip_reason(self, row, settings):
        if row['channel'] == 'private':
            return 'no binding: 个人通知尚未启用，不能改发到群'
        target = bot_groups.broadcast_target(settings, self.config.group)
        if not target:
            return '后台未设置主动通知目标群'
        if row['target'] and row['target'] != target:
            return '目标群不在允许范围内'
        if not settings['enabled'] or row['kind'] not in settings['broadcast_kinds']:
            return '后台已关闭此类通知'
        state = self._event_state(row['event_id'])
        if not bot_views.shareable(state):
            return '活动不再公开或已关闭群同步'
        if row['kind'] in bot_outbox.REMINDER_KINDS:
            if state['archived_at'] or state['lifecycle'] in ('ended', 'cancelled'):
                return '活动已结束／取消／归档，排程提醒过期'
            payload = json.loads(row['payload_json'])
            plan = bot_outbox.reminder_plan(state, row['kind'], settings)
            if not plan or payload.get('_schedule_key') != plan[1] or row['due_at'] != plan[0]:
                return '活动安排已变更，旧提醒作废'
            if row['kind'] == 'deadline_reminder' and (
                    state['deadline'] <= now() or not state['registration_open'] or state['lifecycle'] != 'scheduled'):
                return '报名已截止或暂停，提醒作废'
        return None

    def _mark(self, row, status, error='', *, retry_at=None, sent=False, simulated=False, payload=None, failure=False):
        with self._connect() as db:
            cursor = db.execute('''UPDATE bot_outbox SET status=?,last_error=?,sent_at=?,retry_at=?,
                simulated_at=?,delivered_payload_json=?,attempts=attempts+?
                WHERE id=? AND status='sending' AND claim_token=?''',
                (status, error[:300], now() if sent else None, retry_at,
                 now() if simulated else None, json.dumps(payload, ensure_ascii=False) if payload else None,
                 int(failure), row['id'], row.get('claim_token', '')))
        obs.event('outbox_state', status=status, state_persisted=bool(cursor.rowcount),
                  reason=error or None, retry_at=retry_at,
                  failed_attempts=row['attempts']+int(failure))
        return bool(cursor.rowcount)

    def _failed(self, row, error):
        attempts = row['attempts'] + 1
        status = 'failed' if attempts >= self.config.max_attempts else 'pending'
        retry_at = (datetime.now(timezone.utc) + timedelta(seconds=min(15 * 2 ** min(attempts-1, 6), 900))).isoformat(timespec='seconds')
        self._mark(row, status, error, retry_at=retry_at if status == 'pending' else None, failure=True)
        obs.event('outbox_retry_scheduled' if status == 'pending' else 'outbox_failed',
                  level=logging.WARNING, failed_attempts=attempts, reason=error,
                  retry_at=retry_at if status == 'pending' else None)
        return status

    def _content_problem(self, text):
        """User-authored titles, places and notes must not break a group send."""
        if any(ord(char) < 32 and char not in '\n\t' for char in text):
            return '文字含控制字符，拒绝发送'
        if len(text) > 4000:
            return '文字超过 4000 字，拒绝发送'
        hosts = getattr(self.config, 'allowed_link_hosts', None)
        if hosts:
            for match in re.finditer(r'https?://([^\s<>"\[\]{}]+)', text):
                host = (urlsplit('https://' + match.group(1)).hostname or '').lower()
                if host and host not in hosts:
                    return '文字含未报备域名，拒绝发送'
        return None

    def _group_state_path(self, group=None):
        suffix = '-'+obs.reference(group) if group else ''
        return Path(getattr(self.config, 'log_dir', Path(self.config.db).parent / 'bot-logs')) / ('bot-group-state'+suffix+'.json')

    def _read_authorization_block(self, group):
        try:
            path = self._group_state_path(group)
            if not path.exists() and group == self.config.group:
                path = self._group_state_path()
            with path.open(encoding='utf-8') as handle:
                state = json.load(handle)
            if state.get('push_authorized') is False:
                return '群主未授权主动发言，后台已暂停主动推送'
        except (OSError, ValueError, TypeError):
            return None
        return None

    def _record_rejection(self, code, group):
        if code not in (40034105, 40034101, 40054003, 1100104, 40054016):
            return
        try:
            path = self._group_state_path(group)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            raw = json.dumps(dict(push_authorized=False, code=code, recorded_at=now())).encode('utf-8')
            fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            try:
                os.write(fd, raw)
            finally:
                os.close(fd)
        except OSError as exc:
            obs.event('group_state_unavailable', level=logging.WARNING, **obs.error_fields(exc))

    def deliver(self, row):
        with self._connect() as db:
            policy = bot_settings.read(db, worker=True)['config']
        group = bot_groups.broadcast_target(policy, self.config.group)
        with obs.scope(trace_id=obs.trace_id(), outbox_id=row['id'], kind=row['kind'],
                       activity_ref=obs.reference(row['event_id']), group_ref=obs.reference(group),
                       attempt=row['attempts']+1):
            started = time.monotonic()
            obs.event('outbox_claimed', reclaimed=row['status']=='sending', channel=row['channel'],
                      due_at=row['due_at'], intent_hash=obs.reference(row['payload_json']))
            try:
                result = self._deliver(row)
            except Exception as exc:
                # Token and response parsing failures must consume a retry as well.
                obs.event('outbox_exception', level=logging.ERROR, **obs.error_fields(exc))
                result = self._failed(row, '请求异常：'+type(exc).__name__)
            obs.event('outbox_result', result=result, elapsed_ms=round((time.monotonic()-started)*1000))
            return result

    def _deliver(self, row):
        if not self._owned(row):
            obs.event('outbox_skipped', reason='claim_lost')
            return 'skipped'
        with self._connect() as db:
            settings = bot_settings.read(db, worker=True)
        policy = settings['config']
        group = bot_groups.broadcast_target(policy, self.config.group)
        if group not in self.authorization_blocks:
            self.authorization_blocks[group] = self._read_authorization_block(group)
        if self.authorization_blocks[group]:
            self._mark(row, 'skipped', self.authorization_blocks[group])
            return 'skipped'
        reason = self._skip_reason(row, policy)
        if reason:
            self._mark(row, 'skipped', reason)
            return 'skipped'
        payload = json.loads(row['payload_json'])
        if not isinstance(payload, dict):
            raise ValueError('invalid payload')
        if row['kind'] in bot_outbox.REMINDER_KINDS:
            with self._connect() as db:
                event = db.execute('SELECT * FROM events WHERE id=?', (row['event_id'],)).fetchone()
                planned = bot_outbox.compose(db, event, row['kind'])
            if not planned:
                self._mark(row, 'skipped', '提醒已不适用')
                return 'skipped'
            payload = {'text': planned[0], 'msg_type': 0}
            buttons = [(label, data+' '+row['event_id'] if data else '', jump)
                       for label, data, jump in planned[1]]
            keyboard = bot_outbox._keyboard(buttons)
            if keyboard:
                payload['keyboard'] = keyboard
        elif payload.get('_template_context'):
            context = payload['_template_context']
            payload['text'] = (bot_settings.render(policy, row['kind'], context)
                               if row['kind'] in policy['templates'] else context['_default_text'])
        body = {'msg_type': payload.get('msg_type', 0)}
        if body['msg_type'] == 0:
            content = payload.get('text', '')
            if not isinstance(content, str) or not content.strip():
                self._mark(row, 'failed', '文字内容为空，拒绝发送')
                return 'failed'
            problem = self._content_problem(content)
            if problem:
                self._mark(row, 'failed', problem)
                return 'failed'
            body['content'] = content
        else:
            extra = {k: v for k, v in payload.items() if k in ('content', 'media', 'file_info', 'markdown', 'image')}
            if not extra:
                self._mark(row, 'failed', '非文字消息缺少内容字段，拒绝发送')
                return 'failed'
            body.update(extra)
        if payload.get('keyboard'):
            body['keyboard'] = payload['keyboard']
        obs.event('outbox_prepared', msg_type=body['msg_type'], keyboard=bool(body.get('keyboard')),
                  **obs.text_fields(body.get('content'), self.config))
        recorded = dict(body, _config_revision=settings['revision'], _group_ref=obs.reference(group))
        dry_run = self.config.dry_run if policy['dry_run'] is None else policy['dry_run']
        if dry_run:
            self._mark(row, 'skipped', 'dry-run', simulated=True, payload=recorded)
            obs.event('outbox_simulated', sent=False)
            return 'simulated'
        if row['attempts'] >= self.config.max_attempts:
            self._mark(row, 'failed', '超过最大重试次数')
            return 'failed'
        # Recheck a claim that may have been invalidated during composition.
        if not self._owned(row):
            obs.event('outbox_skipped', reason='claim_lost')
            return 'skipped'
        # Do not sleep with claimed rows. Persist postponement without spending
        # a retry, and reserve a slot atomically across workers and restarts.
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute("SELECT 1 FROM bot_outbox WHERE id=? AND status='sending' AND claim_token=?",
                              (row['id'], row.get('claim_token', ''))).fetchone():
                return 'skipped'
            latest = bot_settings.read(db, worker=True)
            if latest['revision'] != settings['revision']:
                postpone = now()
            else:
                postpone = bot_settings.reserve_send(db, policy, datetime.now(timezone.utc))
        if postpone:
            self._mark(row, 'pending', '等待允许发送的时间', retry_at=postpone)
            return 'deferred'
        obs.event('outbox_sending')
        ok, code, data = self.api.post('/v2/groups/%s/messages' % group, body)
        if ok:
            persisted = self._mark(row, 'sent', sent=True, payload=recorded)
            obs.event('outbox_sent', sent_ref=obs.sent_reference(data), state_persisted=persisted)
            return 'sent'
        safe_code = code if type(code) is int else None
        http_status = data.get('_http_status', 200) if isinstance(data, dict) else 200
        message = 'code=%s %s' % (safe_code, hint(safe_code))
        kind = classify_error(safe_code, status=http_status, data=data)
        obs.event('outbox_send_rejected', level=logging.WARNING, api_code=safe_code,
                  http_status=http_status, error_kind=kind)
        if kind == 'unconfirmed':
            # 201/202 are async results. Never retry and risk a duplicate send.
            self._mark(row, 'skipped', '平台返回异步结果，未确认送出，需人工核对：' + message)
            obs.event('outbox_unconfirmed', level=logging.WARNING)
            return 'skipped'
        if kind == 'permanent':
            self._mark(row, 'failed', '内容被永久拒绝，停止重试：' + message, failure=True)
            obs.event('outbox_permanently_rejected', level=logging.WARNING)
            return 'failed'
        if kind == 'authorization':
            self._record_rejection(safe_code, group)
            obs.event('outbox_authorization_rejected', level=logging.WARNING)
            return self._failed(row, message)
        if kind == 'rate_limit':
            retry_at = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(timespec='seconds')
            self._mark(row, 'pending', '频控，等待配额恢复：' + message, retry_at=retry_at)
            obs.event('outbox_throttled', level=logging.WARNING, retry_at=retry_at)
            return 'deferred'
        return self._failed(row, message)

    def poll_once(self):
        with self._connect() as db:
            bot_groups.record_deployment(db, self.config.group)
            revision = bot_settings.read(db, worker=True)['revision']
            db.execute('UPDATE bot_runtime SET applied_revision=?,checked_at=? WHERE id=1', (revision, now()))
        rows = self.claim()
        results = [self.deliver(row) for row in rows]
        return dict(claimed=len(rows), sent=results.count('sent'), simulated=results.count('simulated'),
                    skipped=results.count('skipped'), failed=results.count('failed'), deferred=results.count('deferred'))
