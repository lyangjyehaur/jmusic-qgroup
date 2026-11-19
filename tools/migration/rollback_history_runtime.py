"""Explicit, read-only namespace adapter for an isolated fixed old music service.

The native product stays TypeScript. This optional rollback overlay does not
start services, initialize databases, import credentials, restore or deliver.
"""
from datetime import datetime
from contextlib import nullcontext
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
from urllib.parse import parse_qs, urlsplit

SHA = re.compile(r'[a-f0-9]{64}')
LEGACY = re.compile(r'[0-9]{8}-[0-9]{6}')
NATIVE = re.compile(r'[0-9]{8}-[0-9]{6}-[a-f0-9]{32}')
KEY = re.compile(r'(?:[0-9]{4,12}|m_[a-f0-9]{24})')
MAXIMUM = 512 * 1024 * 1024


def _timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z', value):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except ValueError:
        return False


def _json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result

    def integer(value):
        number = int(value)
        if abs(number) > 9007199254740991:
            raise ValueError('Unsafe JSON integer')
        return number

    def floating(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('Invalid JSON number')
        return number

    def constant(_):
        raise ValueError('Invalid JSON constant')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_int=integer, parse_float=floating, parse_constant=constant)


def _keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError('Unexpected catalog fields')


def _directory(path):
    path = Path(path)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or path.resolve() != path
            or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid()):
        raise ValueError('Catalog directory must be private and canonical')
    return info.st_dev, info.st_ino


def _file(path, maximum=MAXIMUM):
    path = Path(path)
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1 or before.st_uid != os.getuid()
            or before.st_size > maximum or path.resolve() != path):
        raise ValueError('Unsafe private catalog file')
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                             info.st_uid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        held = os.fstat(fd)
        if identity(held) != identity(before):
            raise ValueError('Catalog file changed before read')
        chunks, length = [], 0
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            chunks.append(block)
            length += len(block)
            if length > maximum:
                raise ValueError('Catalog file grew')
        if (length != held.st_size or identity(os.fstat(fd)) != identity(held)
                or identity(path.lstat()) != identity(held)):
            raise ValueError('Catalog file changed during read')
        return b''.join(chunks), identity(held)
    finally:
        os.close(fd)


