"""Missing old members recovered from the original identity image, read-only.

The writer invokes the original Store/contacts/admin projection on a temporary
copy. The verifier independently reads rows and derives every output field,
including JSON scalar types and order. No original file or credential is used.
"""
import copy
import hashlib
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from tools.migration.rollback_history_runtime import _json, KEY
from tools.migration.rollback_music_reset import _encode


class UnreconciledResetMembers(ValueError):
    pass


def _unloaded_scope(data, erased, unloaded):
    if len(unloaded) > 100000 or any(not KEY.fullmatch(key) for key in unloaded):
        raise ValueError('Invalid original unloaded member scope')
    # A mapping, session or contact row alone cannot recreate a lost profile.
    # Only a current member or the original Store's native payload covers it.
    if set(unloaded) - erased - set(data['members']):
        raise UnreconciledResetMembers('Original unloaded member scope requires reconciliation')


def _source(raw, erased):
    data = _json(raw)
    if not isinstance(data, dict) or not isinstance(data.get('members'), dict):
        raise ValueError('Original member source required')
    if len(data['members']) > 100000 or any(not KEY.fullmatch(key) for key in data['members']):
        raise ValueError('Original member keys required')
    if any(key in erased for key in data['members']):
        raise ValueError('Original erased member is present')
    return data


def _identity(path):
    db = sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def prepare_identity_members(raw, image, erased, unloaded=()):
    from music_site.identity_store import Store
    from music_site import contacts, admin_links
    data = _source(raw, erased)
    with tempfile.TemporaryDirectory(prefix='qgroup-identity-member-') as root:
        path = Path(root)/'identity.sqlite3'; path.write_bytes(image); path.chmod(0o600)
        store = Store(path)
        store.recover_profiles(data)
        contacts.project(data, store)
        admin_links.projection(data, store)
        result = _encode(data)
    verify_identity_members(raw, image, erased, result, unloaded)
    return result


def verify_identity_members(raw, image, erased, derived, unloaded=()):
    expected = copy.deepcopy(_source(raw, erased))
    before = list(expected['members'])
    with tempfile.TemporaryDirectory(prefix='qgroup-identity-member-verify-') as root:
        path = Path(root)/'identity.sqlite3'; path.write_bytes(image); path.chmod(0o600)
        with closing(_identity(path)) as db:
            for row in db.execute('SELECT qq,payload FROM native_profiles ORDER BY rowid'):
                key = row['qq']
                if not isinstance(key, str) or not KEY.fullmatch(key) or key in erased:
                    raise ValueError('Erased or invalid original native identity member')
                member = _json(row['payload'].encode())
                if not isinstance(member, dict) or member.get('qq') != key:
                    raise ValueError('Original identity member payload differs')
                if key not in expected['members']:
                    expected['members'][key] = member
            for row in db.execute('SELECT qq,number FROM profile_contacts ORDER BY rowid'):
                if row['qq'] in expected['members']:
                    expected['members'][row['qq']]['contactQQ'] = row['number']
            for table in ('link_overrides', 'prelinks', 'links'):
                for row in db.execute('SELECT qq,user_id FROM '+table+' ORDER BY rowid'):
                    if row['qq'] in expected['members']:
                        expected['members'][row['qq']]['boardUserId'] = row['user_id']
    if len(expected['members']) > 100000 or any(key in erased for key in expected['members']):
        raise ValueError('Original recovered member scope invalid')
    _unloaded_scope(expected, erased, unloaded)
    actual = _source(derived, erased)
    if _encode(actual) != _encode(expected) or derived != _encode(actual):
        raise ValueError('Original identity member reconstruction differs')
    digest = lambda value: hashlib.sha256(value).hexdigest()
    return dict(originalMusicSha256=digest(raw), originalIdentitySha256=digest(image),
                projectedMusicSha256=digest(derived), recoveredKeys=[key for key in expected['members'] if key not in before],
                unloadedResetKeys=sorted(set(unloaded) - erased), unloadedResetMembersCovered=True,
                originalValuesTypesAndOrderVerified=True, originalIdentityImageRetained=True,
                authenticationActive=False, latestSourceAncestryVerified=False, releaseEligible=False)
