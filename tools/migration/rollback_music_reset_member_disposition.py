"""Independent relation for retained, inactive persisted-only reset members.

No retained payload is inserted into the current member map. Exact original
snapshots and the identity image accompany the artifact; a reference to a
surviving credential is evidence, never a login or a deletion authority.
"""
import base64
import hashlib
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from tools.migration.rollback_history_runtime import _json, KEY
from tools.migration.rollback_music_reset import _encode
from tools.migration.rollback_music_identity_members import verify_identity_members

IDENTITY_TABLES = ('sessions', 'links', 'used_oauth', 'prelinks',
                   'login_attempts', 'link_overrides', 'link_audit',
                   'native_profiles', 'profile_contacts', 'entry_intents')


def _bytes(value):
    raw = base64.b64decode(value['bytes'], validate=True)
    if hashlib.sha256(raw).hexdigest() != value['sha256']:
        raise ValueError('Retained reset member source pin differs')
    return raw


def encode_retained_reset_members(raw, keys):
    """Writer extraction only; full source bytes stay alongside this encoding."""
    data = _json(raw)
    if not isinstance(data.get('members'), dict) or len(keys) > 100000 or any(not KEY.fullmatch(key) for key in keys):
        raise ValueError('Original reset member required')
    return [_encode(data['members'][key]) for key in keys]


def verify_reset_member_disposition(value):
    """Reopen original JSON/SQL and derive every candidate row independently."""
    music = _bytes(value['music']); identity = _bytes(value['identity'])
    projected = _bytes(value['projectedMusic']); erased = set(value['erased'])
    # This verifies the real Store result by direct SQL, without rerunning Store.
    verify_identity_members(music, identity, erased, projected)
    current = _json(projected)['members']
    source_resets = value['resets']; retained = value['retainedResets']
    if len(source_resets) != len(retained) or len(source_resets) > 1000:
        raise ValueError('Retained reset source inventory differs')
    lost = {}; unloaded = set(); previous = 0
    for source, saved in zip(source_resets, retained):
        if source != saved or type(source['sequence']) is not int or source['sequence'] <= previous:
            raise ValueError('Retained reset source bytes or order differ')
        previous = source['sequence']
        persisted_raw = _bytes(source['persisted']); loaded_raw = _bytes(source['loaded'])
        completion_raw = _bytes(source['completion'])
        persisted = _json(persisted_raw); loaded = _json(loaded_raw); completed = _json(completion_raw)
        for data in (persisted, loaded, completed):
            if not isinstance(data, dict) or not isinstance(data.get('members'), dict):
                raise ValueError('Original reset member container required')
        if completed['members']:
            raise ValueError('Original reset completion did not remove members')
        for key, member in persisted['members'].items():
            if not KEY.fullmatch(key):
                raise ValueError('Original persisted member key invalid')
            if key in loaded['members']:
                continue
            unloaded.add(key)
            if key in erased or key in current:
                continue
            # Data is retained in its original map slot. No identity row alone
            # is sufficient to restore this payload to current membership.
            encoded = _encode(member)
            lost.setdefault(key, []).append(dict(sequence=source['sequence'],
                member=dict(bytes=base64.b64encode(encoded).decode(), sha256=hashlib.sha256(encoded).hexdigest()),
                persistedSha256=source['persisted']['sha256'], loadedSha256=source['loaded']['sha256'],
                completionSourceSha256=source['completion']['sha256'],
                authorityRecordSha256=source['authorityRecordSha256'],
                completionSha256=source['completionSha256']))
    expected = []
    with tempfile.TemporaryDirectory(prefix='qgroup-reset-member-disposition-') as root:
        path = Path(root)/'identity.sqlite3'; path.write_bytes(identity); path.chmod(0o600)
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
            for key in sorted(lost):
                credentials = []
                for table in IDENTITY_TABLES:
                    columns = [row[1] for row in db.execute('PRAGMA table_xinfo("'+table+'")')]
                    if 'qq' in columns:
                        credentials.extend(dict(table=table, rowid=str(row[0])) for row in
                            db.execute('SELECT rowid FROM "'+table+'" WHERE qq=? ORDER BY rowid', (key,)))
                expected.append(dict(key=key, disposition='retained_history_only',
                    occurrences=lost[key], identityRows=credentials))
    # Compare encoded structures, retaining float/integer/negative-zero and
    # object/list order inside extracted members. Also require original bytes.
    if _encode(value['dispositions']) != _encode(expected):
        raise ValueError('Retained reset member disposition differs')
    if value['retainedIdentity'] != value['identity'] or value['retainedMusic'] != value['music']:
        raise ValueError('Original reset member identity or music bytes missing')
    return dict(version=1, authoritySha256=value['authoritySha256'], vaultManifestSha256=value['vaultManifestSha256'],
        checkpointSha256=value['checkpointSha256'], originalMusicSha256=value['music']['sha256'],
        originalIdentitySha256=value['identity']['sha256'], projectedMusicSha256=value['projectedMusic']['sha256'],
        unloadedResetKeys=sorted(unloaded), recoveredOrCurrentKeys=sorted(unloaded.intersection(current)),
        authorityErasedKeys=sorted(unloaded.intersection(erased)), retainedHistoryKeys=sorted(lost),
        retainedOccurrences=sum(len(rows) for rows in lost.values()),
        originalSourcesAndIdentityRetained=True, originalMemberValuesTypesAndOrderVerified=True,
        currentMembershipUnchanged=True, authenticationActive=False,
        nativeDispositionApplied=False, latestSourceAncestryVerified=False, releaseEligible=False)
