"""QQ group bot outbox.

Design contract (see README and docs/implementation-plan.md):

* A broadcast row is written by ``audit.notify`` / ``audit.append`` inside the
  *same* transaction as the business write. No HTTP call, no separate commit.
* ``INSERT OR IGNORE`` plus a content-derived dedupe key means "the same fact
  is announced once"; it is de-duplication, not a rate limit.
* Only de-identified text is queued. Personal notifications, nicknames and
  individual amounts never reach a group unless an operator explicitly opts in.
* Sending is a separate long-running process. A send failure never rolls back
  a registration, a settlement or an audit entry.

Nothing here imports ``server``. Queueing requires the shared notification
policy (initially KANBAN_BOT_ENABLED) and the owner's group-sharing opt-in.
"""
import hashlib
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from .common import now, APIError
from . import bot_views, bot_settings, bot_groups

# Broadcast kinds are chosen by "the whole group needs to know or act",
# not by a per-event message quota. Operators may extend or shrink the set.
DEFAULT_BROADCAST = frozenset({
    'activity_published', 'formation_confirmed', 'conditions_changed',
    'event_started', 'event_finished', 'event_cancelled',
    'settlement_updated', 'deadline_reminder', 'estimated_over_reminder',
    'registration_paused', 'registration_resumed', 'finance_closed', 'finance_reopened',
    'ownership_changed',
})

# notify() kinds already produced by append() for the same state transition.
# Letting both enqueue would be harmless (dedupe ignores the duplicate), but
# keeping one owner per kind makes the mapping auditable.
NOTIFY_OWNED = frozenset({'conditions_changed', 'settlement_updated'})

APPEND_ACTIONS = {
    'event_created': 'activity_published',
    'event_publish': 'activity_published',
    'event_formation': 'formation_confirmed',
    'event_start': 'event_started',
    'event_finish': 'event_finished',
    'event_cancel': 'event_cancelled',
    'settlement_saved': 'settlement_updated',
    'event_pause': 'registration_paused',
    'event_resume': 'registration_resumed',
    'finance_close': 'finance_closed',
    'finance_reopen': 'finance_reopened',
    'ownership_transferred': 'ownership_changed',
}

# Point-at-a-person notifications. They are NOT banned from the bot: they are
# queued on the private channel when KANBAN_BOT_PERSONAL_QUEUE=1, with the
# name stripped out, and stay unbound until an identity mapping exists.
PERSONAL_KINDS = frozenset({
    'promoted', 'withdrawal_request', 'withdrawal_decision', 'removed',
    'claim_requested', 'claim_decided', 'conditions_declined',
    'finance_updated', 'ownership_transferred', 'cohost_accepted',
    'cohost_removed',
})


def enabled(db=None):
    if db is not None:
        return bot_settings.read(db)['config']['enabled']
    return os.environ.get('KANBAN_BOT_ENABLED', '0') == '1'


def broadcast_kinds(db=None):
    if db is not None:
        return frozenset(bot_settings.read(db)['config']['broadcast_kinds'])
    raw = os.environ.get('KANBAN_BOT_BROADCAST_KINDS', '').strip()
    return frozenset(x.strip() for x in raw.split(',') if x.strip()) if raw else DEFAULT_BROADCAST


def personal_queue():
    return os.environ.get('KANBAN_BOT_PERSONAL_QUEUE', '0') == '1'


def settlement_detail():
    return os.environ.get('KANBAN_BOT_SETTLEMENT_DETAIL', '0') == '1'


def keyboard_enabled():
    return os.environ.get('KANBAN_BOT_KEYBOARD', '0') == '1'


def schedule_enabled(db=None):
    if db is not None:
        return bot_settings.read(db)['config']['schedule_enabled']
    return os.environ.get('KANBAN_BOT_SCHEDULE', '1') == '1'


def base_url():
    return os.environ.get('KANBAN_BOT_BASE_URL', 'https://kanban.danndann.cn').rstrip('/')


def event_url(event_id, **params):
    url = '%s/?event=%s' % (base_url(), event_id)
    query = {key: str(value) for key, value in params.items() if value}
    if query:
        url += '&' + urlencode(query)
    return url


def _zone(name):
    if not name:
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def local_time(value, zone=''):
    if not value:
        return '未设定'
    try:
        moment = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        # Stored event times may be naive; interpret them in the event's own
        # zone instead of silently inheriting the server's local timezone.
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=_zone(zone))
        return moment.astimezone(_zone(zone)).strftime('%Y-%m-%d %H:%M')
    except (ValueError, TypeError, OverflowError):
        return str(value)[:16]


