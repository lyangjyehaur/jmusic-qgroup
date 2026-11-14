"""Versioned, authenticated, read-only projections for partner activity sites.

Keep this separate from the browser serializers: those contain viewer-specific
permissions, private links, notes and financial data. No writes or migrations.
"""
import hashlib
import hmac
import os
import re
from urllib.parse import parse_qs

from qgroup_core import lifecycle, rooms, roster, settlements
from qgroup_core.common import APIError

PREFIX = '/api/public/v1'
VISIBLE = "visibility='public' AND lifecycle!='draft' AND status!='deleted'"
ACTIVE = ('confirmed', 'waiting', 'tentative')
KEY_PATTERN = r'[A-Za-z0-9_-]{32,128}'


def authorize(headers):
    # Empty/malformed configuration disables the entire integration. Keep keys
    # outside source, SQLite and browser sessions. Multiple keys allow rotation.
    keys = [key.strip() for key in os.environ.get('KANBAN_PUBLIC_API_KEYS', '').split(',')]
    if not 1 <= len(keys) <= 20 or any(not re.fullmatch(KEY_PATTERN, key) for key in keys):
        raise APIError('Partner API is not configured', 503)
    values = headers.get_all('Authorization', [])
    match = re.fullmatch(r'Bearer[ \t]+(' + KEY_PATTERN + ')', values[0], re.I) if len(values) == 1 else None
    if not match:
        raise APIError('Valid API key required', 401)
    supplied = hashlib.sha256(match[1].encode('ascii')).digest()
    valid = False
    for key in keys:
        valid |= hmac.compare_digest(supplied, hashlib.sha256(key.encode('ascii')).digest())
    if not valid:
        raise APIError('Valid API key required', 401)


def query_values(raw, allowed):
    try:
        query = parse_qs(raw, keep_blank_values=True, max_num_fields=10)
    except ValueError:
        raise APIError('Invalid query parameters', 400)
    if set(query) - set(allowed) or any(len(values) != 1 for values in query.values()):
        raise APIError('Unknown or repeated query parameter', 400)
    return {key: values[0] for key, values in query.items()}


def number(query, key, default, minimum, maximum):
    value = query.get(key, str(default))
    if not re.fullmatch(r'[0-9]{1,9}', value) or not minimum <= int(value) <= maximum:
        raise APIError('Invalid ' + key, 400)
    return int(value)


def get_event(db, event_id):
    event = db.execute('SELECT * FROM events WHERE id=? AND ' + VISIBLE, (event_id,)).fetchone()
    if not event:
        # Identical for private/draft/deleted/missing, including for their owner.
        raise APIError('Public event not found', 404)
    return event


def summary(db, event):
    fields = ('id', 'title', 'category', 'location', 'starts_at', 'duration_hours',
              'timezone', 'deadline', 'capacity', 'minimum_participants', 'status',
              'lifecycle', 'formation_state', 'actual_started_at', 'actual_ended_at',
              'archived_at', 'revision', 'conditions_version', 'created_at')
    result = {key: event[key] for key in fields}
    counts = {row['status']: row['n'] for row in db.execute(
        'SELECT status,count(*) AS n FROM attendees WHERE event_id=? GROUP BY status', (event['id'],))}
    result.update(
        ends_at=lifecycle.end_time(event).isoformat(timespec='seconds') if event['duration_hours'] else None,
        phase=lifecycle.phase(event), estimated_over=lifecycle.estimated_over(event),
        registration_open=lifecycle.is_open(event),
        withdrawal_deadline=event['withdrawal_deadline'] or event['deadline'],
        counts={key: counts.get(key, 0) for key in ACTIVE},
        minimum_met=counts.get('confirmed', 0) >= event['minimum_participants'],
        remaining_capacity=max(0, event['capacity'] - counts.get('confirmed', 0)) if event['capacity'] else None,
        owner_name=db.execute('SELECT nickname FROM users WHERE id=?', (event['owner_id'],)).fetchone()[0],
        url='/?event=' + event['id'])
    return result


def identities(db, event_id):
    people = roster.rows(db, event_id)
    erased = {row[0] for row in db.execute('SELECT user_id FROM privacy_requests')}
    return people, {p['id']: p['user_id'] if p['user_id'] not in erased else None for p in people}