class HistoryCatalog:
    def __init__(self, root, manifest_sha256):
        self.root = Path(root)
        if not self.root.is_absolute() or not SHA.fullmatch(manifest_sha256):
            raise ValueError('Explicit canonical catalog and external pin required')
        self.pin = manifest_sha256
        self.identity = _directory(self.root)
        self.folder_identity = _directory(self.root / 'histories')
        self.read()

    def read(self):
        if (_directory(self.root) != self.identity
                or _directory(self.root / 'histories') != self.folder_identity):
            raise ValueError('Catalog directory was replaced')
        if sorted(p.name for p in self.root.iterdir()) != sorted(
                ['history-catalog-manifest.json', 'histories', 'baseline-music.erasures.jsonl']):
            raise ValueError('Catalog root inventory differs')
        encoded, _ = _file(self.root / 'history-catalog-manifest.json', 16 * 1024 * 1024)
        if hashlib.sha256(encoded).hexdigest() != self.pin:
            raise ValueError('Catalog manifest pin differs')
        manifest = _json(encoded)
        _keys(manifest, ['version', 'kind', 'createdAt', 'sourcePackageSha256',
                         'checkpointSha256', 'journalSha256', 'baselineLedger',
                         'histories', 'rollbackEligible'])
        if (type(manifest['version']) is not int or manifest['version'] != 1
                or manifest['kind'] != 'qgroup-private-rollback-history-catalog'
                or manifest['rollbackEligible'] is not False
                or not _timestamp(manifest['createdAt'])
                or not all(isinstance(manifest[key], str) and SHA.fullmatch(manifest[key])
                           for key in ['sourcePackageSha256', 'checkpointSha256', 'journalSha256'])
                or not isinstance(manifest['histories'], list)):
            raise ValueError('Catalog metadata differs')
        rows, files = manifest['histories'], {}
        if [row.get('id') for row in rows] != sorted(set(row.get('id') for row in rows)):
            raise ValueError('Catalog IDs differ')
        for row in rows:
            _keys(row, ['id', 'source', 'sourceStamp', 'createdAt', 'schema', 'path', 'size', 'sha256'])
            prefix = {'legacy_pair': 'legacy-pair-', 'legacy_json': 'legacy-json-', 'native': 'native-'}.get(row['source'])
            pattern = NATIVE if row['source'] == 'native' else LEGACY
            if (not prefix or not isinstance(row['sourceStamp'], str)
                    or not pattern.fullmatch(row['sourceStamp'])
                    or row['id'] != prefix + row['sourceStamp']
                    or row['path'] != 'histories/' + row['id'] + '.json'
                    or (row['source'] != 'native' and (row['createdAt'] is not None or row['schema'] is not None))
                    or (row['source'] == 'native' and (not _timestamp(row['createdAt'])
                        or type(row['schema']) is not int or row['schema'] not in [13, 14, 15]))):
                raise ValueError('Catalog namespace differs')
        ledger = manifest['baselineLedger']
        _keys(ledger, ['path', 'size', 'sha256'])
        if ledger['path'] != 'baseline-music.erasures.jsonl':
            raise ValueError('Catalog ledger differs')
        identities = {}
        for row in [ledger] + rows:
            if (type(row['size']) is not int or not 0 <= row['size'] <= MAXIMUM
                    or not isinstance(row['sha256'], str) or not SHA.fullmatch(row['sha256'])):
                raise ValueError('Catalog descriptor differs')
            raw, identity = _file(self.root / row['path'], row['size'])
            if len(raw) != row['size'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('Catalog payload pin differs')
            files[row['path']] = raw
            identities[row['path']] = identity
        if sorted(p.name for p in (self.root / 'histories').iterdir()) != sorted(row['id'] + '.json' for row in rows):
            raise ValueError('Catalog history inventory differs')
        for row in [ledger] + rows:
            after, identity = _file(self.root / row['path'], row['size'])
            if after != files[row['path']] or identity != identities[row['path']]:
                raise ValueError('Catalog source changed')
        if (_directory(self.root) != self.identity or _directory(self.root / 'histories') != self.folder_identity):
            raise ValueError('Catalog source directory changed')
        return manifest, files


def _ledger(raw):
    if raw and not raw.endswith(b'\n'):
        raise ValueError('Incomplete current erasure ledger')
    erased = set()
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = _json(line)
        _keys(row, ['qq', 'erased_at'])
        if not isinstance(row['qq'], str) or not KEY.fullmatch(row['qq']):
            raise ValueError('Invalid current erasure key')
        erased.add(row['qq'])
    return erased


def _download(service, folder, data, baseline):
    current = service.upstream.data
    if not isinstance(current, dict) or not isinstance(current.get('members'), dict):
        raise ValueError('Current music authority missing')
    if not isinstance(data, dict) or not isinstance(data.get('members'), dict):
        raise ValueError('Historical music data invalid')
    path = folder / 'erasures.jsonl'
    raw, evidence = _file(path, 64 * 1024 * 1024)
    if not raw.startswith(baseline):
        raise ValueError('Original erasure ledger was lost or replaced')
    erased = _ledger(raw)
    service.administration.sanitize(data, erased)
    store_path = Path(service.STORE.path)
    before = store_path.lstat()
    if (not stat.S_ISREG(before.st_mode) or store_path.resolve() != store_path
            or before.st_nlink != 1):
        raise ValueError('Current identity authority missing')
    # mode=ro prevents silently creating a missing identity store. All identity
    # reads share one snapshot; no Store constructor, schema migration or writes.
    db = sqlite3.connect(store_path.as_uri() + '?mode=ro', uri=True, timeout=0)
    try:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        ownership = {}
        for table in ['link_overrides', 'prelinks', 'links']:
            for row in db.execute('SELECT qq,user_id FROM ' + table):
                ownership[row['qq']] = row['user_id']
        contacts = {row['qq']: row['number'] for row in db.execute('SELECT qq,number FROM profile_contacts')}
        for key, member in data['members'].items():
            if not isinstance(member, dict) or not KEY.fullmatch(key):
                raise ValueError('Historical member invalid')
            live = current['members'].get(key)
            if live is not None and not isinstance(live, dict):
                raise ValueError('Current member authority invalid')
            member['boardUserId'] = ownership.get(key, '') if live is not None else ''
            member['pinHash'] = live.get('pinHash', '') if live is not None else ''
            member['contactQQ'] = contacts.get(key, live.get('contactQQ', '')) if live is not None else ''
            if not all(isinstance(member[field], str) for field in ['boardUserId', 'pinHash', 'contactQQ']):
                raise ValueError('Current credential authority invalid')
        data.get('settings', {}).pop('adminPasswordHash', None)
        after = store_path.lstat()
        if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('Current identity store was replaced')
        latest, checked = _file(path, 64 * 1024 * 1024)
        if latest != raw or checked != evidence:
            raise ValueError('Current erasure ledger changed')
        return data
    finally:
        db.close()


def install_rollback_history_adapter(service, catalog_root, manifest_sha256, *, authority=None):
    """Explicit overlay installation; never changes source files or starts HTTP.

    The caller must independently certify and pin the overlay and old service
    versions before considering a candidate combination accepted or deployable.
    """
    if getattr(service.Handler, '_rollback_history_adapter_installed', False):
        raise ValueError('History adapter already installed')
    catalog = HistoryCatalog(catalog_root, manifest_sha256)
    folder = Path(service.upstream.DATA_FILE).parent
    if not folder.is_absolute() or folder.resolve() != folder:
        raise ValueError('Canonical isolated old music folder required')
    if catalog.root == folder or catalog.root in folder.parents or folder in catalog.root.parents:
        raise ValueError('History catalog and writable music folder must be isolated')
    initial_manifest, initial_files = catalog.read()
    baseline = initial_files[initial_manifest['baselineLedger']['path']]
    observed_ledger = [baseline]
    if authority is not None and authority.sources.get('music') != folder / 'erasures.jsonl':
        raise ValueError('Explicit history erasure authority source differs')

    def observe_ledger():
        raw, _ = _file(folder / 'erasures.jsonl', 64 * 1024 * 1024)
        if not raw.startswith(observed_ledger[0]):
            raise ValueError('Previously observed erasure ledger was lost')
        _ledger(raw)
        observed_ledger[0] = raw
        return raw

    observe_ledger()
    original = service.Handler.do_GET

    def do_get(self):
        parsed = urlsplit(self.path)
        if parsed.path not in ['/api/admin/backups', '/api/admin/backup']:
            return original(self)
        query = parse_qs(parsed.query, keep_blank_values=True)
        name = query.get('name', [''])[0]
        if parsed.path == '/api/admin/backup' and not name.startswith(('legacy-', 'native-')):
            return original(self)
        try:
            context = self.context()
            if not context.get('admin_actor'):
                raise service.Rejected('请先登录看板管理后台', 401)
            if (parsed.path.endswith('/backups') and query
                    or parsed.path.endswith('/backup') and (set(query) != {'name'} or len(query['name']) != 1)):
                raise service.Rejected('备份请求格式不正确', 400)
            with service.upstream._lock, (authority.guard('music') if authority is not None else nullcontext()):
                required_ledger = observe_ledger()
                manifest, files = catalog.read()
                rows = manifest['histories']
                if parsed.path.endswith('/backups'):
                    root = folder / 'paired-backups'
                    ordinary = [dict(name=p.name, size=(p / 'data.json').stat().st_size)
                                for p in sorted(root.iterdir(), reverse=True)
                                if LEGACY.fullmatch(p.name) and (p / 'data.json').is_file()] if root.exists() else []
                    return self.send_json({'backups': ordinary + [dict(name=row['id'], size=row['size'],
                        source=row['source'], sourceStamp=row['sourceStamp'], createdAt=row['createdAt'], schema=row['schema']) for row in rows]})
                row = next((row for row in rows if row['id'] == name), None)
                if row is None:
                    raise service.Rejected('备份不存在', 404)
                data = _download(service, folder, _json(files[row['path']]), required_ledger)
                catalog.read()
                return self.send_download('music-data-' + name + '.json', data)
        except service.Rejected as error:
            return self.send_json({'error': error.message}, error.status)
        except Exception:
            return self.send_json({'error': '历史备份或目前权限资料无法核对，已停止下载；请保全原始档并重新核对'}, 503)

    service.Handler.do_GET = do_get
    service.Handler._rollback_history_adapter_installed = True
    return catalog