def _available(db):
    """Guard old databases that have not run migration 10 yet."""
    if not enabled(db):
        return False
    return bool(db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_outbox'"
    ).fetchone())


def _keyboard(buttons):
    if not keyboard_enabled():
        return None
    rows = []
    for index, (label, data, jump) in enumerate(buttons, 1):
        action = ({'type': 0, 'permission': {'type': 2}, 'data': jump}
                  if jump else
                  {'type': 1, 'permission': {'type': 2}, 'data': data})
        rows.append({'buttons': [{
            'id': str(index),
            'render_data': {'label': label, 'visited_label': label, 'style': 1},
            'action': action,
        }]})
    return {'content': {'rows': rows}}


def enqueue(db, event_id, kind, text, *, channel='group', target='',
            due_at=None, buttons=None, status='pending', schedule_key=None,
            fact_key=None, recipient_user_id=None, template_context=None):
    """Queue one message. Returns True when a new row was created."""
    if not _available(db) or not text:
        return False
    if kind not in broadcast_kinds(db) and channel == 'group':
        return False
    if channel == 'group' and not bot_views.shareable(_event(db, event_id)):
        return False
    if channel == 'group':
        policy = bot_settings.read(db)['config']
        if policy['groups'] is not None:
            selected = bot_groups.broadcast_target(policy)
            if not selected or (target and target != selected):
                return False
            target = selected
    payload = {'text': text, 'msg_type': 0}
    if template_context is not None:
        payload['_template_context'] = template_context
    if schedule_key:
        payload['_schedule_key'] = schedule_key
    # Callback commands must retain the activity from the card they belong to.
    buttons = [(label, data+' '+event_id if data else '', jump)
               for label, data, jump in (buttons or [])]
    keyboard = _keyboard(buttons or [])
    if keyboard:
        payload['keyboard'] = keyboard
    raw = '%s\n%s\n%s\n%s\n%s' % (kind, channel, target,
        recipient_user_id or '', fact_key or schedule_key or text)
    dedupe = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:32]
    cursor = db.execute('''INSERT OR IGNORE INTO bot_outbox
        (event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at,recipient_user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)''',
        (event_id, kind, dedupe, channel, target,
         json.dumps(payload, ensure_ascii=False), due_at, status, now(), recipient_user_id))
    return cursor.rowcount > 0


def _event(db, event_id):
    return db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()


def retry(db, event, row_id):
    """New delivery intent; never re-execute registration or financial commands."""
    if not _available(db) or not bot_views.shareable(event):
        raise APIError('当前活动未开启公开群同步，无法重送',409)
    row = db.execute("SELECT * FROM bot_outbox WHERE id=? AND event_id=? AND channel='group'",
                     (row_id,event['id'])).fetchone()
    if not row or not (row['status']=='failed' or row['last_error']=='dry-run'):
        raise APIError('只能重送失败或模拟的通知',409)
    if db.execute("SELECT 1 FROM bot_outbox WHERE event_id=? AND kind=? AND payload_json=? "
                  "AND status IN ('pending','sending')", (event['id'],row['kind'],row['payload_json'])).fetchone():
        raise APIError('这条通知已有待送任务，请等待投递结果',409)
    if row['kind'] in REMINDER_KINDS:
        plan = reminder_plan(event,row['kind'],bot_settings.read(db)['config'])
        if not plan or json.loads(row['payload_json']).get('_schedule_key')!=plan[1]:
            raise APIError('活动安排已变更，请使用新版提醒，不能重送旧提醒',409)
    cursor = db.execute('''INSERT INTO bot_outbox
        (event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at)
        VALUES(?,?,?,?,?,?,?,'pending',?)''',
        (event['id'],row['kind'],'retry:'+uuid.uuid4().hex,'group',row['target'],
         row['payload_json'],row['due_at'],now()))
    return cursor.lastrowid


def _counts(db, event_id):
    row = db.execute("""SELECT
        SUM(status='confirmed') AS confirmed,
        SUM(status='waiting') AS waiting,
        SUM(confirmation_state='pending' AND status IN ('confirmed','waiting','tentative')) AS pending
        FROM attendees WHERE event_id=?""", (event_id,)).fetchone()
    return (row['confirmed'] or 0, row['waiting'] or 0, row['pending'] or 0)


def _version(db, event_id):
    row = db.execute(
        'SELECT MAX(version) AS v FROM settlement_history WHERE event_id=?',
        (event_id,)).fetchone()
    return row['v'] if row and row['v'] else None


