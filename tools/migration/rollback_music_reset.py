"""Versioned evidence of the original reset; this is not a restore projector.

Hashes refer to exact UTF-8 Python JSON bytes with a trailing newline. Scope
uses original map keys and list positions, including unknown item fields.
Source provenance and later generations must be verified before recovery.
"""
import hashlib
import json

from tools.migration.rollback_history_runtime import _json, _keys, KEY, SHA

LIMIT = 64 * 1024 * 1024


def _encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _pin(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('Invalid reset digest')


def validate_music_reset_operation(operation):
    _keys(operation, ['kind', 'source', 'loadedSha256', 'erasedAtJson', 'scope', 'loadedScope'])
    if operation['kind'] != 'legacy_music_reset':
        raise ValueError('Unsupported structured reset')
    _keys(operation['source'], ['size', 'sha256'])
    size = operation['source']['size']
    if type(size) is not int or not 0 <= size <= LIMIT:
        raise ValueError('Invalid reset source size')
    _pin(operation['source']['sha256']); _pin(operation['loadedSha256'])
    raw_time = operation['erasedAtJson']
    if not isinstance(raw_time, str) or len(raw_time) > 80:
        raise ValueError('Invalid reset time')
    time = _json(raw_time.encode())
    if type(time) not in (int, float) or not 0 <= time <= 8640000000000:
        raise ValueError('Invalid reset time')
    for scope in (operation['scope'], operation['loadedScope']):
        _validate_scope(scope)
    return operation


def _validate_scope(scope):
    _keys(scope, ['entries', 'members', 'shouts', 'shoutHistory', 'trend'])
    for name, rows in scope.items():
        if not isinstance(rows, list) or len(rows) > 100000:
            raise ValueError('Invalid reset scope')
        seen = set()
        for index, row in enumerate(rows):
            if name in ('entries', 'members'):
                _keys(row, ['key', 'sha256'])
                key = row['key']
                if not isinstance(key, str) or len(key.encode('utf-16-le')) // 2 > 1024 or key in seen or name == 'members' and not KEY.fullmatch(key):
                    raise ValueError('Invalid reset map scope')
                seen.add(key)
            else:
                _keys(row, ['index', 'sha256'])
                if type(row['index']) is not int or row['index'] != index:
                    raise ValueError('Invalid reset ordered scope')
            _pin(row['sha256'])


def validate_music_reset_suffix(operation, suffix):
    validate_music_reset_operation(operation)
    rows = [_json(line) for line in suffix.splitlines() if line.strip()]
    if [row['qq'] for row in rows] != [row['key'] for row in operation['loadedScope']['members']] or any(row['erased_at'] != _json(operation['erasedAtJson'].encode()) for row in rows):
        raise ValueError('Reset member ledger differs from structured scope')


def _capture_scope(value):
    if not isinstance(value, dict):
        raise ValueError('Original reset data required')
    scope = {}
    for name in ('entries', 'members'):
        rows = value.get(name, {})
        if not isinstance(rows, dict):
            raise ValueError('Original reset map required')
        scope[name] = [dict(key=key, sha256=_sha(_encode(row))) for key, row in rows.items()]
    for name in ('shouts', 'shoutHistory', 'trend'):
        rows = value.get(name, [])
        if not isinstance(rows, list):
            raise ValueError('Original reset list required')
        scope[name] = [dict(index=index, sha256=_sha(_encode(row))) for index, row in enumerate(rows)]
    return scope


def capture_legacy_music_reset(source_bytes, loaded, erased_at):
    if not isinstance(source_bytes, bytes) or len(source_bytes) > LIMIT:
        raise ValueError('Bound original reset source required')
    source_value = _json(source_bytes)
    loaded_bytes = _encode(loaded)
    if len(loaded_bytes) > LIMIT:
        raise ValueError('Oversized loaded reset source')
    # Original erase first uses the loaded members for identity erasure, then
    # reloads the persisted file and clears its containers. Neither scope may
    # be inferred from the other: they can differ even in the same process.
    return validate_music_reset_operation(dict(kind='legacy_music_reset',
        source=dict(size=len(source_bytes), sha256=_sha(source_bytes)),
        loadedSha256=_sha(loaded_bytes), erasedAtJson=_encode(erased_at).decode().strip(),
        scope=_capture_scope(source_value), loadedScope=_capture_scope(_json(loaded_bytes))))


def verify_legacy_music_reset_sources(operation, source_bytes, loaded_bytes):
    """Verify both original generations; no cleanup, reconstruction or file IO.

    Persisted bytes retain their original formatting. Loaded bytes are the exact
    Python snapshot encoded by the original producer, including 1.0 vs 1, float
    exponents, negative zero, unknown fields and map/list ordering. Neither
    generation may be substituted for the other even when member keys agree.
    """
    validate_music_reset_operation(operation)
    for raw in (source_bytes, loaded_bytes):
        if not isinstance(raw, bytes) or len(raw) > LIMIT:
            raise ValueError('Bound original reset source bytes required')
    if operation['source'] != dict(size=len(source_bytes), sha256=_sha(source_bytes)):
        raise ValueError('Original persisted reset source differs')
    if operation['loadedSha256'] != _sha(loaded_bytes):
        raise ValueError('Original loaded reset source differs')
    source, loaded = _json(source_bytes), _json(loaded_bytes)
    if loaded_bytes != _encode(loaded):
        raise ValueError('Original loaded reset encoding differs')
    if _capture_scope(source) != operation['scope'] or _capture_scope(loaded) != operation['loadedScope']:
        raise ValueError('Original reset container scope differs')
    return dict(version=1, persistedSha256=_sha(source_bytes), loadedSha256=_sha(loaded_bytes),
                persistedSize=len(source_bytes), loadedSize=len(loaded_bytes),
                persistedContainers={key: len(rows) for key, rows in operation['scope'].items()},
                loadedContainers={key: len(rows) for key, rows in operation['loadedScope'].items()},
                bothOriginalSourcesVerified=True, resetGenerationsReconciled=False,
                releaseEligible=False)
