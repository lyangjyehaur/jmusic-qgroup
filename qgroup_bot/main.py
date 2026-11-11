#!/usr/bin/env python3
"""qgroup-bot: standalone QQ group bot (WebSocket events + outbox delivery).

    python3 -m qgroup_bot.main

Requires ``websockets`` (the web service itself has no third-party deps).
Active pushes are plain HTTP, so outbox delivery keeps working even when the
WebSocket is disconnected. Passive replies need a live WebSocket.
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from qgroup_core import bot_settings, bot_groups, storage

from .api import QQBotAPI
from .config import Config
from .replies import COMMANDS, answer, answer_markdown, parse, read_db
from .worker import OutboxWorker
from . import markdown as md
from . import observability as obs


def ws_connect():
    """Late import so configuration errors are reported before dependency errors."""
    try:
        from websockets.asyncio.client import connect
    except ImportError:
        try:
            from websockets import connect
        except ImportError:
            raise RuntimeError('缺少依賴：請執行 pip install websockets')
    return connect


MENTION = re.compile(r'<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user id="([A-Za-z0-9_-]+)"[^>]*>')


def _markdown_reply(db, command, argument, config):
    """Best-effort rich reply; any problem keeps the existing plain text.

    The plain-text answer is always produced first and stays available, so a
    renderer bug, a control character or an unreported link host can only
    remove the extra formatting, never take the reply down.
    """
    if not getattr(config, 'markdown_replies', False):
        return None
    try:
        value = answer_markdown(db, command, argument)
        if value is None:
            return None
        problem = md.content_problem(value, getattr(config, 'allowed_link_hosts', ()))
        if problem:
            obs.event('reply_markdown_fallback', reason=problem)
            return None
        return value
    except Exception as exc:
        obs.event('reply_markdown_fallback', level=logging.WARNING,
                  **obs.error_fields(exc))
        return None


def normalize_content(content):
    """Strip platform mention markup so the same @ is not counted twice."""
    return MENTION.sub(' ', str(content or '')).strip()


def mentions_bot(mentions, bot_id, content):
    """is_you is not guaranteed on GROUP_MESSAGE_CREATE; check the User id too."""
    for item in mentions or []:
        if not isinstance(item, dict):
            continue
        if item.get('is_you') is True:
            return True
        if bot_id and item.get('id') == bot_id:
            return True
        if item.get('bot') is True and not bot_id:
            return True
    if bot_id:
        for match in MENTION.finditer(str(content or '')):
            if bot_id in match.groups():
                return True
    return False


def union_diagnostics(author, config):
    """Observe the platform's cross-app identity without logging its value.

    QQ only fills ``author.union_openid`` after the Union_openid binding is
    approved, so an empty field is a platform state, not a code defect. A
    site-side match is reported as a boolean; raw identifiers stay out of logs.
    """
    author = author if isinstance(author, dict) else {}
    raw = author.get('union_openid')
    value = raw.strip() if isinstance(raw, str) else ''
    account = author.get('union_user_account')
    fields = dict(union_openid_present=bool(value), union_openid_len=len(value),
                  union_user_account_present=isinstance(account, str) and bool(account.strip()))
    if not value:
        return fields
    fields['union_openid_ref'] = obs.reference(value)
    try:
        db = read_db(config.db)
        try:
            hit = db.execute('SELECT 1 FROM external_unionids WHERE union_id=? LIMIT 1',
                             (value,)).fetchone()
            fields['unionid_matches_site'] = bool(hit)
        finally:
            db.close()
    except Exception as exc:
        # Older schemas lack the table; observation must never block a message.
        fields['unionid_lookup'] = 'unavailable'
        fields['unionid_lookup_error'] = type(exc).__name__
    return fields


class Bot:
    def __init__(self, config):
        self.config = config
        self.api = QQBotAPI(config)
        self.worker = OutboxWorker(config, self.api)
        self.seen = {}          # message ids, 10 minutes
        self.seen_fp = {}       # event fingerprints, 30 seconds
        self.seen_interactions = {}   # interaction ids, 10 minutes
        self.session_id = None
        self.bot_id = None
        self.last_seq = None
        self.last_ack = None
        self.last_ready = None
        self.last_poll = None
        self.reconnects = 0
        self.heartbeat_task = None
        self.stopping = False
        # The admin DB policy is the single source of truth. Keep the resolved
        # value so health state and panel registration never report the boot
        # environment instead of the policy actually in effect.
        self.resolved_dry_run = None
        self.panels_done = False
        self.group_seen = {}

    def record_group(self, group_id, event_type=None, reason=None):
        """Store routing diagnostics only, never chat content or member IDs."""
        try:
            with storage.connect(self.config.db) as db:
                if event_type:
                    bot_groups.observe(db, group_id, event_type)
                if reason:
                    bot_groups.ignored(db, group_id, reason)
        except Exception as exc:
            obs.event('group_observation_unavailable', level=logging.DEBUG,
                      error_type=type(exc).__name__)

    def reply_group_allowed(self, group_id):
        try:
            db = read_db(self.config.db)
            try:
                policy = bot_settings.read(db, worker=True)['config']
            finally:
                db.close()
            return bot_groups.reply_allowed(policy, group_id, self.config.group)
        except Exception as exc:
            obs.event('group_policy_unavailable', level=logging.WARNING,
                      error_type=type(exc).__name__)
            return False

    def resolve_dry_run(self):
        """Same merge as _reply / worker: DB wins, env is the 'inherit' default."""
        try:
            db = read_db(self.config.db)
            try:
                override = bot_settings.read(db, worker=True)['config'].get('dry_run')
            finally:
                db.close()
            return self.config.dry_run if override is None else bool(override)
        except Exception as exc:
            # Older schemas have no bot_settings table; never block the loop
            # or spam the log on every poll before the migration is applied.
            obs.event('policy_resolve_fallback', level=logging.DEBUG,
                      error_type=type(exc).__name__)
            return self.config.dry_run

    async def refresh_policy(self):
        self.resolved_dry_run = await asyncio.to_thread(self.resolve_dry_run)
        return self.resolved_dry_run

    async def sync_panels(self):
        """Register panels when the live policy switches to real sending."""
        if not getattr(self.config, 'setup_panels', False):
            return
        if self.resolved_dry_run is None:
            await self.refresh_policy()
        if self.resolved_dry_run:
            # Re-arm so switching back to real sending registers again.
            self.panels_done = False
            return
        if self.panels_done:
            return
        try:
            await asyncio.to_thread(self.api.setup_panels, COMMANDS, self.config.group)
            self.panels_done = True
            obs.event('panels_registered')
        except Exception as exc:
            obs.event('panels_failed', level=logging.WARNING, **obs.error_fields(exc))

    def health_path(self):
        default = Path(self.config.db).parent / 'bot-logs'
        return Path(getattr(self.config, 'log_dir', default)) / 'bot-health.json'

    def write_health(self):
        """Private, bounded state for the container healthcheck."""
        try:
            path = self.health_path()
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            state = dict(dry_run=(self.config.dry_run if self.resolved_dry_run is None
                                 else self.resolved_dry_run),
                         deployment_dry_run=self.config.dry_run,
                         policy_resolved=self.resolved_dry_run is not None,
                         last_ack=self.last_ack, last_ready=self.last_ready,
                         last_poll=self.last_poll, reconnects=self.reconnects,
                         updated_at=time.time())
            raw = json.dumps(state, separators=(',', ':')).encode('utf-8')
            fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            try:
                os.write(fd, raw)
            finally:
                os.close(fd)
        except OSError as exc:
            obs.event('health_state_unavailable', level=logging.WARNING, **obs.error_fields(exc))

    def duplicate(self, message_id, fingerprint=''):
        """One @ can arrive as both GROUP_AT_MESSAGE_CREATE and
        GROUP_MESSAGE_CREATE. The fingerprint includes the platform timestamp,
        so asking the same question again is a new message, not a duplicate.
        """
        stamp = time.time()
        for key, value in list(self.seen.items()):
            if stamp - value > 600:
                self.seen.pop(key, None)
        for key, value in list(self.seen_fp.items()):
            if stamp - value > 30:
                self.seen_fp.pop(key, None)
        fp_key = hashlib.sha256(fingerprint.encode('utf-8')).hexdigest() \
            if fingerprint else ''
        hit = bool((message_id and message_id in self.seen)
                   or (fp_key and fp_key in self.seen_fp))
        if message_id:
            self.seen[message_id] = stamp
        if fp_key:
            self.seen_fp[fp_key] = stamp
        return hit

    def remember_interaction(self, interaction_id):
        """A platform interaction may only be ACKed once."""
        stamp = time.time()
        for key, value in list(self.seen_interactions.items()):
            if stamp - value > 600:
                self.seen_interactions.pop(key, None)
        if not isinstance(interaction_id, str) or not interaction_id:
            return True
        if interaction_id in self.seen_interactions:
            return False
        self.seen_interactions[interaction_id] = stamp
        return True

    async def poll_loop(self):
        while not self.stopping:
            try:
                await self.refresh_policy()
                await self.sync_panels()
                result = await asyncio.to_thread(self.worker.poll_once)
                self.last_poll = time.time()
                self.write_health()
                if result['claimed']:
                    obs.event('poll_completed', **result)
            except Exception as exc:
                obs.event('poll_failed', level=logging.ERROR, **obs.error_fields(exc))
            await asyncio.sleep(self.config.poll_interval)

    async def handle_dispatch(self, ws, message):
        payload = message.get('d') or {}
        author = payload.get('author') or {}
        with obs.scope(trace_id=obs.trace_id(), input_ref=obs.reference(payload.get('id') or message.get('id')),
                       platform_event_ref=obs.reference(message.get('id')),
                       group_ref=obs.reference(payload.get('group_openid')),
                       sender_ref=obs.reference(author.get('member_openid') or author.get('id'))):
            await self._handle_dispatch(ws, message)

    async def _handle_dispatch(self, ws, message):
        event_type = message.get('t')
        payload = message.get('d') or {}
        event_id = message.get('id')
        group_id = payload.get('group_openid')
        if bot_groups.valid_id(group_id) and event_type != 'INTERACTION_CREATE':
            # Group-wide events can be noisy; an @ or membership change always
            # refreshes discovery, ordinary messages at most once a minute.
            stamp = time.monotonic()
            important = event_type != 'GROUP_MESSAGE_CREATE' or mentions_bot(
                payload.get('mentions') or [], self.bot_id, payload.get('content'))
            if important or stamp - self.group_seen.get(group_id, -60) >= 60:
                self.group_seen[group_id] = stamp
                if len(self.group_seen) > 500:
                    self.group_seen.pop(next(iter(self.group_seen)))
                await asyncio.to_thread(self.record_group, group_id, event_type)
        if self.config.verbose_events:
            # INFO is the configured level. Never dump group text or identities.
            obs.event('platform_event', event_type=event_type, payload_fields=sorted(payload)[:40])
        if event_type == 'READY':
            self.session_id = payload.get('session_id') or self.session_id
            self.bot_id = (payload.get('user') or {}).get('id') or self.bot_id
            self.last_ready = time.time()
            self.write_health()
            obs.event('websocket_ready', session_ref=obs.reference(self.session_id),
                      bot_id_ref=obs.reference(self.bot_id))
            return
        if event_type == 'RESUMED':
            self.last_ready = time.time()
            self.write_health()
            obs.event('websocket_resumed')
            return
        if event_type == 'GROUP_ADD_ROBOT':
            obs.event('group_added')
            return
        if event_type == 'GROUP_DEL_ROBOT':
            obs.event('group_removed', level=logging.WARNING)
            return
        if event_type in ('GROUP_MSG_REJECT', 'GROUP_MSG_RECEIVE', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE'):
            obs.event('push_authorization_changed', event_type=event_type,
                      group_ref=obs.reference(payload.get('group_openid')))
            return
        if event_type == 'INTERACTION_CREATE':
            inner = payload.get('data') or {}
            interaction_type = payload.get('type', inner.get('type'))
            interaction_id = payload.get('id')
            if interaction_type not in (11, 12):
                # 18/19/20 are authorization events, not button callbacks.
                obs.event('interaction_authorization', interaction_type=interaction_type,
                          scene=payload.get('scene'), chat_type=payload.get('chat_type'))
                return
            if not self.remember_interaction(interaction_id):
                obs.event('interaction_ignored', reason='duplicate',
                          interaction_type=interaction_type)
                return
            # ACK within the platform's short callback window, before business work.
            try:
                await asyncio.to_thread(self.api.ack_interaction, interaction_id, 0)
            except Exception as exc:
                obs.event('interaction_ack_failed', level=logging.WARNING, **obs.error_fields(exc))
            obs.event('interaction_received', interaction_type=interaction_type,
                      scene=payload.get('scene'))
            await asyncio.to_thread(self.record_group, group_id, event_type)
            if not await asyncio.to_thread(self.reply_group_allowed, group_id):
                obs.event('message_ignored', reason='group_not_allowed')
                await asyncio.to_thread(self.record_group, group_id, reason='group_not_allowed')
                return
            resolved = inner.get('resolved') or {}
            command, argument = parse(resolved.get('button_data') or '')
            obs.event('command_parsed', source='button', command=command or 'unknown',
                      argument_ref=obs.reference(argument))
            # d.id is msg_id/interaction_id; the outer id is the reply event_id.
            await self.reply(ws, payload.get('group_openid'), command, argument,
                             event_id=event_id)
            return
        if event_type not in ('GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'):
            return
        mentions = payload.get('mentions') or []
        mentioned = mentions_bot(mentions, self.bot_id, payload.get('content'))
        everyone = ('missing' if 'mention_everyone' not in payload else
                    str(payload['mention_everyone']).lower() if type(payload['mention_everyone']) is bool else 'invalid')
        obs.event('message_received', event_type=event_type, mentions_bot=mentioned,
                  mention_everyone=everyone, mention_count=len(mentions) if isinstance(mentions,list) else None,
                  **union_diagnostics(payload.get('author') or {}, self.config))
        author = payload.get('author') or {}
        if author.get('bot'):
            obs.event('message_ignored', reason='bot_author')
            return
        addressed = event_type == 'GROUP_AT_MESSAGE_CREATE' or mentioned
        if not addressed:
            obs.event('message_ignored', reason='not_addressed')
            return
        if not await asyncio.to_thread(self.reply_group_allowed, group_id):
            obs.event('message_ignored', reason='group_not_allowed')
            await asyncio.to_thread(self.record_group, group_id, reason='group_not_allowed')
            return
        message_id = payload.get('id')
        content = str(payload.get('content') or '')
        fingerprint = '%s|%s|%s|%s' % (
            payload.get('group_openid') or '',
            author.get('id') or author.get('member_openid') or '',
            normalize_content(content),
            payload.get('timestamp') or message_id or '')
        if self.duplicate(message_id, fingerprint):
            obs.event('message_ignored', reason='duplicate', fingerprint_ref=obs.reference(fingerprint))
            await asyncio.to_thread(self.record_group, group_id, reason='duplicate')
            return
        command, argument = parse(content)
        obs.event('command_parsed', source='message', command=command or 'unknown',
                  argument_ref=obs.reference(argument), fingerprint_ref=obs.reference(fingerprint),
                  **obs.text_fields(content, self.config))
        await self.reply(ws, payload.get('group_openid'), command, argument,
                         msg_id=message_id)

    async def reply(self, ws, group_openid, command, argument, *, msg_id=None, event_id=None):
        with obs.scope(trace_id=obs.trace_id(), group_ref=obs.reference(group_openid),
                       command=command or 'unknown'):
            await self._reply(ws, group_openid, command, argument, msg_id=msg_id, event_id=event_id)

    async def _reply(self, ws, group_openid, command, argument, *, msg_id=None, event_id=None):
        group = group_openid
        started = time.monotonic()
        try:
            db = read_db(self.config.db)
            try:
                policy = bot_settings.read(db, worker=True)['config']
                if not bot_groups.reply_allowed(policy, group, self.config.group):
                    obs.event('reply_skipped', reason='group_not_allowed')
                    await asyncio.to_thread(self.record_group, group, reason='group_not_allowed')
                    return
                if not policy['replies_enabled']:
                    obs.event('reply_skipped', reason='replies_disabled')
                    await asyncio.to_thread(self.record_group, group, reason='replies_disabled')
                    return
                text, keyboard = answer(db, command, argument)
                markdown = _markdown_reply(db, command, argument, self.config)
            finally:
                db.close()
            if not markdown and md.has_unapproved_link(
                    text, getattr(self.config, 'allowed_link_hosts', ())):
                obs.event('reply_skipped', reason='unreported_link_host')
                return
            obs.event('reply_prepared', msg_type=2 if markdown else 0,
                      keyboard=bool(keyboard),
                      **obs.text_fields(markdown or text, self.config))
            dry_run = self.config.dry_run if policy['dry_run'] is None else policy['dry_run']
            if dry_run:
                obs.event('reply_simulated', sent=False, policy_dry_run=policy['dry_run'],
                          elapsed_ms=round((time.monotonic()-started)*1000))
                await asyncio.to_thread(self.record_group, group, reason='dry_run')
                return
            obs.event('reply_sending', mode='message' if msg_id else 'interaction', seq=1)
            kwargs = dict(msg_id=msg_id, event_id=event_id, seq=1, keyboard=keyboard)
            # Keep the legacy call signature byte-for-byte when Markdown is off.
            if markdown:
                kwargs['markdown'] = markdown
            ok, code, data = await asyncio.to_thread(
                self.api.reply_group, group, text, **kwargs)
            if not ok and markdown and type(code) is int and code in md.MARKDOWN_REJECTION_CODES:
                # Log only: auto-resending could duplicate a message the
                # platform actually accepted. Turn the opt-in off to recover.
                obs.event('reply_markdown_rejected', level=logging.WARNING, api_code=code)
            if not ok:
                obs.event('reply_failed', level=logging.WARNING, api_code=code if type(code) is int else None,
                          elapsed_ms=round((time.monotonic()-started)*1000))
            else:
                obs.event('reply_sent', sent_ref=obs.sent_reference(data),
                          elapsed_ms=round((time.monotonic()-started)*1000))
        except Exception as exc:
            obs.event('reply_failed', level=logging.ERROR, elapsed_ms=round((time.monotonic()-started)*1000),
                      **obs.error_fields(exc))

    async def heartbeat(self, ws, interval, state):
        """Cancel a stale heartbeat on reconnect; force a reconnect if ACKs stop."""
        wait = max(interval / 1000 * 0.9, 1)
        limit = max(interval / 1000 * 3, 120)
        try:
            while not self.stopping:
                await asyncio.sleep(wait)
                await ws.send(json.dumps({'op': 1, 'd': state['s']}))
                if self.last_ack and time.time() - self.last_ack > limit:
                    obs.event('heartbeat_ack_timeout', level=logging.WARNING,
                              seconds_since_ack=round(time.time() - self.last_ack))
                    await ws.close()
                    return
        except asyncio.CancelledError:
            return
        except Exception:
            return

    async def websocket_loop(self):
        ws_url = await asyncio.to_thread(self.api.gateway)
        obs.event('websocket_connecting', gateway_host=urlsplit(ws_url).hostname,
                  api_host=urlsplit(self.api.base).hostname)
        state = {'s': self.last_seq}
        connect = ws_connect()
        if self.heartbeat_task and not self.heartbeat_task.done():
            self.heartbeat_task.cancel()
        async with connect(ws_url, open_timeout=20, ping_interval=None) as ws:
            async for raw in ws:
                if self.stopping:
                    break
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    obs.event('platform_frame_invalid', level=logging.WARNING, reason='invalid_json')
                    continue
                if message.get('s') is not None:
                    state['s'] = message['s']
                    self.last_seq = message['s']
                op = message.get('op')
                if op == 10:
                    interval = (message.get('d') or {}).get('heartbeat_interval', 45000)
                    if self.session_id and self.last_seq is not None:
                        await ws.send(json.dumps({'op': 6, 'd': {
                            'token': self.api.auth(), 'session_id': self.session_id,
                            'seq': self.last_seq}}))
                        obs.event('websocket_resuming', session_ref=obs.reference(self.session_id))
                    else:
                        await ws.send(json.dumps({
                            'op': 2,
                            'd': {
                                'token': self.api.auth(),
                                'intents': self.config.intents,
                                'shard': [0, 1],
                                'properties': {'$os': 'linux', '$browser': 'qgroup-bot',
                                               '$device': 'qgroup-bot'},
                            },
                        }))
                        obs.event('websocket_identified', intents=self.config.intents)
                    self.heartbeat_task = asyncio.create_task(self.heartbeat(ws, interval, state))
                elif op == 11:
                    self.last_ack = time.time()
                    self.write_health()
                    obs.event('heartbeat_ack')
                elif op == 1:
                    # Server requesting an immediate heartbeat.
                    await ws.send(json.dumps({'op': 1, 'd': state['s']}))
                    obs.event('heartbeat_requested')
                elif op == 9:
                    # Official docs do not define d; drop the session and Identify.
                    self.session_id = None
                    self.last_seq = None
                    obs.event('websocket_invalid_session', level=logging.WARNING)
                    return
                elif op == 7:
                    obs.event('websocket_reconnect_requested')
                    return
                elif op == 0:
                    await self.handle_dispatch(ws, message)

    async def run(self):
        await self.refresh_policy()
        obs.event('bot_started', dry_run=self.resolved_dry_run,
                  deployment_dry_run=self.config.dry_run,
                  group_ref=obs.reference(self.config.group),
                  poll_interval=self.config.poll_interval, batch=self.config.batch)
        self.write_health()
        await self.sync_panels()
        asyncio.create_task(self.poll_loop())
        delay = 2
        while not self.stopping:
            try:
                await self.websocket_loop()
                delay = 2
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.reconnects += 1
                self.write_health()
                obs.event('websocket_disconnected', level=logging.WARNING, reconnect_in_seconds=delay,
                          reconnects=self.reconnects, **obs.error_fields(exc))
                if self.reconnects >= 3:
                    # Resume repeatedly failing: start with a fresh Identify.
                    self.session_id = None
                    self.last_seq = None
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


def main():
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)sZ %(levelname)s %(message)s')
    logging.Formatter.converter = time.gmtime
    config = Config()
    problems = config.validate()
    if problems:
        for problem in problems:
            print('設定錯誤：' + problem, file=sys.stderr)
        return 2
    obs.configure(config)
    try:
        ws_connect()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    bot = Bot(config)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, setattr, bot, 'stopping', True)
        except NotImplementedError:
            pass
    try:
        loop.run_until_complete(bot.run())
    except KeyboardInterrupt:
        pass
    finally:
        bot.stopping = True
        if bot.heartbeat_task:
            bot.heartbeat_task.cancel()
        obs.event('bot_stopping')
        loop.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