def money(cents):
    value = int(cents or 0)
    sign = '-' if value < 0 else ''
    value = abs(value)
    return '%s%d.%02d' % (sign, value // 100, value % 100)


def _settlement_lines(db, event_id, version):
    # Explicit opt-in only: these lines DO contain participant names and
    # individual amounts. Operators must confirm the group accepts that.
    if not settlement_detail() or not version:
        return []
    row = db.execute('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?',
                     (event_id, version)).fetchone()
    if not row:
        return []
    try:
        snapshot = json.loads(row['snapshot_json'])
    except (ValueError, TypeError):
        return []
    lines = []
    for payer in snapshot.get('payers', [])[:30]:
        name = str(payer.get('name') or payer.get('label') or '参加者')[:12]
        amount = payer.get('amount_cents')
        if type(amount) is int:
            lines.append('%s %s 元' % (name, money(amount)))
    return lines


def _compose_default(db, event, kind, *, source='', after=None):
    """Build a de-identified group message. Returns (text, buttons) or None."""
    if not bot_views.shareable(event):
        return None
    action = {'activity_published':'join', 'conditions_changed':'conditions',
              'event_finished':'settlement', 'event_cancelled':'finance',
              'settlement_updated':'settlement', 'deadline_reminder':'join',
              'estimated_over_reminder':'manage'}.get(kind)
    url = event_url(event['id'], action=action)
    zone = event['timezone'] or ''
    when = local_time(event['starts_at'], zone)
    deadline = local_time(event['deadline'], zone)
    title = str(event['title'])[:40]
    confirmed, waiting, pending = _counts(db, event['id'])
    head = '【%s】%s' % (LABELS.get(kind, '群聚看板'), title)

    if kind == 'activity_published':
        lines = [head, '时间：%s' % when, '地点：%s' % event['location'],
                 '报名截止：%s' % deadline]
        if event['fee_policy']:
            lines.append('费用：%s' % str(event['fee_policy'])[:120])
        if event['minimum_participants']:
            lines.append('最低成团：%d 人' % event['minimum_participants'])
        if event['description']:
            lines.append(str(event['description'])[:120])
        lines += ['', url]
        buttons = [('我要报名', '', url), ('看名额', '/名额', ''), ('待办', '/待办', '')]
    elif kind == 'formation_confirmed':
        lines = [head, '发起者已确认成团，当前正式报名 %d 人' % confirmed,
                 '时间：%s' % when, '地点：%s' % event['location'], '', url]
        buttons = [('活动详情', '', url), ('看名额', '/名额', '')]
    elif kind == 'conditions_changed':
        version = event['conditions_version']
        lines = [head + '（第 %d 版）' % version,
                 str(event['change_summary'] or '重要安排有变更')[:120],
                 '原报名与原约定保留，请到站内逐人确认。']
        if pending:
            lines.append('待确认：%d 人' % pending)
        lines += ['', url]
        buttons = [('去确认', '', url), ('待办', '/待办', '')]
    elif kind == 'event_started':
        lines = [head, '时间：%s' % when, '地点：%s' % event['location'],
                 '现场如需补录，请到站内「现场补录」操作。', '', url]
        buttons = [('现场补录', '', event_url(event['id'], action='onsite')), ('出席', '/出席', '')]
    elif kind == 'event_finished':
        lines = [head, '请核对出席与款项申报；结算由发起者发布后另行通知。', '', url]
        buttons = [('活动页', '', url), ('待办', '/待办', '')]
    elif kind == 'event_cancelled':
        lines = [head, '原因：%s' % (event['cancellation_reason'] or '未填写')[:120],
                 '名单与账务保留，费用以公布的结算为准。', '', url]
        buttons = [('活动页', '', url)]
    elif kind == 'settlement_updated':
        version = _version(db, event['id'])
        lines = [head + ('（第 %d 版）' % version if version else ''),
                 '每人应付与付款归属已发布，请到站内查看。']
        detail = _settlement_lines(db, event['id'], version)
        if detail:
            lines += ['', '逐人应付：'] + detail
        lines += ['', url]
        buttons = [('查看我的', '/我的', ''), ('活动页', '', url)]
    elif kind == 'deadline_reminder':
        lines = [head, '报名截止：%s' % deadline,
                 '当前正式报名 %d 人' % confirmed,
                 ('候补 %d 人' % waiting) if waiting else '', url]
        lines = [line for line in lines if line]
        buttons = [('我要报名', '', url), ('看名额', '/名额', '')]
    elif kind == 'estimated_over_reminder':
        lines = [head, '已超过预计结束时间，请发起者确认实际结束或延长。', '', url]
        buttons = [('活动页', '', url), ('待办', '/待办', '')]
    elif kind in ('registration_paused', 'registration_resumed'):
        lines = [head, bot_views.registration_label(event),
                 '原名单与候补保留，名额按当前队列分配。', '', event_url(event['id'], action='join')]
        buttons = [('看名额', '/名额', '')]
    elif kind == 'finance_closed':
        lines = [head, '发起者已确认本版账务结清；原账单与账本记录保留。', '',
                 event_url(event['id'], action='finance')]
        buttons = [('查看账本', '', event_url(event['id'], action='finance'))]
    elif kind == 'finance_reopened':
        lines = [head, '账务重新待核对，请以站内最新补退款及结清状态为准。', '',
                 event_url(event['id'], action='finance')]
        buttons = [('查看账本', '', event_url(event['id'], action='finance'))]
    elif kind == 'ownership_changed':
        lines = [head, '发起者交接已完成，当前管理者请到活动页查看。',
                 '管理交接不代表实际代收资金已移交。', '', url]
        buttons = [('活动页', '', url)]
    else:
        return None
    return '\n'.join(line for line in lines if line is not None), buttons


def build_message(db, event, kind, *, source='', after=None, config=None):
    planned = _compose_default(db, event, kind, source=source, after=after)
    if not planned:
        return None
    original, buttons = planned
    lines = original.split('\n')
    # Capture facts at queue time; template edits must never turn an old fact
    # into a statement about the activity's newer state.
    confirmed, waiting, _ = _counts(db, event['id'])
    context = dict(heading=lines[0], details='\n'.join(lines[1:-1]).strip(), url=lines[-1],
                   title=str(event['title'])[:40], starts_at=local_time(event['starts_at'], event['timezone']),
                   deadline=local_time(event['deadline'], event['timezone']), location=event['location'],
                   confirmed=str(confirmed), waiting=str(waiting), fee_policy=str(event['fee_policy'] or '')[:120],
                   description=str(event['description'] or '')[:120],
                   version=str(_version(db, event['id']) or '') if kind == 'settlement_updated' else str(event['conditions_version']),
                   change_summary=str(event['change_summary'] or '')[:120],
                   cancellation_reason=str(event['cancellation_reason'] or '')[:120])
    context['_default_text'] = original
    config = config or bot_settings.read(db)['config']
    text = bot_settings.render(config, kind, context) if kind in config['templates'] else original
    return text, buttons, context


def compose(db, event, kind, *, source='', after=None):
    planned = build_message(db, event, kind, source=source, after=after)
    return planned[:2] if planned else None


PERSONAL_TEXT = {
    'promoted': '你的报名已递补为正式名额',
    'withdrawal_request': '有一条退出申请待处理',
    'withdrawal_decision': '退出申请已有处理结果',
    'removed': '你的报名已被撤销',
    'claim_requested': '有一条报名认领申请待核对',
    'claim_decided': '报名认领申请已有结果',
    'conditions_declined': '有人暂不同意新安排，请协调处理',
    'finance_updated': '款项记录有更新',
    'ownership_transferred': '发起者已交接',
    'cohost_accepted': '协办邀请已被接受',
    'cohost_removed': '协办权限已撤销',
}

LABELS = {
    'activity_published': '活动发起',
    'formation_confirmed': '已成团',
    'conditions_changed': '安排变更',
    'event_started': '活动开始',
    'event_finished': '活动结束',
    'event_cancelled': '活动取消',
    'settlement_updated': '结算发布',
    'deadline_reminder': '报名即将截止',
    'estimated_over_reminder': '活动时间已到',
    'registration_paused': '暂停报名',
    'registration_resumed': '恢复报名',
    'finance_closed': '账务已结清',
    'finance_reopened': '账务重新核对',
    'ownership_changed': '管理交接',
}


REMINDER_KINDS = ('deadline_reminder', 'estimated_over_reminder')


def reminder_plan(event, kind, config=None):
    if (not bot_views.shareable(event) or event['lifecycle'] not in ('scheduled', 'ongoing')
            or event['archived_at']):
        return None
    config = config or bot_settings.defaults()
    if not config['enabled'] or not config['schedule_enabled'] or kind not in config['broadcast_kinds']:
        return None
    value = event['deadline'] if kind == 'deadline_reminder' else event['starts_at']
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=_zone(event['timezone']))
        if kind == 'deadline_reminder':
            moment -= timedelta(hours=config['deadline_hours'])
        else:
            if not event['duration_hours']:
                return None
            moment += timedelta(hours=event['duration_hours'], minutes=config['estimated_over_delay_minutes'])
        due = moment.astimezone(timezone.utc).isoformat(timespec='seconds')
        key = hashlib.sha256((kind+'|'+due).encode()).hexdigest()[:32]
        return due, key
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def _schedule(db, event):
    """Replace obsolete reminders; never mutate their immutable intent payload."""
    settings = bot_settings.read(db)
    for kind in REMINDER_KINDS:
        plan = reminder_plan(event, kind, settings['config'])
        retained = False
        for row in db.execute("SELECT id,payload_json,status,last_error,simulated_at FROM bot_outbox WHERE event_id=? "
                              "AND kind=?",
                              (event['id'], kind)).fetchall():
            try:
                key = json.loads(row['payload_json']).get('_schedule_key')
            except (ValueError, TypeError, AttributeError):
                key = None
            if (not plan or key != plan[1]) and row['status'] in ('pending','sending'):
                db.execute("UPDATE bot_outbox SET status='skipped',last_error=? WHERE id=?",
                           ('安排或群同步设置已变更，旧提醒作废', row['id']))
            elif plan and key == plan[1] and (row['status'] != 'skipped'
                    or row['last_error'] == 'dry-run' or row['simulated_at']):
                retained = True
        if plan and plan[0] > now() and not retained:
            planned = build_message(db, event, kind)
            if planned:
                enqueue(db, event['id'], kind, planned[0], due_at=plan[0],
                        buttons=planned[1], schedule_key=plan[1],
                        fact_key='schedule:'+plan[1]+':revision:'+str(event['revision'])+':config:'+str(settings['revision']),
                        template_context=planned[2])


