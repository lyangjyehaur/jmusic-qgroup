"""Thin QQ OpenAPI v2 client: token, gateway, group messages, command panels."""
import json
import logging
import threading
import time
import urllib.error
import urllib.request

TOKEN_HOSTS = ('https://bots.qq.com', 'https://api.bot.qq.com')
FALLBACK_WSS = 'wss://api.bot.qq.com/websocket/'

ERROR_HINT = {
    40034105: '無主動訊息權限：請群主在「群內 bot 權限頁」開『機器人主動在群聊內發言』',
    40034100: '主動訊息超過頻控（60/30 qpm、單關係 20 qpm、每群每天 1000 條）',
    40034101: '機器人不是群成員',
    40054003: '機器人不是群成員',
    40054010: '不允許發送 URL：消息 URL 白名單未報備該網域',
    40034005: 'msg_id 已過期（被動回覆 5 分鐘內有效）',
    40034128: '被動回覆時間或次數超限（每則最多 5 次）',
    40054005: '訊息被去重，msg_seq 要遞增',
    40054007: '訊息長度超限',
    40054016: '機器人已下線',
    40064004: '撤回逾時（僅 2 分鐘內可撤回）',
    304061: '訊息內容無效',
    50055001: '平台側異常，稍後重試',
}


def hint(code):
    return ERROR_HINT.get(code, '請對照官方錯誤碼表')


class QQBotAPI:
    def __init__(self, config):
        self.config = config
        self.base = ('https://sandbox.api.sgroup.qq.com' if config.sandbox
                     else 'https://api.sgroup.qq.com')
        self._token = ''
        self._token_expiry = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def http_json(method, url, payload=None, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header('Content-Type', 'application/json')
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode('utf-8') or '{}'
                return response.status, json.loads(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode('utf-8') or '{}'
            try:
                return exc.code, json.loads(raw)
            except json.JSONDecodeError:
                return exc.code, {'raw': raw[:300]}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return 0, {'raw': str(exc)[:300]}

    def token(self, force=False):
        with self._lock:
            if not force and self._token and time.time() < self._token_expiry:
                return self._token
            body = {'appId': self.config.app_id, 'clientSecret': self.config.app_secret}
            last = ''
            for host in TOKEN_HOSTS:
                status, data = self.http_json('POST', host + '/app/getAppAccessToken', body)
                # Business errors also arrive as HTTP 200: always inspect body.
                if isinstance(data, dict) and data.get('access_token'):
                    self._token = data['access_token']
                    try:
                        lifetime = float(data.get('expires_in', 7200))
                    except (TypeError, ValueError):
                        lifetime = 7200.0
                    self._token_expiry = time.time() + max(lifetime - 120, 60)
                    logging.info('access_token 取得成功（有效 %.0f 秒）', lifetime)
                    return self._token
                last = '%s: HTTP %s %s' % (host, status, data)
            raise RuntimeError('取得 access_token 失敗：%s' % last)

    def auth(self):
        return 'QQBot %s' % self.token()

    def gateway(self):
        try:
            status, data = self.http_json('GET', self.base + '/gateway',
                                         None, {'Authorization': self.auth()})
            if isinstance(data, dict) and data.get('url'):
                return data['url']
            logging.warning('gateway 取得失敗 HTTP %s %s', status, data)
        except Exception as exc:
            logging.warning('gateway 例外：%s', exc)
        return FALLBACK_WSS

    def post(self, path, payload):
        """Return (ok, code, data). Never raises on a business error."""
        def call():
            return self.http_json('POST', self.base + path, payload,
                                  {'Authorization': self.auth()})
        status, data = call()
        if status == 401 or (isinstance(data, dict) and data.get('code') in (11241, 11242)):
            self.token(force=True)
            status, data = call()
        code = data.get('code') if isinstance(data, dict) else None
        ok = 200 <= status < 300 and code in (None, 0)
        if not ok:
            logging.warning('API %s 失敗 HTTP %s code=%s %s', path, status, code, hint(code))
        return ok, code, data

    def send_group(self, group_openid, payload):
        return self.post('/v2/groups/%s/messages' % group_openid, payload)

    def reply_group(self, group_openid, text, *, msg_id=None, event_id=None, seq=1,
                    keyboard=None):
        body = {'msg_type': 0, 'content': text}
        if msg_id:
            body.update(msg_id=msg_id, msg_seq=seq)
        elif event_id:
            body['event_id'] = event_id
        if keyboard:
            body['keyboard'] = keyboard
        return self.send_group(group_openid, body)

    def setup_panels(self, commands):
        """Best-effort command panel registration; a schema mismatch is not fatal."""
        status, data = self.http_json('GET', self.base + '/v2/panels',
                                      None, {'Authorization': self.auth()})
        if 200 <= status < 300 and isinstance(data, dict) and data.get('panels'):
            logging.info('指令面板已存在，略過建立')
            return True
        body = {
            'scene': 'group',
            'target_type': 'all',
            'name': '群聚看板',
            'desc': '活动查询常用指令',
            'elements': [{'name': item['name'], 'desc': item['desc']} for item in commands],
        }
        ok, code, data = self.post('/v2/panels', body)
        if not ok:
            logging.warning('指令面板建立失敗（不影響其他功能）：%s %s', code, data)
        return ok