def participants(db, event):
    people, accounts = identities(db, event['id'])
    # Sort by the same confirmed/waiting/tentative grouping as the browser.
    people = sorted((p for p in people if p['status'] in ACTIVE), key=lambda p: ACTIVE.index(p['status']))
    return [dict(attendee_id=p['id'], user_id=accounts[p['id']], name=p['nickname'],
                 status=p['status'], confirmation_state=p['confirmation_state']) for p in people]


def room_assignments(db, event):
    people, accounts = identities(db, event['id'])
    current = {p['id']: p for p in people if p['status'] in ACTIVE}

    def project(source, members, name_key):
        result = []
        assigned = set()
        for room in source:
            ids = [uid for uid in room['person_ids'] if uid in members]
            assigned.update(ids)
            result.append(dict(id=room['id'], name=room['name'], attendee_ids=ids,
                members=[dict(attendee_id=uid, user_id=accounts.get(uid), name=members[uid][name_key]) for uid in ids]))
        return dict(rooms=result, unassigned_attendee_ids=[uid for uid in members if uid not in assigned])

    version = db.execute('SELECT MAX(version) FROM event_room_plans WHERE event_id=?', (event['id'],)).fetchone()[0]
    plan = dict(version=version or 0, **project(rooms.plan(db, event['id']), current, 'nickname'))
    settlement_version = settlements.latest_version(db, event['id'])
    detail = settlements.details(db, event['id'], settlement_version)
    actual = None
    if detail is not None:
        # Frozen names/people must survive later renaming and withdrawal. Never
        # pass the entire settlement through: it includes money and receipts.
        members = {p['id']: p for p in detail['people']}
        actual = dict(settlement_version=settlement_version,
                      **project(detail.get('rooms', []), members, 'name'))
    return dict(planned=plan, actual=actual)


def read(db, path, raw_query):
    if path == PREFIX:
        query_values(raw_query, ())
        return dict(api_version=1, endpoints=dict(events=PREFIX + '/events',
            event=PREFIX + '/events/{event_id}', participants=PREFIX + '/events/{event_id}/participants',
            rooms=PREFIX + '/events/{event_id}/rooms'),
            identity=dict(account='user_id', registration='attendee_id', unclaimed_guest_user_id=None),
            pagination=dict(default_limit=20, maximum_limit=100))
    if path == PREFIX + '/events':
        query = query_values(raw_query, ('limit', 'offset', 'lifecycle', 'status'))
        limit = number(query, 'limit', 20, 1, 100)
        offset = number(query, 'offset', 0, 0, 100000000)
        where, args = VISIBLE, []
        for key, allowed in (('lifecycle', ('scheduled', 'ongoing', 'ended', 'cancelled')),
                             ('status', ('open', 'closed', 'cancelled'))):
            if key in query:
                if query[key] not in allowed:
                    raise APIError('Invalid ' + key, 400)
                where += ' AND ' + key + '=?'
                args.append(query[key])
        total = db.execute('SELECT count(*) FROM events WHERE ' + where, args).fetchone()[0]
        found = db.execute('SELECT * FROM events WHERE ' + where + ' ORDER BY starts_at,id LIMIT ? OFFSET ?',
                           (*args, limit, offset)).fetchall()
        return dict(api_version=1, events=[summary(db, event) for event in found], total=total,
                    limit=limit, offset=offset, next_offset=offset + limit if offset + limit < total else None)
    match = re.fullmatch(re.escape(PREFIX) + r'/events/([a-f0-9]{16})(/participants|/rooms)?', path)
    if not match:
        raise APIError('Public API endpoint not found', 404)
    query_values(raw_query, ())
    event_id, suffix = match.groups()
    event = get_event(db, event_id)
    result = dict(api_version=1, event_id=event_id, revision=event['revision'])
    if suffix == '/participants':
        result['participants'] = participants(db, event)
    elif suffix == '/rooms':
        result.update(room_assignments(db, event))
    else:
        result['event'] = dict(summary(db, event), description=event['description'],
                               fee_policy=event['fee_policy'], cancellation_reason=event['cancellation_reason'])
        result['participants'] = participants(db, event)
        result['room_assignments'] = room_assignments(db, event)
    return result