def _broadcast(db, event_id, kind, source='', after=None):
    event = _event(db, event_id)
    planned = build_message(db, event, kind, source=source, after=after)
    if not planned:
        return False
    version = (_version(db, event_id) if kind == 'settlement_updated'
               else event['conditions_version'] if kind == 'conditions_changed'
               else None)
    created = enqueue(db, event_id, kind, planned[0], buttons=planned[1],
                      fact_key=str(version) if version is not None else 'revision:'+str(event['revision']),
                      template_context=planned[2])
    if created and kind == 'activity_published':
        _schedule(db, event)
    return created


def on_notify(db, user_id, event_id, kind, message):
    """Hook called by audit.notify, once per recipient, inside the same transaction."""
    if not _available(db):
        return
    if kind in NOTIFY_OWNED:
        _broadcast(db, event_id, kind, source=message)
        return
    if kind in PERSONAL_KINDS and personal_queue():
        # Never reuse the station message: it contains nicknames and amounts.
        # Private rows stay unbound until member_openid <-> user_id exists.
        enqueue(db, event_id, kind,
                PERSONAL_TEXT.get(kind, '你有一条待办') + '\n' + event_url(event_id),
                channel='private', recipient_user_id=user_id)


def on_append(db, event, user, action, before, after, reason=''):
    """Hook called by audit.append for every state transition."""
    if not _available(db):
        return
    current = _event(db, event['id'])
    if not bot_views.shareable(current):
        db.execute("UPDATE bot_outbox SET status='skipped',last_error='活动已关闭公开群同步' "
                   "WHERE event_id=? AND channel='group' AND status IN ('pending','sending')", (event['id'],))
    if action.startswith('event_'):
        _schedule(db, current)
    if action == 'event_updated':
        before_event = before.get('event', before) if isinstance(before, dict) else {}
        if current['conditions_version'] != before_event.get('conditions_version', current['conditions_version']):
            _broadcast(db, current['id'], 'conditions_changed')
        if not before_event.get('bot_enabled') and current['bot_enabled']:
            _broadcast(db, current['id'], 'activity_published')
        return
    if action == 'event_bot_sync':
        if current['bot_enabled']:
            kind = {'ended': 'event_finished', 'cancelled': 'event_cancelled'}.get(current['lifecycle'], 'activity_published')
            _broadcast(db, current['id'], kind)
        return
    kind = APPEND_ACTIONS.get(action)
    if not kind:
        if (action.startswith('finance_') and isinstance(before, dict) and isinstance(after, dict)
                and before.get('state') == 'closed' and after.get('state') != 'closed'):
            _broadcast(db, current['id'], 'finance_reopened')
        return
    if current['lifecycle'] == 'draft':
        return
    _broadcast(db, current['id'], kind, after=after)
