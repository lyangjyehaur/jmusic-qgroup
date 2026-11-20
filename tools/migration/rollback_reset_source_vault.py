"""Explicit private retention of original reset sources before authority writes.

No automatic service/configuration activation or retention deletion. Captures
are separate from restore roots and remain private recovery evidence. External
custody, generation reconciliation and latest-erasure access are separate gates.
"""
import base64
from datetime import datetime, timezone
import hashlib
import inspect
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

from tools.migration.rollback_history_runtime import _directory, _file, _json, _keys, _timestamp, SHA
from tools.migration.rollback_music_reset import _encode, verify_legacy_music_reset_sources

LIMIT = 64 * 1024 * 1024
TOTAL = 128 * 1024 * 1024


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _pin(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('Invalid reset vault pin')


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _external_file(path, limit):
    # A child closing a raw descriptor cannot release this parent's live SQLite
    # POSIX locks, even if a malicious path swap makes the descriptor an alias.
    script = """import base64,json,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_history_runtime import _file
raw,identity=_file(sys.argv[2],int(sys.argv[3]))
print(json.dumps(dict(raw=base64.b64encode(raw).decode(),identity=identity)))
"""
    try:
        output = subprocess.run([sys.executable, '-I', '-c', script, str(Path(__file__).resolve().parents[2]), str(path), str(limit)],
                                check=True, capture_output=True, timeout=30).stdout
        if len(output) > limit * 2 + 4096:
            raise ValueError('Reset vault reader output exceeds limit')
        result = json.loads(output)
        return base64.b64decode(result['raw'], validate=True), tuple(result['identity'])
    except Exception:
        raise ValueError('Reset vault external file verification failed') from None


def _roots(authority, additional=()):
    return sorted({str(authority.root), *(str(path.parent) for path in authority.sources.values()),
                   *(str(path.parent) for path in authority.sqlite_files), *(str(Path(path)) for path in additional)})


def _isolated(root, roots):
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Canonical reset vault required')
    for name in roots:
        other = Path(name)
        if not other.is_absolute() or other.resolve() != other or root == other or root in other.parents or other in root.parents:
            raise ValueError('Reset vault must be outside authority and restore roots')


def _new_file(directory_fd, name, raw, guard):
    guard()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    # Only a newly created inode is opened here. Never open an existing file or
    # apply chmod/cleanup to a possible live SQLite/owner alias.
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise ValueError('Reset source write interrupted')
            view = view[count:]
        os.fsync(fd)
        held = os.fstat(fd)
        if not stat.S_ISREG(held.st_mode) or stat.S_IMODE(held.st_mode) != 0o600 or held.st_uid != os.getuid() or held.st_nlink != 1 or held.st_size != len(raw) or _identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)) != _identity(held):
            raise ValueError('New reset source inode changed')
        guard()
        return _identity(held)
    finally:
        os.close(fd)


def prepare_reset_source_vault(root, authority, *, restore_roots=(), now=None):
    """Exclusive initialization; return a manifest pin to retain independently."""
    from tools.migration.rollback_erasure_authority import ErasureAuthority
    if not isinstance(authority, ErasureAuthority):
        raise ValueError('Explicit original authority required')
    root = Path(root); roots = _roots(authority, restore_roots); _isolated(root, roots)
    parent = _directory(root.parent)
    with authority._held():
        manifest = authority._manifest()
        stamp = now or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        if not _timestamp(stamp):
            raise ValueError('Explicit reset vault creation time required')
        declaration = dict(version=1, kind='qgroup-private-legacy-reset-sources', vaultId=uuid.uuid4().hex,
                           authoritySha256=authority.pin, checkpointSha256=manifest['checkpointSha256'],
                           createdAt=stamp, protectedRoots=roots, releaseEligible=False)
        root.mkdir(mode=0o700)
        identity = _directory(root)
        def guard():
            if _directory(root.parent) != parent or _directory(root) != identity:
                raise ValueError('Reset vault initialization directory changed')
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            guard()
            if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != identity:
                raise ValueError('Reset vault initialization root changed before open')
            raw = _encode(declaration); _new_file(fd, 'vault-manifest.json', raw, guard); os.fsync(fd)
        finally:
            os.close(fd)
        parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd); guard()
        finally:
            os.close(parent_fd)
        return dict(root=str(root), manifestSha256=_sha(raw), releaseEligible=False)


