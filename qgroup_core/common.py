"""Shared validation and UTC timestamps."""
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class APIError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def string(data, key, maximum, required=True):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise APIError('填写的内容格式不正确')
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise APIError('请检查填写内容的长度')
    return value


def date_value(data, key):
    try:
        value = datetime.fromisoformat(string(data, key, 40).replace('Z', '+00:00'))
        if value.tzinfo is None:
            raise ValueError()
        return value.astimezone(timezone.utc).isoformat(timespec='seconds')
    except (ValueError, OverflowError):
        raise APIError('请填写有效的活动时间')


