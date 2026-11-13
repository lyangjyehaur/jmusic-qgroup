"""Read-only nbnhhsh lookup; no QQ credentials or chat context leave the bot."""
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict

from . import observability as obs
from .sensitive_words import load_mask

API_URL = 'https://lab.magiconch.com/api/nbnhhsh/guess'
TIMEOUT = 4
CACHE_BYTES = 8*1024*1024
USAGE = ('用法：/缩写 yyds，也可用 /縮寫 或 /nbnhhsh。\n'
         '可用空格或逗号分隔，最多 5 个缩写；每个为 2–32 位英文字母或数字。\n'
         '仅将缩写发送到第三方「能不能好好说话」查询，候选含义仅供参考。')
UNAVAILABLE = '缩写查询服务暂时不可用，请稍后再试。'


def _terms(argument):
    text = str(argument or '').strip().lower()
    if not text or len(text) > 164:
        return None
    terms = list(dict.fromkeys(re.split(r'[\s,，、]+', text)))
    if not 1 <= len(terms) <= 5 or any(
            not re.fullmatch(r'[a-z0-9]{2,32}', term) for term in terms):
        return None
    return terms


def _values(values):
    if not isinstance(values, list):
        raise ValueError('invalid translation list')
    result = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError('invalid translation')
        text = re.sub(r'[\x00-\x1f\x7f]+', ' ', value).strip()
        # Community entries are untrusted: never relay links or @ mentions.
        if (not text or '@' in text or '＠' in text
                or re.search(r'<\s*/?\s*qqbot-at-', text, re.IGNORECASE)
                or re.search(r'https?://|www\.', text, re.IGNORECASE)):
            continue
        result.append(text)
    return result


def _render(data, terms):
    if not isinstance(data, list):
        raise ValueError('invalid response')
    mask = load_mask()
    entries = {}
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str):
            raise ValueError('invalid entry')
        name = item['name'].lower()
        if name in terms:
            entries[name] = item
    parts = ['【缩写查询】可能含义：', '\n']
    for term in terms:
        item = entries.get(term, {})
        translations = item.get('trans')
        if translations is not None:
            values = _values(translations)
            label = ''
        elif 'trans' not in item and item.get('inputting'):
            values = _values(item['inputting'])
            label = '（待确认候选）'
        else:
            values, label = [], ''
        parts.extend((term, label, '：'))
        for index, value in enumerate(values or ['暂无可显示的释义']):
            if index:
                parts.append('、')
            parts.append(value)
        parts.append('\n')
    parts.append('来源：能不能好好说话；含义依语境而定。')
    return mask.mask_parts(parts)


class AbbreviationLookup:
    def __init__(self, cache_bytes=CACHE_BYTES):
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.cache_budget = cache_bytes
        self.lock = threading.Lock()
        self.network_lock = threading.Lock()
        self.next_request = 0

    def _fetch(self, request):
        """Bound caller latency, including DNS and a continuously slow body.

        Only one daemon may fetch at a time. If the OS resolver/read outlives
        the deadline, it keeps its slot until exit; callers cannot pile up
        abandoned network threads. Late results never update the cache.
        """
        if not self.network_lock.acquire(blocking=False):
            raise TimeoutError('previous request still closing')
        done, outcome = threading.Event(), []
        timeout = TIMEOUT
        deadline = time.monotonic()+timeout

        def fetch():
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    chunks = []
                    read = getattr(response, 'read1', response.read)
                    while True:
                        if time.monotonic() >= deadline:
                            raise TimeoutError('upstream deadline')
                        chunk = read(65536)
                        if not chunk:
                            break
                        chunks.append(chunk)
                    outcome.append(b''.join(chunks))
            except Exception as exc:
                outcome.append(exc)
            finally:
                self.network_lock.release()
                done.set()

        threading.Thread(target=fetch, name='abbreviation-fetch', daemon=True).start()
        if not done.wait(max(0, deadline-time.monotonic())):
            raise TimeoutError('upstream deadline')
        if isinstance(outcome[0], Exception):
            raise outcome[0]
        return outcome[0]

    def _cache(self, key, raw):
        if len(raw) > self.cache_budget:
            return
        previous = self.cache.pop(key, None)
        if previous:
            self.cache_bytes -= len(previous[1])
        self.cache[key] = (time.monotonic()+3600, raw)
        self.cache_bytes += len(raw)
        while len(self.cache) > 256 or self.cache_bytes > self.cache_budget:
            _, (_, value) = self.cache.popitem(last=False)
            self.cache_bytes -= len(value)

    def answer(self, argument):
        terms = _terms(argument)
        if terms is None:
            return USAGE
        # Only one upstream request at a time; do not queue blocked workers.
        if not self.lock.acquire(blocking=False):
            return '缩写查询忙碌中，请稍后再试。'
        try:
            key = ','.join(terms)
            current = time.monotonic()
            for expired in [key for key, (until, _) in self.cache.items() if until <= current]:
                self.cache_bytes -= len(self.cache.pop(expired)[1])
            cached = self.cache.get(key)
            if cached and cached[0] > current:
                self.cache.move_to_end(key)
                try:
                    return _render(json.loads(cached[1]), terms)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    obs.event('abbreviation_lookup_failed', error_type=type(exc).__name__)
                    return UNAVAILABLE
            if current < self.next_request:
                return '缩写查询过于频繁，请稍后再试。'
            self.next_request = current + 1
            request = urllib.request.Request(API_URL,
                data=json.dumps({'text': key}).encode('utf-8'), method='POST',
                headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                         'User-Agent': 'qgroup-bot/nbnhhsh'})
            try:
                raw = self._fetch(request)
                data = json.loads(raw)
                text = _render(data, terms)
            except (urllib.error.URLError, TimeoutError, OSError, ValueError,
                    http.client.HTTPException, KeyError, TypeError) as exc:
                obs.event('abbreviation_lookup_failed', error_type=type(exc).__name__)
                self.next_request = time.monotonic() + 10
                return UNAVAILABLE
            self._cache(key, raw)
            return text
        finally:
            self.lock.release()


lookup = AbbreviationLookup()