class ResetSourceVault:
    def __init__(self, root, manifest_sha256, authority, *, fault_hook=None):
        from tools.migration.rollback_erasure_authority import ErasureAuthority
        if not isinstance(authority, ErasureAuthority):
            raise ValueError('Explicit original authority required')
        self.root = Path(root); _pin(manifest_sha256); self.pin = manifest_sha256; self.authority = authority
        self.parent = _directory(self.root.parent); self.identity = _directory(self.root)
        raw, self.header_identity = _external_file(self.root / 'vault-manifest.json', 16 * 1024)
        if _sha(raw) != self.pin:
            raise ValueError('Reset vault manifest pin differs')
        self.manifest = _manifest(raw, authority.pin, authority._manifest()['checkpointSha256'])
        self.fault_hook = fault_hook; self.snapshots = []; self._guard()

    def _guard(self):
        _isolated(self.root, self.manifest['protectedRoots'] + _roots(self.authority))
        if _directory(self.root.parent) != self.parent or _directory(self.root) != self.identity or _identity((self.root / 'vault-manifest.json').lstat()) != self.header_identity:
            raise ValueError('Reset vault declaration or directory changed')
        for path, identity, files in self.snapshots:
            _assert_snapshot(path, identity, files)

    def _budget(self, incoming):
        total = incoming; names = sorted(item.name for item in self.root.iterdir())
        captures = [name for name in names if name.startswith('capture-') and len(name) == 40 and all(c in '0123456789abcdef' for c in name[8:])]
        if names != sorted(['vault-manifest.json'] + captures) or len(captures) >= 1000:
            raise ValueError('Reset vault capture inventory differs or exceeds capacity')
        for name in captures:
            path = self.root / name; _directory(path)
            if sorted(item.name for item in path.iterdir()) != ['loaded.json', 'persisted.json', 'snapshot.json']:
                raise ValueError('Prior reset source capture is incomplete; retain for review')
            for file in ('persisted.json', 'loaded.json', 'snapshot.json'):
                info = (path / file).lstat()
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > (16 * 1024 if file == 'snapshot.json' else LIMIT):
                    raise ValueError('Prior reset source metadata differs')
                if file != 'snapshot.json':
                    total += info.st_size
        if total > TOTAL:
            raise ValueError('Reset source vault exceeds supported total size')

    def _fault(self, stage, path):
        if self.fault_hook:
            result = self.fault_hook(stage, path)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise ValueError('Reset source fault hook must be synchronous')

    def capture(self, operation, persisted, loaded):
        if not self.authority.depth:
            raise ValueError('Reset source capture requires held original authority')
        operation = _json(_encode(operation))
        verified = verify_legacy_music_reset_sources(operation, persisted, loaded)
        self._guard(); self._budget(len(persisted) + len(loaded)); head, _ = self.authority._read(finish_record=False)
        capture_id = uuid.uuid4().hex; name = 'capture-' + capture_id; path = self.root / name
        snapshot = dict(version=1, kind='qgroup-original-legacy-reset-snapshot', captureId=capture_id,
                        vaultSha256=self.pin, authoritySha256=self.authority.pin,
                        checkpointSha256=self.manifest['checkpointSha256'], sequence=head['sequence'] + 1,
                        previousRecordSha256=head['recordSha256'] or self.authority.pin,
                        operationSha256=_sha(_encode(operation)),
                        persisted=dict(size=len(persisted), sha256=verified['persistedSha256']),
                        loaded=dict(size=len(loaded), sha256=verified['loadedSha256']), releaseEligible=False)
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        directory_fd = None
        try:
            self._guard()
            if (os.fstat(root_fd).st_dev, os.fstat(root_fd).st_ino) != self.identity:
                raise ValueError('Reset vault root changed before capture')
            os.mkdir(name, mode=0o700, dir_fd=root_fd); identity = _directory(path); os.fsync(root_fd)
            directory_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            if (os.fstat(directory_fd).st_dev, os.fstat(directory_fd).st_ino) != identity:
                raise ValueError('Reset capture directory changed before open')
            def guard():
                self._guard()
                if _directory(path) != identity:
                    raise ValueError('Reset capture directory changed')
            files = {}
            for file, raw, stage in [('persisted.json', persisted, 'persisted'), ('loaded.json', loaded, 'loaded'), ('snapshot.json', _encode(snapshot), 'snapshot')]:
                self._fault('before_' + stage, path); files[file] = _new_file(directory_fd, file, raw, guard)
                os.fsync(directory_fd); os.fsync(root_fd)
                if stage == 'snapshot':
                    self.snapshots.append((path, identity, dict(files)))
                self._fault(stage + '_fsynced', path); guard()
            def assert_captured():
                guard()
                _assert_snapshot(path, identity, files)
            assert_captured()
            return dict(path=str(path), snapshotSha256=_sha(_encode(snapshot)), assertCaptured=assert_captured)
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
            os.close(root_fd)


