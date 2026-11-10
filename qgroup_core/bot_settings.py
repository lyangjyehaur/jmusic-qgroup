"""Shared, versioned bot policy. Secrets and transport settings stay in the environment."""
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from string import Formatter
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .common import APIError, now

KINDS = {
    'activity_published': '活动发起', 'formation_confirmed': '已成团',
    'conditions_changed': '安排变更', 'event_started': '活动开始',
    'event_finished': '活动结束', 'event_cancelled': '活动取消',
    'settlement_updated': '结算发布', 'deadline_reminder': '报名即将截止',
    'estimated_over_reminder': '活动时间已到', 'registration_paused': '暂停报名',
    'registration_resumed': '恢复报名', 'finance_closed': '账务已结清',
    'finance_reopened': '账务重新核对', 'ownership_changed': '管理交接',
}
VARIABLES = {
    'heading': '消息标题', 'details': '系统生成的事件说明', 'url': '活动操作链接',
    'title': '活动名称', 'starts_at': '开始时间', 'deadline': '报名截止',
    'location': '地点', 'confirmed': '正式人数', 'waiting': '候补人数',
    'fee_policy': '费用说明', 'description': '活动说明', 'version': '相关版本',
    'change_summary': '安排变更摘要', 'cancellation_reason': '取消原因',
}
DEFAULT_TEMPLATE = '{heading}\n{details}\n\n{url}'
VARIABLE_LIMITS = dict(heading=120, details=2500, url=512, title=40,
                       starts_at=32, deadline=32, location=120, confirmed=20, waiting=20,
                       fee_policy=120, description=120, version=20,
                       change_summary=120, cancellation_reason=120)


