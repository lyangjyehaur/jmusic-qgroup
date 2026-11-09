"""Planned times never silently become actual activity transitions."""
from datetime import datetime, timedelta, timezone
from .common import now


def end_time(event):
    return datetime.fromisoformat(event['starts_at']) + timedelta(hours=event['duration_hours'] or 0)


def has_ended(event):
    return event['lifecycle'] == 'ended'


def phase(event):
    if event['lifecycle'] == 'scheduled' and event['starts_at'] <= now():
        return 'ongoing'
    return event['lifecycle']


def estimated_over(event):
    return event['lifecycle'] in ('scheduled','ongoing') and event['duration_hours'] is not None and end_time(event) <= datetime.now(timezone.utc)


def is_open(event):
    return (event['lifecycle']=='scheduled' and event['registration_open'] and not event['archived_at']
        and event['status']=='open' and event['deadline']>now() and event['starts_at']>now())
