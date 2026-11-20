"""Pure generation-qualified source preparation; no service or file writes.

Callers retain the original source and bind the epoch to a verified completed
reset. This relation alone cannot prove that the latest source was captured
after that reset; stopped capture/custody and native reset replay remain gates.
"""
import copy
import hashlib
import json

from tools.migration.rollback_history_runtime import _json, _keys, SHA
from tools.migration.rollback_music_reset import LIMIT, _encode


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _id(kind, epoch, key):
    # The JSON tuple prevents delimiter ambiguity; Python retains Unicode and
    # number encodings in source rows, rather than a JS JSON round trip.
    return ('e_' if kind == 'entry' else 's_') + _sha(_encode(['qgroup-reset-generation-v1', kind, epoch, key]))[:40]


def _key(value):
    if not isinstance(value, str) or not value or len(value.encode('utf-16-le')) // 2 > 80:
        raise ValueError('Unsupported original generation key')
    return value


def _source(raw):
    if not isinstance(raw, bytes) or len(raw) > LIMIT:
        raise ValueError('Bound original generation source required')
    value = _json(raw)
    if not isinstance(value, dict) or not isinstance(value.get('entries'), dict) or not isinstance(value.get('members'), dict):
        raise ValueError('Original generation maps required')
    for kind in ('shouts', 'shoutHistory', 'trend'):
        if not isinstance(value.get(kind, []), list):
            raise ValueError('Original generation list required')
    return value


def _truthy(value):
    return isinstance(value, (list, dict)) or bool(value)


def _inventory(value, references):
    entries = list(value['entries']); historical = []; historical_seen = set(); shouts = []; shout_seen = set()
    if len(entries) > 100000 or len(value['members']) > 100000:
        raise ValueError('Original generation inventory exceeds capacity')
    for key, row in value['entries'].items():
        _key(key)
        if not isinstance(row, dict) or row.get('id') != key:
            raise ValueError('Original entry stable ID differs from key')
    if not isinstance(references, list):
        raise ValueError('Original JavaScript selection references required')
    by_reference = {}
    for ref in references:
        _keys(ref, ['memberKey', 'index', 'field', 'selectedKey'])
        if not isinstance(ref['memberKey'], str) or type(ref['index']) is not int or ref['index'] < 0 or (ref['memberKey'], ref['index']) in by_reference:
            raise ValueError('Original selection reference inventory differs')
        by_reference[(ref['memberKey'], ref['index'])] = ref
    reference_count = 0
    for member_key, member in value['members'].items():
        if not isinstance(member, dict):
            raise ValueError('Original generation member required')
        created = member.get('created', [])
        if not isinstance(created, list) or any(not isinstance(key, str) or key not in value['entries'] for key in created):
            raise ValueError('Original generation created reference unresolved')
        selection = member.get('selection', [])
        if not isinstance(selection, list):
            raise ValueError('Original generation selection list required')
        for index, item in enumerate(selection):
            ref = by_reference.get((member_key, index)); reference_count += 1
            if ref is None:
                raise ValueError('Original selection reference inventory differs')
            field = 'id' if isinstance(item, dict) and _truthy(item.get('id')) else 'entryId' if isinstance(item, dict) and _truthy(item.get('entryId')) else None
            if ref['memberKey'] != member_key or type(ref['index']) is not int or ref['index'] != index or ref['field'] != field or not isinstance(ref['selectedKey'], str) or not isinstance(item, (str, dict)) or isinstance(item, str) and ref['selectedKey'] != item or isinstance(item, dict) and field is None and ref['selectedKey'] != '':
                raise ValueError('Original selection reference binding differs')
            if ref['selectedKey'] and ref['selectedKey'] not in value['entries']:
                raise ValueError('Original generation selection reference unresolved')
    if reference_count != len(references):
        raise ValueError('Extra original selection reference')
    for row in value.get('trend', []):
        if not isinstance(row, dict) or not isinstance(row.get('counts'), dict):
            raise ValueError('Original generation trend counts required')
        for key in row['counts']:
            _key(key)
            if key not in value['entries'] and key not in historical_seen:
                historical.append(key); historical_seen.add(key)
    for kind in ('shouts', 'shoutHistory'):
        for row in value.get(kind, []):
            if not isinstance(row, dict):
                raise ValueError('Original generation shout required')
            key = row.get('id')
            if not isinstance(key, str) or not key:
                raise ValueError('Original generation shout ID required')
            key.encode('utf-16-le')
            if key in shout_seen:
                raise ValueError('Duplicate original generation shout ID')
            shouts.append(key); shout_seen.add(key)
    if len(entries) + len(historical) > 100000 or len(shouts) > 100000:
        raise ValueError('Original generation reference inventory exceeds capacity')
    return entries, historical, shouts


def _reserved(value):
    _keys(value, ['entries', 'shouts'])
    for ids in value.values():
        if not isinstance(ids, list) or len(ids) > 100000 or any(not isinstance(key, str) or not key for key in ids) or len(ids) != len(set(ids)):
            raise ValueError('Complete native generation reservations required')