def migrate(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=13').fetchone():
        return
    db.execute('''CREATE TABLE IF NOT EXISTS bot_settings(
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
        config_json TEXT NOT NULL, updated_at TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS bot_settings_history(
        revision INTEGER PRIMARY KEY, config_json TEXT NOT NULL,
        created_at TEXT NOT NULL, actor_ref TEXT NOT NULL, action TEXT NOT NULL)''')
    # An empty document inherits deployment defaults until explicitly configured.
    stamp = now()
    db.execute("INSERT OR IGNORE INTO bot_settings VALUES(1,0,'{}',?)", (stamp,))
    db.execute("INSERT OR IGNORE INTO bot_settings_history VALUES(0,'{}',?,'','baseline')", (stamp,))
    for operation in ('UPDATE', 'DELETE'):
        db.execute('CREATE TRIGGER IF NOT EXISTS bot_settings_history_no_'+operation.lower()+
                   ' BEFORE '+operation+" ON bot_settings_history BEGIN SELECT RAISE(ABORT,'Bot settings history is append-only'); END")
    db.execute('''CREATE TABLE IF NOT EXISTS bot_runtime(
        id INTEGER PRIMARY KEY CHECK(id=1), applied_revision INTEGER,
        checked_at TEXT, last_attempt_at TEXT)''')
    db.execute('INSERT OR IGNORE INTO bot_runtime(id) VALUES(1)')
    db.execute('INSERT INTO schema_migrations VALUES(13,?)', (stamp,))


def defaults(*, worker=False):
    raw = os.environ.get('KANBAN_BOT_BROADCAST_KINDS', '').strip()
    selected = {item.strip() for item in raw.split(',')} if raw else set(KINDS)
    return dict(
        # The versioned DB policy is the single source of truth. Before an
        # admin saves one, web and bot must inherit the SAME deployment default;
        # a worker-side 1 would let the bot drain rows the web never queues.
        # `worker` stays in the signature for callers, but no longer forks the
        # effective policy.
        enabled=os.environ.get('KANBAN_BOT_ENABLED', '0') == '1',
        replies_enabled=True, dry_run=None,
        broadcast_kinds=[kind for kind in KINDS if kind in selected],
        schedule_enabled=os.environ.get('KANBAN_BOT_SCHEDULE', '1') == '1',
        deadline_hours=24, estimated_over_delay_minutes=0,
        quiet_enabled=False, quiet_start='23:00', quiet_end='08:00',
        timezone='Asia/Taipei', min_interval_seconds=0, templates={})


def read(db, *, worker=False):
    row = db.execute('SELECT * FROM bot_settings WHERE id=1').fetchone()
    config = defaults(worker=worker)
    config.update(json.loads(row['config_json']))
    return dict(revision=row['revision'], config=config, updated_at=row['updated_at'])


def validate(config):
    if not isinstance(config, dict) or set(config) != set(defaults()):
        raise APIError('机器人设置字段不完整或含未知字段')
    for key in ('enabled', 'replies_enabled', 'schedule_enabled', 'quiet_enabled'):
        if type(config[key]) is not bool:
            raise APIError('机器人开关格式不正确')
    if config['dry_run'] is not None and type(config['dry_run']) is not bool:
        raise APIError('机器人模拟模式格式不正确')
    for key, low, high in (('deadline_hours', 1, 720),
                           ('estimated_over_delay_minutes', 0, 1440),
                           ('min_interval_seconds', 0, 3600)):
        if type(config[key]) is not int or not low <= config[key] <= high:
            raise APIError('机器人时间设置超出允许范围')
    kinds = config['broadcast_kinds']
    if (not isinstance(kinds, list) or any(not isinstance(k, str) or k not in KINDS for k in kinds)
            or len(kinds) != len(set(kinds))):
        raise APIError('机器人通知事件格式不正确')
    for key in ('quiet_start', 'quiet_end'):
        if not isinstance(config[key], str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', config[key]):
            raise APIError('勿扰时间须为 HH:MM')
    if config['quiet_enabled'] and config['quiet_start'] == config['quiet_end']:
        raise APIError('勿扰开始与结束时间不能相同')
    try:
        if not isinstance(config['timezone'], str) or len(config['timezone']) > 80:
            raise ValueError()
        ZoneInfo(config['timezone'])
    except (ZoneInfoNotFoundError, ValueError):
        raise APIError('勿扰时区不正确')
    templates = config['templates']
    if not isinstance(templates, dict) or any(k not in KINDS for k in templates):
        raise APIError('消息模板类型不正确')
    for value in templates.values():
        validate_template(value)
    return config


def validate_template(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise APIError('消息模板须为 1–2000 字')
    try:
        fields = []
        expanded_limit = 0
        for literal, field, spec, conversion in Formatter().parse(value):
            expanded_limit += len(literal)
            if field is not None:
                if field not in VARIABLES or spec or conversion:
                    raise ValueError()
                fields.append(field)
                expanded_limit += VARIABLE_LIMITS[field]
        if 'url' not in fields:
            raise ValueError()
    except ValueError:
        raise APIError('模板只能使用列出的变量，并须保留 {url}；不支持格式表达式')
    if expanded_limit > 4000:
        raise APIError('模板展开后可能超过 4000 字，请减少重复变量或缩短内容')


def render(config, kind, context):
    value = config['templates'].get(kind, DEFAULT_TEMPLATE)
    validate_template(value)
    text = value.format_map(context)
    if len(text) > 4000 or not text.strip():
        raise APIError('消息内容超出 4000 字，请缩短模板')
    return text


def preview(db, data):
    config = validate(data.get('config'))
    kind = data.get('kind')
    if not isinstance(kind, str) or kind not in KINDS:
        raise APIError('消息模板类型不正确')
    from . import bot_outbox
    start = (datetime.now(ZoneInfo('Asia/Taipei')) + timedelta(days=7)).replace(hour=18, minute=0, second=0, microsecond=0)
    sample = dict(id='preview', title='周末聚餐', visibility='public', bot_enabled=1,
                  lifecycle='scheduled', status='open', timezone='Asia/Taipei',
                  starts_at=start.isoformat(), deadline=(start-timedelta(days=1)).isoformat(),
                  location='示例餐厅', fee_policy='按实际消费 AA', description='示例活动说明',
                  minimum_participants=4, conditions_version=2, change_summary='集合时间调整',
                  cancellation_reason='天气原因', archived_at=None, registration_open=kind != 'registration_paused')
    context = bot_outbox.build_message(db, sample, kind, config=config)[2]
    return dict(text=render(config, kind, context))


def view(db):
    result = read(db)
    result['kinds'] = KINDS
    result['variables'] = VARIABLES
    result['default_template'] = DEFAULT_TEMPLATE
    history = db.execute('SELECT * FROM bot_settings_history ORDER BY revision DESC LIMIT 21').fetchall()
    result['history'] = []
    for index, row in enumerate(history[:20]):
        before = json.loads(history[index+1]['config_json']) if index+1 < len(history) else {}
        after = json.loads(row['config_json'])
        changes = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
        result['history'].append(dict(revision=row['revision'], created_at=row['created_at'], action=row['action'], changes=changes))
    runtime = db.execute('SELECT applied_revision,checked_at FROM bot_runtime WHERE id=1').fetchone()
    result['runtime'] = dict(runtime)
    return result


def save(db, data, actor, *, revert=False):
    current = read(db)
    revision = data.get('base_revision')
    if type(revision) is not int:
        raise APIError('机器人配置版本格式不正确')
    if revision != current['revision']:
        raise APIError('机器人配置已被其他页面修改，请重新载入后重试', 409)
    if revert:
        previous = db.execute('SELECT config_json FROM bot_settings_history WHERE revision=?', (revision-1,)).fetchone()
        if not previous:
            raise APIError('没有可恢复的上一版配置', 409)
        raw = json.loads(previous['config_json'])
    else:
        raw = validate(data.get('config'))
    existing = json.loads(db.execute('SELECT config_json FROM bot_settings WHERE id=1').fetchone()[0])
    if raw == existing:
        return dict(ok=True, bot=view(db))
    stamp = now()
    encoded = json.dumps(raw, ensure_ascii=False, sort_keys=True)
    db.execute('UPDATE bot_settings SET revision=revision+1,config_json=?,updated_at=? WHERE id=1', (encoded, stamp))
    db.execute('INSERT INTO bot_settings_history VALUES(?,?,?,?,?)',
               (revision+1, encoded, stamp, hashlib.sha256(actor.encode()).hexdigest()[:16], 'revert' if revert else 'save'))
    config = read(db)['config']
    # Deferred rows must be reconsidered when quiet hours, pacing or simulation
    # change; a previous policy's retry_at is not a transport failure backoff.
    db.execute("UPDATE bot_outbox SET retry_at=NULL,last_error='' WHERE status='pending' "
               "AND last_error='等待允许发送的时间'")
    for kind in KINDS:
        if not config['enabled'] or kind not in config['broadcast_kinds']:
            db.execute("UPDATE bot_outbox SET status='skipped',last_error='后台已关闭此类通知' "
                       "WHERE channel='group' AND kind=? AND status IN ('pending','sending')", (kind,))
    schedule_keys = ('enabled', 'broadcast_kinds', 'schedule_enabled', 'deadline_hours', 'estimated_over_delay_minutes')
    if any(current['config'][key] != config[key] for key in schedule_keys):
        from . import bot_outbox
        for event in db.execute("SELECT * FROM events WHERE bot_enabled=1 AND lifecycle IN ('scheduled','ongoing')").fetchall():
            bot_outbox._schedule(db, event)
    return dict(ok=True, bot=view(db))


def quiet_until(config, moment):
    """Return the next allowed UTC time, including quiet periods across midnight."""
    if not config['quiet_enabled']:
        return None
    local = moment.astimezone(ZoneInfo(config['timezone']))
    clock = local.strftime('%H:%M')
    start, end = config['quiet_start'], config['quiet_end']
    active = start <= clock < end if start < end else clock >= start or clock < end
    if not active:
        return None
    hour, minute = map(int, end.split(':'))
    stop = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if stop <= local:
        stop += timedelta(days=1)
    return stop.astimezone(timezone.utc)


def reserve_send(db, config, moment):
    """Persistent pacing across polls/restarts. Called inside BEGIN IMMEDIATE."""
    due = quiet_until(config, moment)
    last = db.execute('SELECT last_attempt_at FROM bot_runtime WHERE id=1').fetchone()[0]
    if last and config['min_interval_seconds']:
        next_time = datetime.fromisoformat(last) + timedelta(seconds=config['min_interval_seconds'])
        if next_time > moment:
            due = max(due, next_time) if due else next_time
    if due:
        return due.isoformat(timespec='microseconds' if due.microsecond else 'seconds')
    db.execute('UPDATE bot_runtime SET last_attempt_at=? WHERE id=1', (moment.isoformat(timespec='microseconds'),))
    return None
