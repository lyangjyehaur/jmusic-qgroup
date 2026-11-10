"""Correlated JSON diagnostics, without credentials or chat text by default."""
import contextlib
import contextvars
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import traceback
from datetime import datetime, timezone
from urllib.parse import urlsplit
import uuid


LOGGER = logging.getLogger('qgroup_bot.events')
_CONTEXT = contextvars.ContextVar('bot_log_context', default={})
_PLATFORM_TRACE = contextvars.ContextVar('bot_platform_trace', default=None)


def set_platform_trace(value):
    """Keep Tencent's own trace id, never credentials or chat identifiers."""
    if (isinstance(value, str) and 0 < len(value) <= 128
            and re.fullmatch(r'[A-Za-z0-9._:-]+', value)):
        _PLATFORM_TRACE.set(value)
    else:
        _PLATFORM_TRACE.set(None)
    return _PLATFORM_TRACE.get()


def platform_trace():
    return _PLATFORM_TRACE.get()


def reference(value):
    """Stable opaque references let operators match events without raw IDs."""
    if value is None or value == '':
        return None
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()[:20]


def trace_id():
    return _CONTEXT.get().get('trace_id') or uuid.uuid4().hex


@contextlib.contextmanager
def scope(**fields):
    token = _CONTEXT.set({**_CONTEXT.get(), **fields})
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def event(name, *, level=logging.INFO, **fields):
    record = dict(_CONTEXT.get(), **fields)
    record.update(ts=datetime.now(timezone.utc).isoformat(timespec='milliseconds'), event=name)
    LOGGER.log(level, '%s', json.dumps(record, ensure_ascii=False, separators=(',', ':')))


def error_fields(exc):
    # Exception text, source lines and response bodies may contain credentials.
    return dict(error_type=type(exc).__name__,
                stack=['%s:%d:%s' % (Path(frame.filename).name, frame.lineno, frame.name)
                       for frame in traceback.extract_tb(exc.__traceback__)[-8:]])


def api_code(data):
    """OpenAPI failures use err_code; the token endpoint uses code.

    Both may arrive with HTTP 200. A non-zero value in either field is a
    business failure, and an unknown/empty structure is never a success.
    """
    if not isinstance(data, dict):
        return None
    values = [data.get(key) for key in ('code', 'err_code')]
    for value in values:
        if type(value) is int and value != 0:
            return value
    return 0 if any(type(value) is int for value in values) else None


def sent_reference(data):
    return reference(data.get('id')) if isinstance(data, dict) else None


def endpoint(url):
    path = urlsplit(url).path
    return re.sub(r'(/v2/(?:groups|users)/)[^/]+', r'\1:target', path)


def _preview(text, config):
    # Content mode is explicit and bounded; URLs never retain query credentials.
    for secret in (getattr(config, 'app_secret', ''),):
        if isinstance(secret, str) and secret:
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'https?://[^\s<>"\[\]{}]+', '[url]', text, flags=re.I)
    text = re.sub(r'<@!?[^>]*>|<qqbot-at-[^>]*>', '[mention]', text, flags=re.I)
    text = re.sub(r'(?i)(?:QQBot|Bearer)\s+[^\s,;]+', '[authorization]', text)
    text = re.sub(r'''(?i)((?:access_token|clientSecret|app_secret|password|authorization|'''
                  r'''invite_token|preview_token|account_link)["']?\s*[=:]\s*["']?)[^\s,;"']+''',
                  r'\1[redacted]', text)
    limit = getattr(config, 'log_content_limit', 500)
    limit = limit if type(limit) is int else 500
    return text[:max(80, min(limit, 2000))]


def text_fields(text, config):
    text = text if isinstance(text, str) else ''
    fields = dict(text_chars=len(text), text_hash=reference(text))
    if getattr(config, 'log_content', False) is True:
        fields['text_preview'] = _preview(text, config)
        fields['text_truncated'] = len(text) > getattr(config, 'log_content_limit', 500)
    return fields


class PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        fd = os.open(self.baseFilename, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        os.chmod(self.baseFilename, 0o600)
        return os.fdopen(fd, 'a', encoding='utf-8')


def configure(config):
    """JSON to Docker stdout and a bounded file on the persistent DB mount."""
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False
    for handler in list(LOGGER.handlers):
        LOGGER.removeHandler(handler)
        handler.close()
    stream = logging.StreamHandler()
    stream.setFormatter(logging.Formatter('%(message)s'))
    LOGGER.addHandler(stream)
    try:
        config.log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        file_handler = PrivateRotatingHandler(config.log_dir / 'bot-events.jsonl',
                                             maxBytes=5*1024*1024, backupCount=4, encoding='utf-8')
        file_handler.setFormatter(logging.Formatter('%(message)s'))
        LOGGER.addHandler(file_handler)
    except OSError as exc:
        event('log_storage_unavailable', level=logging.ERROR, **error_fields(exc))
    event('logging_ready', persistent=any(isinstance(h, PrivateRotatingHandler) for h in LOGGER.handlers),
          log_content=config.log_content, rotation_bytes=5*1024*1024, retained_files=5)
