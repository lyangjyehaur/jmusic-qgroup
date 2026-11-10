"""Passive commands. The bot reads business tables read-only and never writes them."""
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from qgroup_core import bot_outbox

COMMANDS = [
    {'name': '/活动', 'desc': '查看当前活动与报名链接'},
    {'name': '/名额', 'desc': '报名人数、候补与成团状态'},
    {'name': '/待办', 'desc': '发起者待处理事项'},
    {'name': '/签到', 'desc': '现场补录入口与出席统计'},
    {'name': '/结算', 'desc': '结算版本与总额'},
    {'name': '/我的', 'desc': '我的应付与付款归属'},
    {'name': '/帮助', 'desc': '列出全部指令'},
]

ALIASES = {
    '活动': '活动', '名额': '名额', '待办': '待办', '签到': '签到',
    '结算': '结算', '我的': '我的', '帮助': '帮助',
    'help': '帮助', 'events': '活动', 'todos': '待办', 'me': '我的',
    'settle': '结算', 'quota': '名额',
}

HELP = ('群聚看板机器人指令：\n'
        '/活动  当前活动与报名链接\n'
        '/名额  报名人数、候补、成团状态\n'
        '/待办  发起者待处理事项\n'
        '/签到  现场补录入口\n'
        '/结算  结算版本与总额\n'
        '/我的  应付与付款归属（仅回站内链接）\n'
        '/帮助  显示本说明\n'
        '指令后加活动 id 前 8 位可指定活动，例如 /名额 a1b2c3d4')


def parse(content):
    """Return (command, argument). Only @-mentions of this bot are accepted upstream."""
    text = re.sub(r'<@!?[A-Za-z0-9_-]+>', ' ', str(content or '')).strip()
    text = text.lstrip('＠@').strip()
    match = re.match(r'^[/／]?\s*([^\s]+)\s*(.*)$', text)
    if not match:
        return None, ''
    head, argument = match.group(1), match.group(2).strip()
    head = head.lstrip('/／').lower()
    command = ALIASES.get(head)
    return command, argument


def read_db(path):
    # as_uri() escapes spaces, '?' and '#' correctly; a raw f-string URI breaks.
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def current_event(db, argument=''):
    if argument:
        row = db.execute('''SELECT * FROM events WHERE id LIKE ? AND status!='deleted'
            ORDER BY created_at DESC LIMIT 1''', (argument[:16] + '%',)).fetchone()
        if row:
            return row
    return db.execute('''SELECT * FROM events
        WHERE lifecycle IN ('scheduled','ongoing') AND archived_at IS NULL
          AND status!='deleted'
        ORDER BY ABS(strftime('%s',starts_at)-strftime('%s','now')) LIMIT 1''').fetchone()


def _counts(db, event_id):
    row = db.execute("""SELECT
        SUM(status='confirmed') AS confirmed, SUM(status='waiting') AS waiting,
        SUM(confirmation_state='pending' AND status IN ('confirmed','waiting','tentative')) AS pending,
        SUM(withdrawal_requested=1 AND status!='withdrawn') AS withdrawals
        FROM attendees WHERE event_id=?""", (event_id,)).fetchone()
    return tuple(int(value or 0) for value in row)


def answer(db, command, argument=''):
    """Return (text, keyboard). Never includes a nickname or an individual amount."""
    event = current_event(db, argument)
    if command == '帮助':
        return HELP, None
    if event is None:
        return '目前没有进行中或待开始的活动。', None
    url = bot_outbox.event_url(event['id'])
    zone = event['timezone'] or ''
    when = bot_outbox.local_time(event['starts_at'], zone)
    confirmed, waiting, pending, withdrawals = _counts(db, event['id'])
    head = '【%s】%s' % (event['title'][:40], when)

    if command == '活动':
        lines = [head, '地点：%s' % event['location'],
                 '报名截止：%s' % bot_outbox.local_time(event['deadline'], zone),
                 '正式 %d 人%s' % (confirmed, ('，候补 %d 人' % waiting) if waiting else ''),
                 '当前阶段：%s' % event['lifecycle'], '', url]
    elif command == '名额':
        capacity = event['capacity'] or '不限'
        lines = [head, '正式 %d 人 / 上限 %s' % (confirmed, capacity),
                 '候补 %d 人' % waiting,
                 '最低成团 %d 人，状态：%s' % (event['minimum_participants'],
                                            event['formation_state']), '', url]
    elif command == '待办':
        lines = [head]
        if pending:
            lines.append('・%d 人待确认新安排' % pending)
        if withdrawals:
            lines.append('・%d 笔退出申请待审批' % withdrawals)
        reports = db.execute('''SELECT count(*) FROM finance_reports r
            WHERE r.event_id=? AND NOT EXISTS
              (SELECT 1 FROM finance_report_actions a WHERE a.report_id=r.id)''',
            (event['id'],)).fetchone()[0]
        if reports:
            lines.append('・%d 笔款项申报待核对' % reports)
        if _estimated_over(event):
            lines.append('・已超过预计结束时间，请确认结束或延长')
        if event['lifecycle'] in ('ended', 'cancelled') and not db.execute(
                'SELECT 1 FROM settlements WHERE event_id=?', (event['id'],)).fetchone():
            lines.append('・可核对并发布结算')
        if len(lines) == 1:
            lines.append('・目前没有待处理事项')
        lines += ['', url]
    elif command == '签到':
        lines = [head, '现场补录请到活动页「现场补录」，须确认规则。']
        if event['lifecycle'] in ('ongoing', 'ended', 'cancelled'):
            arrived = db.execute("SELECT count(*) FROM attendees WHERE event_id=? AND attendance='arrived'",
                                 (event['id'],)).fetchone()[0]
            lines.append('已到场 %d 人' % arrived)
        lines += ['', url]
    elif command == '结算':
        version = bot_outbox._version(db, event['id'])
        bill = db.execute('SELECT total_cents,headcount FROM settlements WHERE event_id=?',
                          (event['id'],)).fetchone()
        if not bill:
            lines = [head, '结算尚未发布；由发起者在活动实际结束后发布。', '', url]
        else:
            lines = [head, '第 %d 版，总额 %s 元，%d 人' %
                     (version or 1, bot_outbox.money(bill['total_cents']), bill['headcount']),
                     '每人应付与付款归属请到站内查看（不在此列出）。', '', url]
    elif command == '我的':
        # No identity binding yet: never resolve a member_openid to a user_id here.
        lines = [head, '应付金额、付款归属与收款码属于个人资料，请到站内查看。', '', url]
    else:
        return HELP, None
    return '\n'.join(lines), None


def _estimated_over(event):
    if event['lifecycle'] not in ('scheduled', 'ongoing') or not event['duration_hours']:
        return False
    try:
        end = datetime.fromisoformat(str(event['starts_at']).replace('Z', '+00:00')) \
            + timedelta(hours=event['duration_hours'])
        if end.tzinfo is None:
            end = end.replace(tzinfo=bot_outbox._zone(event['timezone'] or ''))
        return end <= datetime.now(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return False
