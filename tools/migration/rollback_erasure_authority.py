"""Explicit private write-ahead erasure authority for old-service rehearsals.

Keep this directory outside all database restore and backup-retention roots.
The external manifest pin binds its immutable baseline, not external custody.
No service, database, worker, credential or delivery is initialized here.
"""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import threading
import uuid

from tools.migration.rollback_history_runtime import _directory, _file, _json, _keys, _timestamp, SHA, KEY
from tools.migration.rollback_music_reset import validate_music_reset_operation, validate_music_reset_suffix

DOMAINS = ('board', 'music', 'unified')
LIMIT = 64 * 1024 * 1024


def _encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _descriptor(raw):
    return dict(size=len(raw), sha256=_sha(raw))


def _pin(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('Invalid authority pin')


def _count(value, maximum=LIMIT):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('Invalid authority count')


def _ledger(domain, raw, seen=None):
    if len(raw) > LIMIT or raw and not raw.endswith(b'\n'):
        raise ValueError('Incomplete or oversized authority ledger')
    if seen is None:
        seen = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = _json(line)
        if domain == 'music':
            _keys(row, ['qq', 'erased_at'])
            if not isinstance(row['qq'], str) or not KEY.fullmatch(row['qq']):
                raise ValueError('Invalid authority music key')
            continue
        if 'version' not in row:
            _keys(row, ['user_id', 'request_id', 'created_at'])
            if any(not isinstance(row[key], str) or not row[key] or len(row[key]) > maximum
                   for key, maximum in [('user_id', 128), ('request_id', 128), ('created_at', 80)]):
                raise ValueError('Invalid authority account intent')
            request = row['request_id']
        else:
            if domain == 'board':
                raise ValueError('Board authority requires original closure records')
            if type(row['version']) is not int or row['version'] not in (1, 2, 3):
                raise ValueError('Unsupported authority unified intent')
            if row['version'] == 3:
                from tools.migration.legacy_music_intent import validate_imported_music
                request = validate_imported_music(row)
            else:
                common = ['version', 'kind', 'requestId', 'createdAt', 'secretHash', 'signature']
                if row['version'] == 1:
                    _keys(row, common + ['userId', 'profileId'])
                    if row['kind'] not in ('account', 'music', 'both') or not isinstance(row['userId'], str) or not 1 <= len(row['userId']) <= 128:
                        raise ValueError('Invalid unified account intent')
                    if row['profileId'] is not None and (not isinstance(row['profileId'], str) or not 1 <= len(row['profileId']) <= 128):
                        raise ValueError('Invalid unified profile scope')
                    if row['kind'] != 'account' and row['profileId'] is None:
                        raise ValueError('Missing unified profile scope')
                else:
                    _keys(row, common + ['command', 'actorRef', 'profiles', 'entries'])
                    if row['kind'] != 'admin_music' or row['command'] not in ('delete_profile', 'reset_music') or not isinstance(row['actorRef'], str) or not 1 <= len(row['actorRef']) <= 128 or not isinstance(row['profiles'], list) or not isinstance(row['entries'], list):
                        raise ValueError('Invalid unified administration intent')
                    for profile in row['profiles']:
                        _keys(profile, ['id', 'userId'])
                        if not isinstance(profile['id'], str) or not 1 <= len(profile['id']) <= 128 or profile['userId'] is not None and (not isinstance(profile['userId'], str) or not 1 <= len(profile['userId']) <= 128):
                            raise ValueError('Invalid unified administration profile')
                    if any(not isinstance(entry, str) or not 1 <= len(entry) <= 128 for entry in row['entries']) or len(set(row['entries'])) != len(row['entries']) or len(set(p['id'] for p in row['profiles'])) != len(row['profiles']) or row['command'] == 'delete_profile' and (len(row['profiles']) != 1 or row['entries']):
                        raise ValueError('Invalid unified administration scope')
                if not isinstance(row['requestId'], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', row['requestId'], re.I) or not _timestamp(row['createdAt']):
                    raise ValueError('Invalid unified request identity')
                _pin(row['secretHash']); _pin(row['signature'])
                request = row['requestId']
        value = json.dumps(row, sort_keys=True, separators=(',', ':'))
        if request in seen and seen[request] != value:
            raise ValueError('Conflicting authority intent')
        seen[request] = value
    return seen


class ErasureAuthority:
    def __init__(self, root, manifest_sha256, sources=None, sqlite_files=(), fault_hook=None):
        self.root = Path(root)
        if not self.root.is_absolute() or self.root.resolve() != self.root:
            raise ValueError('Canonical private authority required')
        _pin(manifest_sha256)
        self.pin = manifest_sha256
        self.identity = _directory(self.root)
        self.folders = {name: _directory(self.root / name) for name in ('baseline', 'records')}
        self.sources = {domain: Path(path) for domain, path in (sources or {}).items()}
        self.source_parents = {}
        if not set(self.sources) <= set(DOMAINS) or len(set(self.sources.values())) != len(self.sources):
            raise ValueError('Invalid authority source binding')
        for domain, path in self.sources.items():
            if not path.is_absolute() or path.resolve() != path or self.root == path.parent or self.root in path.parents or path.parent in self.root.parents or not path.name.endswith('erasures.jsonl'):
                raise ValueError('Authority must be outside source restore roots')
            self.source_parents[domain] = _directory(path.parent)
        self.sqlite_identities = set()
        self.sqlite_files = set()
        self.register_sqlite_files(sqlite_files)
        self.mutex = threading.RLock()
        self.depth = 0
        self.fault_hook = fault_hook
        self.closed = False
        lock = self.root / '.authority.lock'
        self._read_file(lock, 0)
        self.lock_identity = (lock.lstat().st_dev, lock.lstat().st_ino)
        self.lock_fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
        try:
            held = os.fstat(self.lock_fd)
            if (held.st_dev, held.st_ino) != self.lock_identity:
                raise ValueError('Authority lock was replaced before open')
            self._manifest()
        except BaseException:
            os.close(self.lock_fd); self.closed = True
            raise

    def register_sqlite_files(self, paths):
        for path in paths:
            path = Path(path)
            if not path.is_absolute() or path.resolve() != path:
                raise ValueError('Canonical protected SQLite path required')
            self.sqlite_files.add(path)
        self._capture_sqlite_identities()

    def _capture_sqlite_identities(self):
        # Retain prior identities as well as newly observed replacement DBs and
        # sidecars. lstat does not acquire/release a raw SQLite descriptor.
        for path in self.sqlite_files:
            for suffix in ('', '-wal', '-shm', '-journal'):
                candidate = Path(str(path) + suffix)
                if candidate.exists():
                    info = candidate.lstat(); self.sqlite_identities.add((info.st_dev, info.st_ino))

    def _owned(self):
        if _directory(self.root) != self.identity or any(_directory(self.root / name) != value for name, value in self.folders.items()):
            raise ValueError('Authority directory was replaced')

    def _safe_file(self, path):
        self._capture_sqlite_identities()
        if path.exists():
            info = path.lstat()
            if (info.st_dev, info.st_ino) in self.sqlite_identities:
                raise ValueError('Authority file cannot alias a live SQLite inode')

    def _read_file(self, path, maximum=LIMIT):
        self._safe_file(path)
        return _file(path, maximum)

    def _manifest(self):
        raw, _ = self._read_file(self.root / 'authority-manifest.json', 16 * 1024 * 1024)
        if _sha(raw) != self.pin:
            raise ValueError('Authority manifest pin differs')
        value = _json(raw)
        _keys(value, ['version', 'kind', 'authorityId', 'createdAt', 'sourcePackageSha256', 'checkpointSha256', 'journalSha256', 'baseline', 'rollbackEligible'])
        if type(value['version']) is not int or value['version'] != 1 or value['kind'] != 'qgroup-private-erasure-authority' or not isinstance(value['authorityId'], str) or not re.fullmatch(r'[a-f0-9]{32}', value['authorityId']) or not _timestamp(value['createdAt']) or value['rollbackEligible'] is not False or not isinstance(value['baseline'], list) or len(value['baseline']) != 3 or _encode(value) != raw:
            raise ValueError('Invalid authority baseline manifest')
        for key in ('sourcePackageSha256', 'checkpointSha256', 'journalSha256'):
            _pin(value[key])
        for domain, row in zip(DOMAINS, value['baseline']):
            _keys(row, ['domain', 'path', 'size', 'sha256'])
            if row['domain'] != domain or row['path'] != 'baseline/' + domain + '.erasures.jsonl':
                raise ValueError('Authority baseline domain differs')
            _count(row['size']); _pin(row['sha256'])
        return value

    @contextmanager
    def _held(self):
        if self.closed or not self.mutex.acquire(blocking=False):
            raise ValueError('Authority is closed or busy')
        outer = self.depth == 0
        acquired = False
        try:
            self._owned()
            self._read_file(self.root / '.authority.lock', 0)
            info = (self.root / '.authority.lock').lstat(); held = os.fstat(self.lock_fd)
            if (info.st_dev, info.st_ino) != self.lock_identity or (held.st_dev, held.st_ino) != self.lock_identity:
                raise ValueError('Authority lock was replaced')
            if outer:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            self.depth += 1
            try:
                yield
                self._owned()
            finally:
                self.depth -= 1
        finally:
            if acquired:
                fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            self.mutex.release()

    def _write_new(self, path, raw):
        self._owned(); self._safe_file(path)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise ValueError('Authority write interrupted')
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        self._owned()

    def _sync(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _head(self, sequence, record_sha, ledgers):
        return dict(version=1, authoritySha256=self.pin, sequence=sequence, recordSha256=record_sha,
                    ledgers={domain: _descriptor(ledgers[domain]) for domain in DOMAINS})

    def _publish(self, value, previous_bytes, previous_identity):
        current, checked = self._read_file(self.root / 'authority-head.json', 4096)
        if current != previous_bytes or checked != previous_identity:
            raise ValueError('Authority head changed during publication')
        temporary = self.root / ('.head-' + uuid.uuid4().hex + '.tmp')
        self._write_new(temporary, _encode(value)); self._owned()
        current, checked = self._read_file(self.root / 'authority-head.json', 4096)
        if current != previous_bytes or checked != previous_identity:
            raise ValueError('Authority head changed before replacement')
        os.replace(temporary, self.root / 'authority-head.json'); self._sync(self.root); self._owned()

    def _read(self, finish_record=True):
        manifest = self._manifest()
        if sorted(p.name for p in self.root.iterdir()) != sorted(['.authority.lock', 'authority-head.json', 'authority-manifest.json', 'baseline', 'records']) or sorted(p.name for p in (self.root / 'baseline').iterdir()) != sorted(domain + '.erasures.jsonl' for domain in DOMAINS):
            raise ValueError('Authority root publication incomplete')
        head_bytes, head_identity = self._read_file(self.root / 'authority-head.json', 4096)
        head = _json(head_bytes)
        _keys(head, ['version', 'authoritySha256', 'sequence', 'recordSha256', 'ledgers'])
        _count(head['sequence'], 100000)
        if type(head['version']) is not int or head['version'] != 1 or head['authoritySha256'] != self.pin or (head['sequence'] == 0) != (head['recordSha256'] is None) or _encode(head) != head_bytes:
            raise ValueError('Invalid authority head')
        if head['recordSha256'] is not None:
            _pin(head['recordSha256'])
        _keys(head['ledgers'], DOMAINS)
        for value in head['ledgers'].values():
            _keys(value, ['size', 'sha256']); _count(value['size']); _pin(value['sha256'])
        ledgers, chunks, sizes, hashes, seen = {}, {}, {}, {}, {}
        for row in manifest['baseline']:
            raw, _ = self._read_file(self.root / row['path'])
            if _descriptor(raw) != dict(size=row['size'], sha256=row['sha256']):
                raise ValueError('Authority baseline changed')
            domain = row['domain']
            seen[domain] = _ledger(domain, raw); ledgers[domain] = raw
            chunks[domain] = [raw]; sizes[domain] = len(raw); hashes[domain] = hashlib.sha256(raw)
        names = sorted(p.name for p in (self.root / 'records').iterdir())
        count = len(names)
        if count not in (head['sequence'], head['sequence'] + 1) or count > 100000 or names != [f'{i:012}.json' for i in range(1, count + 1)] or count != head['sequence'] and not finish_record:
            raise ValueError('Authority record publication incomplete or lost')
        previous = self.pin
        reset_records = []
        if not head['sequence'] and head != self._head(0, None, ledgers):
            raise ValueError('Authority baseline head differs')
        for sequence, name in enumerate(names, 1):
            raw, _ = self._read_file(self.root / 'records' / name, 90 * 1024 * 1024)
            record = _json(raw)
            _keys(record, ['version', 'authoritySha256', 'sequence', 'previousRecordSha256', 'domain', 'suffixBase64', 'ledgerSize', 'ledgerSha256'] + (['operation'] if record.get('version') == 2 else []))
            if type(record['version']) is not int or record['version'] not in (1, 2) or type(record['sequence']) is not int or record['sequence'] != sequence or record['authoritySha256'] != self.pin or record['previousRecordSha256'] != previous or record['domain'] not in DOMAINS or not isinstance(record['suffixBase64'], str) or _encode(record) != raw:
                raise ValueError('Authority record chain differs')
            suffix = base64.b64decode(record['suffixBase64'], validate=True)
            if record['version'] == 1 and not suffix or base64.b64encode(suffix).decode() != record['suffixBase64']:
                raise ValueError('Invalid authority suffix')
            domain = record['domain']; sizes[domain] += len(suffix); hashes[domain].update(suffix)
            _count(record['ledgerSize']); _pin(record['ledgerSha256'])
            if dict(size=sizes[domain], sha256=hashes[domain].hexdigest()) != dict(size=record['ledgerSize'], sha256=record['ledgerSha256']):
                raise ValueError('Authority record payload differs')
            _ledger(domain, suffix, seen[domain])
            if record['version'] == 2:
                if domain != 'music':
                    raise ValueError('Reset authority domain differs')
                validate_music_reset_suffix(record['operation'], suffix)
                reset_records.append(dict(sequence=sequence, recordSha256=_sha(raw), operation=record['operation']))
            chunks[domain].append(suffix); previous = _sha(raw)
            expected_head = dict(version=1, authoritySha256=self.pin, sequence=sequence, recordSha256=previous,
                                 ledgers={key: dict(size=sizes[key], sha256=hashes[key].hexdigest()) for key in DOMAINS})
            if sequence == head['sequence'] and head != expected_head:
                raise ValueError('Authority head lost an intent')
        ledgers = {domain: b''.join(chunks[domain]) for domain in DOMAINS}
        if count != head['sequence']:
            head = self._head(count, previous, ledgers)
            self._publish(head, head_bytes, head_identity)
        self._music_reset_records = reset_records
        return head, ledgers

    def _source(self, domain):
        if domain not in self.sources or _directory(self.sources[domain].parent) != self.source_parents[domain]:
            raise ValueError('Authority source directory was replaced or unbound')
        path = self.sources[domain]
        if not path.exists() and not path.is_symlink():
            return None, None
        return self._read_file(path)

    def _source_write(self, domain, original, identity, suffix):
        path = self.sources[domain]
        after, checked = self._source(domain)
        if after != original or checked != identity:
            raise ValueError('Authority source changed before replay')
        self._safe_file(path)
        flags = os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW
        fd = os.open(path, flags | (os.O_CREAT | os.O_EXCL if original is None else 0), 0o600)
        try:
            held = os.fstat(fd)
            if identity is not None and (held.st_dev, held.st_ino) != identity[:2]:
                raise ValueError('Authority source inode was replaced')
            view = memoryview(suffix)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise ValueError('Authority source write interrupted')
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        self._sync(path.parent)
        if self._source(domain)[0] != (original or b'') + suffix:
            raise ValueError('Authority source replay differs')

    def _fault(self, stage):
        if self.fault_hook:
            result = self.fault_hook(stage)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise ValueError('Authority fault hook must be synchronous')

    def snapshot(self):
        with self._held():
            head, ledgers = self._read()
            return head, dict(ledgers)

    def music_reset_records(self):
        with self._held():
            self._read()
            return list(self._music_reset_records)

    @contextmanager
    def guard(self, domain):
        with self._held():
            _, ledgers = self._read()
            if domain == 'music' and self._music_reset_records:
                raise ValueError('Structured reset history requires source generation verification')
            original, identity = self._source(domain)
            if original != ledgers[domain]:
                raise ValueError('Latest authority intent absent from source')
            yield original
            after, checked = self._source(domain)
            if original != after or identity != checked:
                raise ValueError('Authority source changed during guarded read')

    def recover(self, domain):
        with self._held():
            _, ledgers = self._read()
            original, identity = self._source(domain)
            target = ledgers[domain]
            if not target.startswith(original or b''):
                raise ValueError('Source contains unrecorded or conflicting authority bytes')
            if original is None or original != target:
                self._source_write(domain, original, identity, target[len(original or b''):])
            return target

    def record(self, domain, suffix, *, operation=None):
        with self._held():
            head, ledgers = self._read()
            original, identity = self._source(domain)
            if original != ledgers[domain] or not isinstance(suffix, bytes):
                raise ValueError('Authority source must be recovered before recording')
            if operation is not None:
                if domain != 'music':
                    raise ValueError('Reset authority domain differs')
                operation = _json(_encode(operation))
                validate_music_reset_operation(operation)
                _ledger(domain, suffix)
                validate_music_reset_suffix(operation, suffix)
            if not suffix and operation is None:
                return
            combined = original + suffix
            _ledger(domain, combined)
            sequence = head['sequence'] + 1
            _count(sequence, 100000)
            head_bytes, head_identity = self._read_file(self.root / 'authority-head.json', 4096)
            if head_bytes != _encode(head):
                raise ValueError('Authority head changed before recording')
            record = dict(version=2 if operation is not None else 1, authoritySha256=self.pin, sequence=sequence,
                          previousRecordSha256=head['recordSha256'] or self.pin, domain=domain,
                          suffixBase64=base64.b64encode(suffix).decode(), ledgerSize=len(combined), ledgerSha256=_sha(combined))
            if operation is not None:
                record['operation'] = operation
            raw = _encode(record)
            if len(raw) > 90 * 1024 * 1024:
                raise ValueError('Authority record exceeds limit')
            self._write_new(self.root / 'records' / f'{sequence:012}.json', raw)
            self._sync(self.root / 'records'); self._fault('record_fsynced')
            ledgers[domain] = combined
            self._publish(self._head(sequence, _sha(raw), ledgers), head_bytes, head_identity)
            self._fault('head_published'); self._fault('before_source')
            self._source_write(domain, original, identity, suffix); self._fault('source_fsynced')
            return dict(sequence=sequence, recordSha256=_sha(raw))

    def close(self):
        if not self.mutex.acquire(blocking=False):
            raise ValueError('Authority is still in use')
        try:
            if self.depth:
                raise ValueError('Authority is still held')
            if not self.closed:
                os.close(self.lock_fd); self.closed = True
        finally:
            self.mutex.release()