def _assert_snapshot(path, identity, files):
    if _directory(path) != identity or sorted(item.name for item in path.iterdir()) != sorted(files):
        raise ValueError('Original reset capture inventory changed')
    for file, before in files.items():
        if _identity((path / file).lstat()) != before:
            raise ValueError('Original reset capture file changed')


def _manifest(raw, authority_pin, checkpoint_pin):
    value = _json(raw)
    _keys(value, ['version', 'kind', 'vaultId', 'authoritySha256', 'checkpointSha256', 'createdAt', 'protectedRoots', 'releaseEligible'])
    if type(value['version']) is not int or value['version'] != 1 or value['kind'] != 'qgroup-private-legacy-reset-sources' or not isinstance(value['vaultId'], str) or len(value['vaultId']) != 32 or any(c not in '0123456789abcdef' for c in value['vaultId']) or value['authoritySha256'] != authority_pin or value['checkpointSha256'] != checkpoint_pin or not _timestamp(value['createdAt']) or not isinstance(value['protectedRoots'], list) or value['protectedRoots'] != sorted(set(value['protectedRoots'])) or value['releaseEligible'] is not False or _encode(value) != raw:
        raise ValueError('Original reset vault declaration differs')
    for root in value['protectedRoots']:
        if not isinstance(root, str) or not Path(root).is_absolute() or Path(root).resolve() != Path(root):
            raise ValueError('Original reset vault protected root differs')
    return value


