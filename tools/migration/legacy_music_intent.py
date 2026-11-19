"""Validate imported original music intents without creating user receipts."""
import datetime
import decimal
import hashlib
import json
import math
import re


def _number(value):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError('Invalid original music timestamp')
    if number == 0:
        return '0'
    if 1e-6 <= number < 1e21:
        result = format(decimal.Decimal(repr(number)), 'f')
        return result.rstrip('0').rstrip('.') if '.' in result else result
    mantissa, exponent = repr(number).lower().split('e')
    mantissa = mantissa.rstrip('0').rstrip('.') if '.' in mantissa else mantissa
    exponent = int(exponent)
    return mantissa + 'e' + ('+' if exponent >= 0 else '-') + str(abs(exponent))


def validate_imported_music(row):
    fields = {'version', 'kind', 'markerId', 'profileId', 'legacyKey', 'createdAt', 'originalErasedAtJson', 'origin'}
    if set(row) != fields or type(row['version']) is not int or row['version'] != 3 or row['kind'] != 'legacy_music':
        raise ValueError('Invalid imported music intent')
    if not isinstance(row['profileId'], str) or not re.fullmatch(r'm_(?:[a-f0-9]{32}|[a-f0-9]{40})', row['profileId']) or not isinstance(row['legacyKey'], str) or not re.fullmatch(r'(?:[0-9]{4,12}|m_[a-f0-9]{24})', row['legacyKey']):
        raise ValueError('Invalid imported music binding')
    origin = row['origin']
    if not isinstance(origin, dict) or set(origin) != {'authoritySha256', 'checkpointSha256', 'recordSequence', 'recordSha256', 'suffixSha256', 'rowIndex', 'sourceRebaseSha256'}:
        raise ValueError('Invalid imported music origin')
    for name in ['authoritySha256', 'checkpointSha256', 'recordSha256', 'suffixSha256', 'sourceRebaseSha256']:
        if name == 'sourceRebaseSha256' and origin[name] is None:
            continue
        if not isinstance(origin[name], str) or not re.fullmatch('[a-f0-9]{64}', origin[name]):
            raise ValueError('Invalid imported music source pin')
    for name, minimum in [('recordSequence', 1), ('rowIndex', 0)]:
        if type(origin[name]) is not int or not minimum <= origin[name] <= 9007199254740991:
            raise ValueError('Invalid imported music record position')
    raw = row['originalErasedAtJson']
    if not isinstance(raw, str) or not 1 <= len(raw) <= 128 or not isinstance(row['createdAt'], str):
        raise ValueError('Invalid imported music time')
    value = json.loads(raw)
    if isinstance(value, str):
        normalized = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        stamp = value
    elif type(value) in (int, float):
        normalized = _number(value)
        milliseconds = math.trunc(float(value) * 1000)
        if not 0 <= milliseconds < 253402300800000:
            raise ValueError('Invalid original music timestamp range')
        stamp = (datetime.datetime.fromtimestamp(milliseconds // 1000, datetime.timezone.utc) + datetime.timedelta(milliseconds=milliseconds % 1000)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    else:
        raise ValueError('Invalid imported music time')
    if raw != normalized or stamp != row['createdAt'] or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z', row['createdAt']):
        raise ValueError('Imported music time differs')
    datetime.datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00'))
    core = {key: row[key] for key in row if key != 'markerId'}
    encoded = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    marker = 'legacy-music:' + hashlib.sha256(b'qgroup:imported-legacy-music:v1:' + encoded).hexdigest()
    if row['markerId'] != marker:
        raise ValueError('Imported music marker differs')
    return marker
