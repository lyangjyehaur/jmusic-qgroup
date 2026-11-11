"""Public group views. Personal actions always return to the authenticated site."""
from datetime import datetime, timedelta, timezone
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .common import now


def shareable(event):
    return bool(event is not None and event['visibility'] == 'public'
                and event['lifecycle'] != 'draft' and event['status'] != 'deleted'
                and 'bot_enabled' in event.keys() and event['bot_enabled'])


def registration_label(event):
    if event['lifecycle'] in ('ended', 'cancelled') or event['archived_at']:
        return '已结束报名'
    if event['lifecycle'] == 'ongoing' or event['starts_at'] <= now():
        return '已开始，补报名请联系发起者'
    if event['deadline'] <= now():
        return '已截止，补报名请联系发起者'
    return '开放报名' if event['registration_open'] else '已暂停报名'


def counts(db, event_id):
    rows = db.execute('''SELECT status,confirmation_state,withdrawal_requested,attendance
        FROM attendees WHERE event_id=?''', (event_id,)).fetchall()
    active = [r for r in rows if r['status'] in ('confirmed', 'waiting', 'tentative')]
    return dict(confirmed=sum(r['status'] == 'confirmed' for r in rows),
                waiting=sum(r['status'] == 'waiting' for r in rows),
                tentative=sum(r['status'] == 'tentative' for r in rows),
                pending=sum(r['confirmation_state'] == 'pending' for r in active),
                declined=sum(r['confirmation_state'] == 'declined' for r in active),
                withdrawals=sum(bool(r['withdrawal_requested']) for r in active))


def roster_lines(db, event, *, attendee_ids=None, prefix=''):
    """Only public display names, in the site's party/person queue order."""
    if (event is None or event['visibility'] != 'public'
            or event['lifecycle'] == 'draft' or event['status'] == 'deleted'):
        return []
    from . import bot_markdown
    people = db.execute('''SELECT a.id,COALESCE(u.nickname,a.name) AS nickname,a.status
        FROM attendees a LEFT JOIN users u ON u.id=a.user_id
        LEFT JOIN roster_parties p ON p.id=a.party_id
        WHERE a.event_id=? AND a.status IN ('confirmed','waiting')
        ORDER BY p.seq,a.seq''', (event['id'],)).fetchall()
    groups = {'confirmed': [], 'waiting': []}
    for person in people:
        if attendee_ids is not None and person['id'] not in attendee_ids:
            continue
        raw = re.sub(r'<@!?[^>]*>', '', str(person['nickname'] or ''))
        name = bot_markdown.plain_text(raw)
        # A display name must not introduce a bare URL or a platform mention,
        # including in the plain fallback. Keep visible words from MD links.
        name = re.sub(r'https?://\S+', '', name, flags=re.IGNORECASE)
        name = re.sub(r'@(?:everyone|all)\b', '', name, flags=re.IGNORECASE)
        name = name.replace('@', '').replace('＠', '').strip()
        groups[person['status']].append(name[:24] or '未填写称呼')
    lines = []
    for status, label in (('confirmed', '正式报名'), ('waiting', '候补')):
        names = groups[status]
        line = '%s%s（%d 人）：%s' % (prefix, label, len(names), '、'.join(names[:10]) or '暂无')
        if len(names) > 10:
            line += '；其余 %d 人请到活动页查看' % (len(names) - 10)
        lines.append(line)
    return lines


def with_roster(text, lines, *, markdown=False):
    """Add a bounded optional section without displacing mandatory content."""
    if not lines:
        return text
    from . import bot_markdown as md
    section = ('\n'.join('- ' + md.plain_text(line) for line in lines)
               if markdown else '\n'.join(lines))
    gap = '\n' + md.BLANK + '\n' if markdown else '\n\n'
    parts = text.split('\n')
    # Place the section before the final standalone link, preserving footnotes.
    link_index = next((i for i in range(len(parts) - 1, -1, -1)
                       if parts[i].startswith(('https://', 'http://'))
                       or re.fullmatch(r'\[[^\]]+\]\(https?://[^\s]+\)', parts[i])), None)
    for content in (section, '报名名单较长，请到活动页查看完整名单。'):
        decorated = ('\n'.join(parts[:link_index]) + gap + content + gap
                     + '\n'.join(parts[link_index:]) if link_index is not None
                     else text + gap + content)
        if len(decorated) <= md.MAX_CHARS:
            return decorated
    return text


def public_tasks(db, event):
    """Activity facts, not a claim to know the sender's role or private tasks."""
    c = counts(db, event['id'])
    tasks = []
    if c['pending'] or c['declined']:
        tasks.append('%d 人待确认新安排，%d 人暂不同意，请逐人协调' % (c['pending'], c['declined']))
    if c['withdrawals']:
        tasks.append('有退出申请，请有报名管理权限的人到站内处理')
    active = event['lifecycle'] in ('scheduled', 'ongoing') and not event['archived_at']
    if (active and event['minimum_participants'] and event['formation_state'] != 'confirmed'
            and (c['confirmed'] >= event['minimum_participants'] or event['deadline'] <= now())):
        tasks.append('请发起者决定是否成团；达到人数不代表已确认成团')
    if active and estimated_over(event):
        tasks.append('已超过预计结束时间，请确认结束或延长')
    bill = db.execute('SELECT 1 FROM settlements WHERE event_id=?', (event['id'],)).fetchone()
    if event['lifecycle'] in ('ended', 'cancelled') and not bill and not event['archived_at']:
        tasks.append('请发起者核对出席、原约定并发布结算')
    if bill:
        from . import finance
        state = finance.summary(db, event)['state']
        if state != 'closed':
            tasks.append('结算已发布，收退款及账务结清状态请到站内核对')
    return tasks


def estimated_over(event):
    if event['lifecycle'] not in ('scheduled', 'ongoing') or not event['duration_hours']:
        return False
    try:
        end = datetime.fromisoformat(str(event['starts_at']).replace('Z', '+00:00')) + timedelta(hours=event['duration_hours'])
        if end.tzinfo is None:
            try:
                zone = ZoneInfo(event['timezone']) if event['timezone'] else timezone.utc
            except ZoneInfoNotFoundError:
                zone = timezone.utc
            end = end.replace(tzinfo=zone)
        return end <= datetime.now(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return False
