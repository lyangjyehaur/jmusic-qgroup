"""Thin QQ OpenAPI v2 client: token, gateway, messages, interaction ACK, panels."""
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import observability as obs

# 2026-08-10 changelog unified the API host; the older token host is kept as a
# fallback until the deployment confirms the new one end to end.
TOKEN_HOSTS = ('https://api.bot.qq.com', 'https://bots.qq.com')
FALLBACK_WSS = 'wss://api.bot.qq.com/websocket/'

ERROR_HINT = {
    40034105: '無主動訊息權限：請群主在「群內 bot 權限頁」開『機器人主動在群聊內發言』',
    40034100: '主動訊息超過頻控（60/30 qpm、單關係 20 qpm、每群每天 1000 條）',
    40034101: '機器人不是群成員',
    40054003: '機器人不是群成員',
    40054010: '不允許發送 URL：消息 URL 白名單未報備該網域',
    40054005: '訊息被去重，msg_seq 要遞增',
    40054002: '機器人被禁言',
    40034005: 'msg_id 已過期（被動回覆 5 分鐘內有效）',
    40034128: '被動回覆時間或次數超限（每則最多 5 次）',
    40054007: '訊息長度超限',
    40054016: '機器人已下線',
    40064004: '撤回逾時（僅 2 分鐘內可撤回）',
    304061: '訊息內容無效',
    304064: '訂閱訊息未授權',
    304031: '私信已關閉',
    1100104: '該群已失效或不存在',
    50055001: '平台側異常，稍後重試',
}

AUTH_CODES = frozenset({11241, 11242})
RATE_LIMIT_CODES = frozenset({40034100, 304049, 304050, 100001})
HARD_REJECT_CODES = frozenset({
    304061, 40054010, 40054007, 40054005, 40034005, 40034128, 40034024,
    100007, 100016, 10004,
})
AUTHORIZATION_CODES = frozenset({
    40034105, 40034101, 40054003, 40054016, 40054002, 304064, 304031, 1100104,
})


def hint(code):
    return ERROR_HINT.get(code, '請對照官方錯誤碼表')


def classify_error(code, status=200, data=None):
    """Separate a permanent refusal from a quota wait and a transport retry."""
    if isinstance(data, dict) and data.get('_unconfirmed_http'):
        return 'unconfirmed'
    if status == 429 or code in RATE_LIMIT_CODES:
        return 'rate_limit'
    if code in HARD_REJECT_CODES:
        return 'permanent'
    if code in AUTHORIZATION_CODES:
        # Needs a human (group owner / platform), but keep the bounded retry:
        # the current row must still reach a terminal state via the outbox.
        return 'authorization'
    return 'transient'


