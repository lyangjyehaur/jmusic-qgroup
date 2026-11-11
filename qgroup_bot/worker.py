"""Outbox delivery with bounded retries, claim fencing and send-time access checks."""
import json
import base64
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from qgroup_core import storage, bot_outbox, bot_views, bot_settings, bot_groups, settlements, payment_codes, permissions, media
from qgroup_core.common import now
from .api import hint, classify_error
from . import observability as obs
from . import markdown as md


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
        payload=json.loads(row['payload_json'])
        if payload.get('_settlement_version'):
            with self._connect() as db:
                version=payload['_settlement_version']
                if version!=settlements.latest_version(db,row['event_id']):return '结算已更新，旧版通知作废'
                actor=db.execute('SELECT actor_id FROM settlement_history WHERE event_id=? AND version=?',(row['event_id'],version)).fetchone()
                if not actor or not permissions.has(db,state,actor[0],'settlement'):return '原发布者的结算权限已撤销，请重新核对收款人并发布'
                if payload.get('_settlement_image'):
                    snapshot=settlements.details(db,row['event_id'],version)
                    if not snapshot or not snapshot.get('group_notice') or payload['_settlement_image'] not in payment_codes.frozen(db,row['event_id'],version):return '收款码与本版结算不一致'
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
        if md.has_unapproved_link(text, getattr(self.config, 'allowed_link_hosts', ())):
            return '文字含未报备域名，拒绝发送'
        return None

    def _keyboard_problem(self, keyboard):
        """Jump buttons carry URLs too; they must obey the same allowlist."""
        hosts = getattr(self.config, 'allowed_link_hosts', None)
        if not hosts or not isinstance(keyboard, dict):
            return None
        rows = (keyboard.get('content') or {}).get('rows') or []
        for row in rows:
            for button in row.get('buttons') or []:
                action = button.get('action') or {}
                if action.get('type') != 0:
                    continue
                if md.has_unapproved_link(str(action.get('data') or ''), hosts):
                    return '按钮含未报备域名，拒绝发送'
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
                planned = bot_outbox.build_message(db, event, row['kind'])
            if not planned:
                self._mark(row, 'skipped', '提醒已不适用')
                return 'skipped'
            payload = {'text': planned[0], 'msg_type': 0,
                       'markdown_text': planned[2].get('_markdown')}
            buttons = [(label, data+' '+row['event_id'] if data else '', jump)
                       for label, data, jump in planned[1]]
            keyboard = bot_outbox._keyboard(buttons)
            if keyboard:
                payload['keyboard'] = keyboard
        elif payload.get('_template_context'):
            context = bot_outbox.delivery_context(payload['_template_context'],
                                                  self._event_state(row['event_id']))
            payload['text'] = bot_outbox.render_message(policy,row['kind'],context)
            # Re-render from the frozen context so a template edit reaches
            # queued but unsent rows, exactly like the plain-text body does.
            try:
                payload['markdown_text'] = bot_outbox.render_message(
                    policy, row['kind'], context, markdown=True)
            except Exception as exc:
                payload['markdown_text'] = None
                obs.event('outbox_markdown_fallback', level=logging.WARNING,
                          **obs.error_fields(exc))
        body = {'msg_type': payload.get('msg_type', 0)}
        rich = payload.get('markdown_text')
        use_rich = (body['msg_type'] == 0 and getattr(self.config, 'markdown_replies', False)
                    and isinstance(rich, str))
        if use_rich:
            problem = md.content_problem(rich, getattr(self.config, 'allowed_link_hosts', ()))
            if problem:
                obs.event('outbox_markdown_fallback', reason=problem)
                use_rich = False
        if use_rich:
            # QQ rejects a body carrying both content and markdown.
            body = {'msg_type': 2, 'markdown': {'content': rich}}
        elif body['msg_type'] == 0:
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
            if payload.get('_settlement_image'):
                extra={'media':{'settlement_image':payload['_settlement_image']['kind']}}
            if not extra:
                self._mark(row, 'failed', '非文字消息缺少内容字段，拒绝发送')
                return 'failed'
            body.update(extra)
        if payload.get('keyboard'):
            problem = self._keyboard_problem(payload['keyboard'])
            if problem:
                self._mark(row, 'failed', problem)
                return 'failed'
            body['keyboard'] = payload['keyboard']
        logged_text = body.get('content') or (body.get('markdown') or {}).get('content') or ''
        obs.event('outbox_prepared', msg_type=body['msg_type'], keyboard=bool(body.get('keyboard')),
                  **obs.text_fields(logged_text, self.config))
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
        if payload.get('_settlement_image'):
            # Each image is its own durable job. Retrying an image never repeats
            # the already-confirmed text or another confirmed image.
            with self._connect() as db:
                parents=db.execute("SELECT status,payload_json FROM bot_outbox WHERE event_id=? AND kind='settlement_updated' ORDER BY id DESC",(row['event_id'],)).fetchall()
                parent=next((p for p in parents if json.loads(p['payload_json']).get('_settlement_version')==payload['_settlement_version'] and not json.loads(p['payload_json']).get('_settlement_image')),None)
                if not parent or parent['status'] in ('failed','skipped'):
                    self._mark(row,'failed','结算文字尚未确认送出，请先重送文字，再重送此图片')
                    return 'failed'
                if parent['status']!='sent':
                    self._mark(row,'pending','等待结算文字送出',retry_at=(datetime.now(timezone.utc)+timedelta(seconds=10)).isoformat(timespec='seconds'))
                    return 'deferred'
                raw=media.read(db,payload['_settlement_image']['digest'])
            ok,code,data=self.api.post('/v2/groups/%s/files' % group,dict(file_type=1,file_name='payment-code.png',file_data=base64.b64encode(raw).decode('ascii'),srv_send_msg=False))
            if ok:
                if not isinstance(data,dict) or not isinstance(data.get('file_info'),str) or not data['file_info']:
                    return self._failed(row,'平台上传响应缺少 file_info，未发送图片')
                body={'msg_type':7,'media':{'file_info':data['file_info']}}
                if not self._owned(row):return 'skipped'
                with self._connect() as db:latest=bot_settings.read(db,worker=True)
                if latest['revision']!=settings['revision']:
                    self._mark(row,'pending','群通知设置已变更，重新核对后发送',retry_at=now())
                    return 'deferred'
                reason=self._skip_reason(row,policy)
                if reason:
                    self._mark(row,'skipped',reason)
                    return 'skipped'
                ok,code,data=self.api.post('/v2/groups/%s/messages' % group,body)
        else:
            reason=self._skip_reason(row,policy)
            if reason:
                self._mark(row,'skipped',reason)
                return 'skipped'
            ok, code, data = self.api.post('/v2/groups/%s/messages' % group, body)
        obs.event('outbox_sending')
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
        if (body['msg_type'] == 2 and safe_code in md.MARKDOWN_REJECTION_CODES):
            # Logged only. Never auto-resend a refused markdown body as text:
            # the platform may already have delivered it.
            obs.event('outbox_markdown_rejected', level=logging.WARNING, api_code=safe_code)
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