def _read_vault_offline(root, pin, view):
    """Internal isolated child reader. It opens no SQLite or service objects."""
    root = Path(root); _pin(pin); identity = _directory(root); parent = _directory(root.parent)
    header, header_identity = _file(root / 'vault-manifest.json', 16 * 1024)
    if _sha(header) != pin:
        raise ValueError('Original reset vault manifest pin differs')
    manifest = _manifest(header, view['authoritySha256'], view['checkpointSha256']); _isolated(root, manifest['protectedRoots'])
    names = sorted(item.name for item in root.iterdir())
    captures = [name for name in names if name.startswith('capture-') and len(name) == 40 and all(c in '0123456789abcdef' for c in name[8:])]
    if names != sorted(['vault-manifest.json'] + captures) or len(captures) > 1000:
        raise ValueError('Original reset vault inventory differs')
    wanted = {row['record']['sequence']: row for row in view['records'] if row['record']['version'] == 2}
    found = {}; retained = 0; total = 0; held = []
    for name in captures:
        folder = root / name; folder_identity = _directory(folder)
        if sorted(item.name for item in folder.iterdir()) != ['loaded.json', 'persisted.json', 'snapshot.json']:
            raise ValueError('Original reset source capture is incomplete')
        raw, saved = _file(folder / 'snapshot.json', 16 * 1024); snapshot = _json(raw)
        _keys(snapshot, ['version', 'kind', 'captureId', 'vaultSha256', 'authoritySha256', 'checkpointSha256', 'sequence', 'previousRecordSha256', 'operationSha256', 'persisted', 'loaded', 'releaseEligible'])
        if type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['kind'] != 'qgroup-original-legacy-reset-snapshot' or snapshot['captureId'] != name[8:] or snapshot['vaultSha256'] != pin or snapshot['authoritySha256'] != view['authoritySha256'] or snapshot['checkpointSha256'] != view['checkpointSha256'] or type(snapshot['sequence']) is not int or not 1 <= snapshot['sequence'] <= 100000 or snapshot['releaseEligible'] is not False or _encode(snapshot) != raw:
            raise ValueError('Original reset source capture binding differs')
        _pin(snapshot['previousRecordSha256']); _pin(snapshot['operationSha256']); data = {}
        for key in ('persisted', 'loaded'):
            descriptor = snapshot[key]; _keys(descriptor, ['size', 'sha256']); _pin(descriptor['sha256'])
            if type(descriptor['size']) is not int or not 0 <= descriptor['size'] <= LIMIT:
                raise ValueError('Original reset source size differs')
            total += descriptor['size']
            if total > TOTAL:
                raise ValueError('Original reset vault exceeds supported total size')
            value, file_identity = _file(folder / (key + '.json'), LIMIT)
            if len(value) != descriptor['size'] or _sha(value) != descriptor['sha256']:
                raise ValueError('Original reset source capture bytes differ')
            data[key] = value; held.append((folder / (key + '.json'), file_identity))
        held.append((folder / 'snapshot.json', saved)); held.append((folder, folder_identity))
        row = wanted.get(snapshot['sequence']); record = row['record'] if row else None
        if not record or snapshot['previousRecordSha256'] != record['previousRecordSha256'] or snapshot['operationSha256'] != _sha(_encode(record['operation'])):
            retained += 1; continue
        verify_legacy_music_reset_sources(record['operation'], data['persisted'], data['loaded'])
        if snapshot['sequence'] not in found:
            found[snapshot['sequence']] = dict(sequence=snapshot['sequence'], persisted=base64.b64encode(data['persisted']).decode(), loaded=base64.b64encode(data['loaded']).decode(), snapshotSha256=_sha(raw), captureId=snapshot['captureId'])
        else:
            retained += 1
    if set(found) != set(wanted):
        raise ValueError('Original reset vault is missing a recorded generation')
    if _directory(root) != identity or _directory(root.parent) != parent or _identity((root / 'vault-manifest.json').lstat()) != header_identity or sorted(item.name for item in root.iterdir()) != names:
        raise ValueError('Original reset vault changed during reading')
    for path, saved in held:
        if len(saved) == 2:
            if _directory(path) != saved or sorted(item.name for item in path.iterdir()) != ['loaded.json', 'persisted.json', 'snapshot.json']:
                raise ValueError('Original reset source capture directory changed')
        elif _identity(path.lstat()) != saved:
            raise ValueError('Original reset source capture changed during reading')
    return dict(version=1, vaultSha256=pin, authoritySha256=view['authoritySha256'], checkpointSha256=view['checkpointSha256'],
                sources=[found[key] for key in sorted(found)], unboundOrDuplicateCapturesRetained=retained,
                allRecordedResetSourcesPresent=True, externalRetentionVerified=False, releaseEligible=False)
