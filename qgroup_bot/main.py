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
import signal
import sys
import time

from .api import QQBotAPI
from .config import Config
from .replies import COMMANDS, answer, parse, read_db
from .worker import OutboxWorker


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


class Bot:
    def __init__(self, config):
        self.config = config
        self.api = QQBotAPI(config)
        self.worker = OutboxWorker(config, self.api)
        self.seen = {}          # message ids, 10 minutes
        self.seen_fp = {}       # event fingerprints, 30 seconds
        self.stopping = False

    def duplicate(self, message_id, fingerprint=''):
        """One @ can arrive as both GROUP_AT_MESSAGE_CREATE and
        GROUP_MESSAGE_CREATE, sometimes with different event ids. A short
        content fingerprint prevents answering the same utterance twice.
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

    async def poll_loop(self):
        while not self.stopping:
            try:
                result = await asyncio.to_thread(self.worker.poll_once)
                if result['claimed']:
                    logging.info('[poll] claimed=%d sent=%d skipped=%d failed=%d',
                                 result['claimed'], result['sent'],
                                 result['skipped'], result['failed'])
            except Exception as exc:
                logging.warning('[poll] outbox 輪詢失敗：%s', exc)
            await asyncio.sleep(self.config.poll_interval)

    async def handle_dispatch(self, ws, message):
        event_type = message.get('t')
        payload = message.get('d') or {}
        event_id = message.get('id')
        if self.config.verbose_events:
            logging.debug('[event] t=%s d=%s', event_type,
                          json.dumps(payload, ensure_ascii=False)[:400])
        if event_type == 'READY':
            logging.info('[ws] READY session=%s', payload.get('session_id'))
            return
        if event_type == 'GROUP_ADD_ROBOT':
            logging.info('[ws] 已加入群 %s…', str(payload.get('group_openid', ''))[:10])
            return
        if event_type == 'INTERACTION_CREATE':
            resolved = ((payload.get('data') or {}).get('resolved') or {})
            command, argument = parse(resolved.get('button_data') or '')
            await self.reply(ws, payload.get('group_openid'), command, argument,
                             event_id=event_id)
            return
        if event_type not in ('GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'):
            return
        author = payload.get('author') or {}
        if author.get('bot'):
            return
        mentions = payload.get('mentions') or []
        if event_type == 'GROUP_MESSAGE_CREATE' and not any(
                item.get('is_you') for item in mentions):
            return
        message_id = payload.get('id')
        content = str(payload.get('content') or '')
        fingerprint = '%s|%s|%s' % (
            payload.get('group_openid') or '',
            author.get('id') or author.get('member_openid') or '',
            content.strip())
        if self.duplicate(message_id, fingerprint):
            return
        command, argument = parse(content)
        # A bare @ is the quickest sign-up path: always answer with the board.
        await self.reply(ws, payload.get('group_openid'), command or '活动', argument,
                         msg_id=message_id)

    async def reply(self, ws, group_openid, command, argument, *, msg_id=None, event_id=None):
        group = group_openid or self.config.group
        if not group:
            return
        try:
            db = read_db(self.config.db)
            try:
                text, keyboard = answer(db, command, argument)
            finally:
                db.close()
            ok, code, _ = await asyncio.to_thread(
                self.api.reply_group, group, text,
                msg_id=msg_id, event_id=event_id, seq=1, keyboard=keyboard)
            if not ok:
                logging.warning('[reply] 失敗 code=%s', code)
        except Exception as exc:
            logging.exception('[reply] 處理指令失敗：%s', exc)

    async def websocket_loop(self):
        ws_url = await asyncio.to_thread(self.api.gateway)
        logging.info('[ws] 連線 %s', ws_url)
        state = {'s': None}
        connect = ws_connect()
        async with connect(ws_url, open_timeout=20, ping_interval=None) as ws:
            async for raw in ws:
                if self.stopping:
                    break
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get('s') is not None:
                    state['s'] = message['s']
                op = message.get('op')
                if op == 10:
                    interval = (message.get('d') or {}).get('heartbeat_interval', 45000)
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
                    logging.info('[ws] Identify 已送出（intents=%s）', self.config.intents)

                    async def heartbeat():
                        while not self.stopping:
                            await asyncio.sleep(max(interval / 1000 * 0.9, 1))
                            try:
                                await ws.send(json.dumps({'op': 1, 'd': state['s']}))
                            except Exception:
                                return

                    asyncio.create_task(heartbeat())
                elif op == 0:
                    await self.handle_dispatch(ws, message)
                elif op == 9:
                    logging.warning('[ws] Invalid Session，將重新 Identify')
                    return
                elif op == 7:
                    logging.warning('[ws] Reconnect 要求')
                    return

    async def run(self):
        logging.info('[bot] %s', self.config.describe())
        if self.config.setup_panels:
            try:
                await asyncio.to_thread(self.api.setup_panels, COMMANDS)
            except Exception as exc:
                logging.warning('[bot] 指令面板設定失敗（不影響运行）：%s', exc)
        asyncio.create_task(self.poll_loop())
        delay = 2
        while not self.stopping:
            try:
                await self.websocket_loop()
                delay = 2
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logging.warning('[ws] 連線中斷：%s，%d 秒後重連', exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


def main():
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    config = Config()
    problems = config.validate()
    if problems:
        for problem in problems:
            print('設定錯誤：' + problem, file=sys.stderr)
        return 2
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
        loop.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