def prepare_reset_generation_source(source_bytes, epoch, reserved, references):
    if not isinstance(epoch, str) or not SHA.fullmatch(epoch):
        raise ValueError('Verified reset epoch pin required')
    _reserved(reserved); source = _source(source_bytes); entries, historical, shouts = _inventory(source, references)
    entry_map = {key: _id('entry', epoch, key) for key in entries + historical}
    shout_map = {key: _id('shout', epoch, key) for key in shouts}
    if set(entry_map.values()) & set(reserved['entries']) or set(shout_map.values()) & set(reserved['shouts']):
        raise ValueError('Reset generation ID collides with reserved native ID')
    data = copy.deepcopy(source)
    data['entries'] = {entry_map[key]: dict(row, id=entry_map[key]) for key, row in data['entries'].items()}
    for member in data['members'].values():
        if 'created' in member:
            member['created'] = [entry_map[key] for key in member['created']]
    for ref in references:
        if not ref['selectedKey']:
            continue
        selection = data['members'][ref['memberKey']]['selection']
        if ref['field'] is None:
            selection[ref['index']] = entry_map[ref['selectedKey']]
        else:
            selection[ref['index']][ref['field']] = entry_map[ref['selectedKey']]
    for point in data.get('trend', []):
        point['counts'] = {entry_map[key]: count for key, count in point['counts'].items()}
    for kind in ('shouts', 'shoutHistory'):
        for row in data.get(kind, []):
            row['id'] = shout_map[row['id']]
    mapping = dict(entries=[dict(originalKey=key, derivedId=entry_map[key], catalog=key in source['entries']) for key in entries + historical],
                   shouts=[dict(originalKey=key, derivedId=shout_map[key]) for key in shouts])
    raw = _encode(data)
    if len(raw) > LIMIT:
        raise ValueError('Derived generation source exceeds capacity')
    return raw, mapping


def verify_reset_generation_source(source_bytes, epoch, reserved, references, derived_bytes, mapping):
    """Independent reverse relation and tuple-ID oracle, not producer replay."""
    if not isinstance(epoch, str) or not SHA.fullmatch(epoch):
        raise ValueError('Verified reset epoch pin required')
    _reserved(reserved); source = _source(source_bytes); derived = _source(derived_bytes); _keys(mapping, ['entries', 'shouts'])
    originals, historical, shouts = _inventory(source, references)
    if not isinstance(mapping['entries'], list) or not isinstance(mapping['shouts'], list):
        raise ValueError('Generation mapping lists required')
    backward = {}; shout_backward = {}
    for kind, expected, rows, inverse, prohibited in [('entry', originals + historical, mapping['entries'], backward, set(reserved['entries'])),
                                                     ('shout', shouts, mapping['shouts'], shout_backward, set(reserved['shouts']))]:
        if len(rows) != len(expected):
            raise ValueError('Original generation mapping inventory differs')
        for key, row in zip(expected, rows):
            _keys(row, ['originalKey', 'derivedId'] + (['catalog'] if kind == 'entry' else []))
            wanted = ('e_' if kind == 'entry' else 's_') + hashlib.sha256(
                (json.dumps(['qgroup-reset-generation-v1', kind, epoch, key], ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()).hexdigest()[:40]
            if row['originalKey'] != key or row['derivedId'] != wanted or wanted in inverse or wanted in prohibited or kind == 'entry' and row['catalog'] is not (key in source['entries']):
                raise ValueError('Original generation mapping or reservation differs')
            inverse[wanted] = key
    restored = copy.deepcopy(derived); original_entries = {}
    for key, row in restored['entries'].items():
        if key not in backward or row.get('id') != key or backward[key] not in source['entries']:
            raise ValueError('Derived generation catalog differs')
        original_entries[backward[key]] = dict(row, id=backward[key])
    restored['entries'] = original_entries
    for member in restored['members'].values():
        if not isinstance(member, dict):
            raise ValueError('Derived generation member differs')
        if 'created' in member:
            if not isinstance(member['created'], list) or any(key not in backward for key in member['created']):
                raise ValueError('Derived generation creation references differ')
            member['created'] = [backward[key] for key in member['created']]
    for ref in references:
        original = source['members'][ref['memberKey']]['selection'][ref['index']]
        selection = restored['members'][ref['memberKey']]['selection']
        item = selection[ref['index']]
        if not ref['selectedKey']:
            continue
        actual = item if ref['field'] is None else item.get(ref['field']) if isinstance(item, dict) else None
        if backward.get(actual) != ref['selectedKey']:
            raise ValueError('Derived generation selection reference differs')
        if ref['field'] is None:
            selection[ref['index']] = original
        else:
            item[ref['field']] = copy.deepcopy(original[ref['field']])
    for point in restored.get('trend', []):
        if not isinstance(point, dict) or not isinstance(point.get('counts'), dict) or any(key not in backward for key in point['counts']):
            raise ValueError('Derived generation trend references differ')
        point['counts'] = {backward[key]: value for key, value in point['counts'].items()}
    for kind in ('shouts', 'shoutHistory'):
        for row in restored.get(kind, []):
            if not isinstance(row, dict) or row.get('id') not in shout_backward:
                raise ValueError('Derived generation shout ID differs')
            row['id'] = shout_backward[row['id']]
    if _encode(restored) != _encode(source) or derived_bytes != _encode(derived):
        raise ValueError('Generation source content, order or Python encoding changed')
    # Check the forward references too: a raw original key left in a derived
    # selection must not pass merely because the reverse map leaves it alone.
    catalog = set(derived['entries'])
    for member in derived['members'].values():
        if any(key not in catalog for key in member.get('created', [])):
            raise ValueError('Derived generation creation uses an old key')
    return dict(originalSha256=_sha(source_bytes), derivedSha256=_sha(derived_bytes), mappingSha256=_sha(_encode(mapping)),
                catalogEntries=len(originals), historicalEntryReferences=len(historical), shouts=len(shouts),
                allKnownReferencesVerified=True, originalContentAndOrderRoundTripVerified=True,
                latestSourceAncestryVerified=False, resetGenerationsReconciled=False, releaseEligible=False)
