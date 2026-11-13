"""Full abbreviation results over QQ's five-reply passive-message window.

The page byte budget controls transport segmentation, never result length.
Pending masked output is kept on private local disk, not in the response cache.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

from . import observability as obs
from .abbreviation_text import AbbreviationText, mask_text
from .sensitive_words import load_mask

CONTINUE = re.compile(r'^(?:继续|繼續|下一页|下一頁)(?:\s+([0-9a-f]{24}))?$')
TTL = 3600
DEFAULT_PAGE_BYTES = 2000


@dataclass
class Page:
    text: str
    token: str = ''


class AbbreviationDelivery:
    def __init__(self, root, page_bytes=DEFAULT_PAGE_BYTES):
        self.root = Path(root)
        self.page_bytes = max(4, page_bytes)
        self.lock = threading.Lock()

    def _paths(self, token):
        if not re.fullmatch(r'[0-9a-f]{24}', token):
            raise ValueError('invalid continuation')
        return self.root / (token+'.json'), self.root / (token+'.txt')

    @staticmethod
    def _group(group):
        return hashlib.sha256(group.encode()).hexdigest()

    @staticmethod
    def _write(path, data):
        temporary = path.with_name(path.name+'.'+secrets.token_hex(6)+'.tmp')
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _save_meta(self, token, meta):
        self._write(self._paths(token)[0], json.dumps(meta).encode())

    def _body(self, token, meta):
        name = meta.get('body', token+'.txt')
        if not re.fullmatch(token+r'(?:\.[0-9a-f]{12})?\.txt', name):
            raise ValueError('invalid continuation body')
        return self.root / name

    def _cleanup(self):
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.root.chmod(0o700)
        for path in self.root.iterdir():
            if time.time()-path.stat().st_mtime > TTL:
                path.unlink(missing_ok=True)

    def _create(self, group, text):
        self._cleanup()
        token = secrets.token_hex(12)
        meta = dict(group=self._group(group), created=time.time(), offset=0,
                    budget=self.page_bytes, uncertain=False)
        if isinstance(text, AbbreviationText):
            meta['section_ends'] = text.section_ends()
        self._write(self._paths(token)[1], text.encode('utf-8'))
        self._save_meta(token, meta)
        return token, meta

    def _read(self, group, token):
        metadata, _ = self._paths(token)
        meta = json.loads(metadata.read_text())
        if meta['group'] != self._group(group) or time.time()-meta['created'] > TTL:
            raise ValueError('continuation unavailable')
        body = self._body(token, meta)
        with body.open('rb') as handle:
            handle.seek(meta['offset'])
            text = AbbreviationText.remaining(handle.read(), meta['offset'], meta.get('section_ends'))
        # Rule edits also apply to pending results; retain candidate delimiters.
        masked = mask_text(text, load_mask())
        if masked != text:
            # Publish the new body through one atomic metadata replacement.
            # A crash before that point leaves the old body/cursor intact.
            new_body = self.root / (token+'.'+secrets.token_hex(6)+'.txt')
            self._write(new_body, masked.encode('utf-8'))
            meta['offset'] = 0
            meta['body'] = new_body.name
            meta['section_ends'] = masked.section_ends()
            self._save_meta(token, meta)
            body.unlink(missing_ok=True)
        return meta, masked

    def continuation(self, group, argument):
        """None means an ordinary upstream query; Page never queries upstream."""
        argument = str(argument or '').strip()
        if not re.match(r'^(?:继续|繼續|下一页|下一頁)(?:\s|$)', argument):
            return None
        match = CONTINUE.fullmatch(argument)
        if not match or not match.group(1):
            return Page('请使用上一条回复提供的完整续读指令：/缩写 继续 编号。')
        token = match.group(1)
        with self.lock:
            try:
                _, text = self._read(group, token)
                return Page(text, token)
            except (OSError, ValueError, KeyError, TypeError):
                return Page('续读结果不存在、已过期或不属于本群，请重新查询缩写。')

    @staticmethod
    def _chunk(text, budget):
        return text.encode('utf-8')[:budget].decode('utf-8', errors='ignore') or text[:1]

    @staticmethod
    def _call(api, group, text, seq, kwargs):
        try:
            return api.reply_group(group, text, seq=seq, **kwargs)
        except Exception as exc:
            obs.event('abbreviation_send_unconfirmed', **obs.error_fields(exc))
            return False, None, {'uncertain': True}

    def send(self, api, group, page, *, msg_id=None, event_id=None):
        with self.lock:
            try:
                return self._send(api, group, page, msg_id=msg_id, event_id=event_id)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                obs.event('abbreviation_result_storage_failed', **obs.error_fields(exc))
                self._call(api, group, '暂时无法保存完整查询结果，请稍后重新查询。', 5,
                           dict(msg_id=msg_id, event_id=event_id))
                return False, None, {'storage_error': True}

    def _send(self, api, group, page, **kwargs):
        text, token, seq = page.text, page.token, 1
        if token:
            # Reload under the send lock: simultaneous continuation requests
            # must not replay an already acknowledged prefix.
            try:
                meta, text = self._read(group, token)
            except (OSError, ValueError, KeyError, TypeError):
                return self._call(api, group, '续读结果已过期，请重新查询缩写。', seq, kwargs)
        else:
            meta = None
            text = mask_text(text, load_mask())
        if not text:
            return self._call(api, group, '该查询结果已全部显示。', seq, kwargs)

        # Try the complete reply first. The public QQ endpoint does not state
        # a fixed plain-text length: split only after its explicit rejection.
        failure = None
        if not token:
            result = self._call(api, group, text, seq, kwargs)
            if result[0]:
                return result
            seq += 1
            failure = result
        if not token:
            token, meta = self._create(group, text)
        budget = meta['budget']
        if failure and failure[1] == 40054007:
            budget = min(budget, max(1, len(text.encode('utf-8'))//2))
            failure = None
        if failure:
            meta['uncertain'] = failure[1] in (None, 0)

        # Reserve the fifth call for a continuation/failure notice. Count
        # rejected attempts conservatively, and never retry an uncertain send.
        while text and seq <= 4 and failure is None and kwargs.get('msg_id'):
            chunk = self._chunk(text, budget)
            result = self._call(api, group, chunk, seq, kwargs)
            seq += 1
            if result[0]:
                consumed = len(chunk.encode('utf-8'))
                meta['offset'] += consumed
                meta['uncertain'] = False
                self._save_meta(token, meta)
                text = text[len(chunk):]
            elif result[1] == 40054007 and len(chunk) > 1:
                budget = max(1, budget//2)
            else:
                failure = result
                meta['uncertain'] = result[1] in (None, 0)
        meta['budget'] = budget
        self._save_meta(token, meta)
        if not text:
            self._body(token, meta).unlink(missing_ok=True)
            for path in self._paths(token):
                path.unlink(missing_ok=True)
            return True, 0, {}
        prefix = ('上一段发送结果未确认，未自动重发；续读可能重复该段。\n'
                  if meta['uncertain'] else
                  '部分内容发送失败，未跳过该段。\n' if failure else '')
        notice = prefix+'首次查询后1小时内，请 @机器人 续读：\n/缩写 继续 '+token
        notice_result = self._call(api, group, notice, seq, kwargs)
        obs.event('abbreviation_result_pending', remaining_bytes=len(text.encode('utf-8')),
                  uncertain=meta['uncertain'], notice_sent=notice_result[0])
        return (False, failure[1], failure[2]) if failure else notice_result