class QQBotAPI:
    def __init__(self, config):
        self.config = config
        # Callers constructing a bare config (tests, probes) keep the verified
        # legacy host; the deployed Config opts into the unified host.
        self.base = getattr(config, 'api_base', '') or (
            'https://sandbox.api.sgroup.qq.com' if config.sandbox
            else 'https://api.sgroup.qq.com')
        self.fallback_base = getattr(config, 'legacy_api_base', 'https://api.sgroup.qq.com')
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
                obs.set_platform_trace(response.headers.get('X-Tps-trace-ID'))
                try:
                    return response.status, json.loads(raw)
                except json.JSONDecodeError:
                    return response.status, {'raw': raw[:300]}
        except urllib.error.HTTPError as exc:
            obs.set_platform_trace(exc.headers.get('X-Tps-trace-ID') if exc.headers else None)
            raw = exc.read().decode('utf-8') or '{}'
            try:
                return exc.code, json.loads(raw)
            except json.JSONDecodeError:
                return exc.code, {'raw': raw[:300]}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            obs.set_platform_trace(None)
            return 0, {'error_type': type(exc).__name__}

    def token(self, force=False):
        with self._lock:
            if not force and self._token and time.time() < self._token_expiry:
                return self._token
            body = {'appId': self.config.app_id, 'clientSecret': self.config.app_secret}
            last = ''
            for host in TOKEN_HOSTS:
                status, data = self.http_json('POST', host + '/app/getAppAccessToken', body)
                if isinstance(data, dict) and data.get('access_token'):
                    self._token = data['access_token']
                    try:
                        lifetime = float(data.get('expires_in', 7200))
                    except (TypeError, ValueError):
                        lifetime = 7200.0
                    self._token_expiry = time.time() + max(lifetime - 120, 60)
                    obs.event('token_refreshed', expires_in_seconds=lifetime)
                    return self._token
                last = 'HTTP %s code=%s' % (status, obs.api_code(data))
                obs.event('token_refresh_failed', level=logging.WARNING, http_status=status,
                          api_code=obs.api_code(data), platform_trace=obs.platform_trace())
            raise RuntimeError('取得 access_token 失敗：%s' % last)

    def auth(self):
        return 'QQBot %s' % self.token()

    def gateway(self):
        """Resolve the working API host once; a failed new host falls back."""
        bases = [self.base] if self.base == self.fallback_base else [self.base, self.fallback_base]
        for base in bases:
            if not base:
                continue
            try:
                status, data = self.http_json('GET', base + '/gateway',
                                             None, {'Authorization': self.auth()})
                if isinstance(data, dict) and data.get('url'):
                    self.base = base
                    obs.event('gateway_resolved', api_host=urlsplit(base).hostname)
                    return data['url']
                obs.event('gateway_failed', level=logging.WARNING, http_status=status,
                          api_code=obs.api_code(data), api_host=urlsplit(base).hostname)
            except Exception as exc:
                obs.event('gateway_failed', level=logging.WARNING, **obs.error_fields(exc))
        self.base = self.fallback_base
        return FALLBACK_WSS

    def _result(self, method, path, payload, fields):
        status, data = self.http_json(method, self.base + path, payload,
                                     {'Authorization': self.auth()})
        code = obs.api_code(data)
        if isinstance(data, dict) and data.get('trace_id'):
            obs.set_platform_trace(data['trace_id'])
        malformed = (not isinstance(data, dict) or 'raw' in data or 'error_type' in data)
        unconfirmed = 200 <= status < 300 and status != 200
        ok = status == 200 and code in (None, 0) and not malformed and not unconfirmed
        if unconfirmed and isinstance(data, dict):
            # 201/202 mean an async result, not a delivered message. Never let
            # a retry turn that into a duplicate send.
            data = dict(data, _unconfirmed_http=status)
        elif status != 200 and isinstance(data, dict):
            data = dict(data, _http_status=status)
        return status, code, data, ok

    def post(self, path, payload):
        """Return (ok, code, data). Never raises on a business error."""
        with obs.scope(trace_id=obs.trace_id()):
            for attempt in (1, 2):
                started = time.monotonic()
                request_ref = obs.reference('%s:%s:%s' % (obs.trace_id(), attempt, time.monotonic_ns()))
                fields = dict(endpoint=obs.endpoint(path), method='POST', api_attempt=attempt,
                              request_ref=request_ref)
                obs.event('api_request', **fields)
                obs.set_platform_trace(None)
                try:
                    status, code, data, ok = self._result('POST', path, payload, fields)
                    obs.event('api_result', level=logging.INFO if ok else logging.WARNING,
                              **fields, http_status=status, api_code=code, ok=ok,
                              error_kind='ok' if ok else classify_error(code, status, data),
                              platform_trace=obs.platform_trace(),
                              sent_ref=obs.sent_reference(data),
                              transport_error=data.get('error_type') if status == 0 and isinstance(data, dict) else None,
                              elapsed_ms=round((time.monotonic()-started)*1000))
                except Exception as exc:
                    obs.event('api_exception', level=logging.ERROR, **fields, **obs.error_fields(exc),
                              elapsed_ms=round((time.monotonic()-started)*1000))
                    raise
                if attempt == 1 and (status == 401 or code in AUTH_CODES):
                    obs.event('api_auth_retry', http_status=status, api_code=code)
                    self.token(force=True)
                    continue
                return ok, code, data

    def put(self, path, payload):
        """Interaction callbacks need a fast PUT ACK, not a group message."""
        with obs.scope(trace_id=obs.trace_id()):
            started = time.monotonic()
            fields = dict(endpoint=obs.endpoint(path), method='PUT', api_attempt=1)
            obs.set_platform_trace(None)
            try:
                status, data = self.http_json('PUT', self.base + path, payload,
                                             {'Authorization': self.auth()})
                code = obs.api_code(data)
                ok = (status in (200, 204) and code in (None, 0)
                      and isinstance(data, dict) and 'raw' not in data)
            except Exception as exc:
                obs.event('api_exception', level=logging.ERROR, **fields, **obs.error_fields(exc))
                raise
            obs.event('interaction_ack', level=logging.INFO if ok else logging.WARNING,
                      **fields, ok=ok, http_status=status, api_code=code,
                      platform_trace=obs.platform_trace(),
                      elapsed_ms=round((time.monotonic()-started)*1000))
            return ok, code, data

    def ack_interaction(self, interaction_id, code=0):
        if not isinstance(interaction_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', interaction_id):
            obs.event('interaction_ack_skipped', reason='invalid_interaction_id')
            return False, None, {}
        return self.put('/interactions/%s' % interaction_id, {'code': code})

    def send_group(self, group_openid, payload):
        return self.post('/v2/groups/%s/messages' % group_openid, payload)

    def reply_group(self, group_openid, text, *, msg_id=None, event_id=None, seq=1,
                    keyboard=None, markdown=None):
        # QQ rejects a body carrying both fields: when markdown is present,
        # content must be absent (msg_type=2, custom markdown, no template).
        body = ({'msg_type': 2, 'markdown': {'content': markdown}} if markdown
                else {'msg_type': 0, 'content': text})
        if msg_id:
            body.update(msg_id=msg_id, msg_seq=seq)
        elif event_id:
            body['event_id'] = event_id
        if keyboard:
            body['keyboard'] = keyboard
        return self.send_group(group_openid, body)

    def setup_panels(self, commands, group_openid=''):
        """Group-scoped panel using the current schema: scope + panel.items."""
        try:
            status, data = self.http_json('GET', self.base + '/v2/panels?scope=group&limit=50',
                                         None, {'Authorization': self.auth()})
            records = data.get('records') if isinstance(data, dict) else None
            if isinstance(records, list) and any(
                    isinstance(item, dict) and item.get('scope') == 'group' for item in records):
                obs.event('panels_existing', count=len(records))
                return True
        except Exception as exc:
            obs.event('panels_query_failed', level=logging.WARNING, **obs.error_fields(exc))
        items = [{'type': 'command', 'name': item['name'], 'desc': item['desc']}
                 for item in commands[:20]]
        body = {'scope': 'group', 'panel': {'items': items}}
        if group_openid:
            body.update(target_type='specific', group_openids=[group_openid])
        ok, code, result = self.post('/v2/panels', body)
        obs.event('panels_result', level=logging.INFO if ok else logging.WARNING, ok=ok,
                  api_code=code, items=len(items),
                  panel_ref=obs.reference(result.get('panel_id')) if isinstance(result, dict) else None)
        return ok
