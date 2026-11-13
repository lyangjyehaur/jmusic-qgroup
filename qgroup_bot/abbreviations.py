"""Read-only nbnhhsh lookup; no QQ credentials or chat context leave the bot."""
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict

from . import markdown as md
from . import observability as obs

API_URL = 'https://lab.magiconch.com/api/nbnhhsh/guess'
TIMEOUT = 4
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
        text = md.plain_text(value)
        # Community entries are untrusted: never relay links or @ mentions.
        if (not text or '@' in text or '＠' in text or '<' in text or '>' in text
                or re.search(r'https?://|www\.', text, re.IGNORECASE)):
            continue
        result.append(text)
    return result


def _render(data, terms):
    if not isinstance(data, list):
        raise ValueError('invalid response')
    entries = {}
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str):
            raise ValueError('invalid entry')
        name = item['name'].lower()
        if name in terms:
            entries[name] = item
    lines = ['【缩写查询】可能含义：']
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
        lines.append('%s%s：%s' % (term, label, '、'.join(values) if values else '暂无可显示的释义'))
    lines.append('来源：能不能好好说话；含义依语境而定。')
    return '\n'.join(lines)


class AbbreviationLookup:
    def __init__(self):
        self.cache = OrderedDict()
        self.lock = threading.Lock()
        self.next_request = 0

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
            cached = self.cache.get(key)
            if cached and cached[0] > current:
                self.cache.move_to_end(key)
                return cached[1]
            if current < self.next_request:
                return '缩写查询过于频繁，请稍后再试。'
            self.next_request = current + 1
            request = urllib.request.Request(API_URL,
                data=json.dumps({'text': key}).encode('utf-8'), method='POST',
                headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                         'User-Agent': 'qgroup-bot/nbnhhsh'})
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                    text = _render(json.load(response), terms)
            except (urllib.error.URLError, TimeoutError, OSError, ValueError,
                    http.client.HTTPException) as exc:
                obs.event('abbreviation_lookup_failed', error_type=type(exc).__name__)
                self.next_request = time.monotonic() + 10
                return UNAVAILABLE
            self.cache[key] = (time.monotonic() + 3600, text)
            self.cache.move_to_end(key)
            while len(self.cache) > 256:
                self.cache.popitem(last=False)
            return text
        finally:
            self.lock.release()


lookup = AbbreviationLookup()
