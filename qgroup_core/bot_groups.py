"""Admin-controlled group routing and bounded, content-free discovery."""
import hashlib
import os
import re

from .common import APIError, now

GROUP_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
IGNORE_REASONS = frozenset({'group_not_allowed', 'replies_disabled', 'dry_run',
                            'bot_author', 'duplicate'})


def migrate(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=15').fetchone():
        return
    if 'deployment_group' not in {r['name'] for r in db.execute('PRAGMA table_info(bot_runtime)')}:
        db.execute("ALTER TABLE bot_runtime ADD COLUMN deployment_group TEXT NOT NULL DEFAULT ''")
    db.execute('''CREATE TABLE IF NOT EXISTS bot_groups(
        group_id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT,
        last_event TEXT NOT NULL DEFAULT '', membership TEXT NOT NULL DEFAULT 'seen')''')
    db.execute('''CREATE TABLE IF NOT EXISTS bot_group_ignores(
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL)''')
    db.execute('INSERT INTO schema_migrations VALUES(15,?)', (now(),))


def valid_id(value):
    return isinstance(value, str) and bool(GROUP_ID.fullmatch(value))


def validate(groups):
    if groups is None:
        return
    if not isinstance(groups, list) or len(groups) > 100:
        raise APIError('群组设置最多支持 100 个群')
    seen = set()
    broadcasts = 0
    for group in groups:
        if not isinstance(group, dict) or set(group) != {'id', 'name', 'replies', 'broadcast'}:
            raise APIError('群组设置字段不完整或含未知字段')
        if not valid_id(group['id']) or group['id'] in seen:
            raise APIError('群组标识格式不正确或重复')
        seen.add(group['id'])
        if (not isinstance(group['name'], str) or len(group['name']) > 60
                or any(ord(c) < 32 for c in group['name'])):
            raise APIError('群组名称最多 60 字，不能包含控制字符')
        if type(group['replies']) is not bool or type(group['broadcast']) is not bool:
            raise APIError('群组开关格式不正确')
        broadcasts += int(group['broadcast'])
    if broadcasts > 1:
        raise APIError('主动通知只能选择一个目标群')


def resolve(config, fallback=''):
    groups = config.get('groups')
    if groups is not None:
        return groups
    return [dict(id=fallback, name='', replies=True, broadcast=True)] if valid_id(fallback) else []


def reply_allowed(config, group_id, fallback=''):
    return any(g['id'] == group_id and g['replies'] for g in resolve(config, fallback))


def broadcast_target(config, fallback=''):
    return next((g['id'] for g in resolve(config, fallback) if g['broadcast']), '')


def deployment_group(db):
    row = db.execute('SELECT deployment_group FROM bot_runtime WHERE id=1').fetchone()
    return (row[0] if row else '') or os.environ.get('KANBAN_BOT_GROUP', '').strip()


def record_deployment(db, group_id):
    group_id = group_id if valid_id(group_id) else ''
    db.execute('UPDATE bot_runtime SET deployment_group=? WHERE id=1 AND deployment_group<>?',
               (group_id, group_id))
    if group_id:
        db.execute('INSERT OR IGNORE INTO bot_groups(group_id) VALUES(?)', (group_id,))


def observe(db, group_id, event_type):
    if not valid_id(group_id):
        return
    stamp = now()
    membership = {'GROUP_ADD_ROBOT': 'joined', 'GROUP_DEL_ROBOT': 'removed'}.get(event_type, 'seen')
    db.execute('''INSERT INTO bot_groups(group_id,first_seen,last_seen,last_event,membership)
        VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET
        first_seen=COALESCE(bot_groups.first_seen,excluded.first_seen),
        last_seen=excluded.last_seen,last_event=excluded.last_event,membership=excluded.membership''',
               (group_id, stamp, stamp, str(event_type or '')[:80], membership))
    db.execute('DELETE FROM bot_groups WHERE group_id NOT IN '
               '(SELECT group_id FROM bot_groups ORDER BY last_seen DESC LIMIT 500)')


def ignored(db, group_id, reason):
    if not valid_id(group_id) or reason not in IGNORE_REASONS:
        return
    db.execute('INSERT INTO bot_group_ignores(group_id,reason,created_at) VALUES(?,?,?)',
               (group_id, reason, now()))
    db.execute('DELETE FROM bot_group_ignores WHERE id NOT IN '
               '(SELECT id FROM bot_group_ignores ORDER BY id DESC LIMIT 100)')


def view(db, config):
    fallback = deployment_group(db)
    configured = {g['id']: g for g in resolve(config, fallback)}
    discovered = {r['group_id']: dict(r) for r in db.execute(
        'SELECT * FROM bot_groups ORDER BY last_seen DESC LIMIT 200')}
    for group_id in configured:
        discovered.setdefault(group_id, dict(group_id=group_id, first_seen=None,
                                             last_seen=None, last_event='', membership='unknown'))
    groups = []
    for group_id, item in discovered.items():
        policy = configured.get(group_id, {})
        groups.append(dict(item, id=group_id, name=policy.get('name', ''),
                           replies=policy.get('replies', False), broadcast=policy.get('broadcast', False),
                           reference=hashlib.sha256(group_id.encode()).hexdigest()[:20],
                           deployment_default=group_id == fallback))
    return dict(inherited=config.get('groups') is None, groups=groups,
                ignores=[dict(r) for r in db.execute(
                    'SELECT group_id,reason,created_at FROM bot_group_ignores ORDER BY id DESC LIMIT 20')])
