"""Simplified-Chinese group UI; Simplified/Traditional command aliases."""
import re
import sqlite3
from itertools import islice
from pathlib import Path

from qgroup_core import bot_outbox, bot_views, finance
from qgroup_core.bot_views import estimated_over as _estimated_over
from . import markdown as md
from .abbreviations import lookup as abbreviation_lookup

COMMANDS = [
    {'name': '/活动', 'desc': '选择活动，查看时间与地点'},
    {'name': '/报名', 'desc': '本人、同行与退出入口'},
    {'name': '/我的', 'desc': '登录网站查看我的报名与款项'},
    {'name': '/结算', 'desc': '往期账单、收退款与账本'},
    {'name': '/管理', 'desc': '按权限处理活动待办'},
    {'name': '/帮助', 'desc': '常用指令与操作说明'},
]
ALIASES = {word: word for word in (
    '活动', '报名', '我的', '结算', '管理', '帮助', '名额', '待办', '出席',
    '同行', '退出', '发起', '再约', '待确认', '确认安排', '地点', '规则',
    '款项', '账本', '已付款', '申报', '补报', '认领', '协办', '往期', '缩写')}
ALIASES.update({
    '活動': '活动', '報名': '报名', '結算': '结算', '幫助': '帮助', '名額': '名额',
    '待辦': '待办', '签到': '出席', '簽到': '出席', '發起': '发起', '再約': '再约',
    '待確認': '待确认', '確認安排': '确认安排', '地點': '地点', '規則': '规则',
    '款項': '款项', '帳本': '账本', '賬本': '账本', '帐本': '账本', '申報': '申报',
    '補報': '补报', '認領': '认领', '協辦': '协办',
    'help': '帮助', 'events': '活动', 'todos': '待办', 'me': '我的',
    'settle': '结算', 'quota': '名额', 'join': '报名',
    '縮寫': '缩写', 'nbnhhsh': '缩写',
})
QUICK_COMMANDS = ('快捷指令：/名额 /待办 /出席（/签到） /同行 /退出 /待确认 /确认安排\n'
                  '/地点 /规则 /款项 /账本 /已付款 /申报 /发起 /再约 /补报 /认领 /协办 /往期\n'
                  '/缩写 yyds  查询拼音缩写（支持 /縮寫、/nbnhhsh；仅缩写发送至第三方查询）')
HELP = ('群聚看板常用指令（简繁均可）：\n'
        '/活动  选择活动，查看时间与地点\n'
        '/报名  查看安排并进入报名\n'
        '/我的  登录网站查看我的报名、同行与款项\n'
        '/结算  往期账单与收退款\n'
        '/管理  按权限查看活动待办\n'
        '/帮助  显示本说明\n\n'
        + QUICK_COMMANDS + '\n'
        '多场活动请点对应链接，或在指令后加清单序号，例如 /名额 2 选第 2 场。\n'
        '序号以最近一次 /活动 清单为准；活动增减后会变，短码仍可继续使用。\n'
        '指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。')


def help_text():
    """Operational contact, privacy and complaint entries required by the bot rules."""
    site = bot_outbox.base_url()
    return (HELP + '\n\n'
            '隐私政策：' + site + '/privacy\n'
            '联络与问题反馈：' + site + '/contact\n'
            '群内消息只提供入口；不会替你报名、确认安排或登记付款。')

LINK_ACTIONS = {
    '报名': ('join', '查看安排并在网站提交报名；目前尚未替你占位。'),
    '同行': ('party', '同行逐人占位，请在网站预览正式／候补结果，再确认报名。'),
    '待确认': ('tentative', '待确认不占名额；确定参加时按当时队列分配。'),
    '退出': ('withdraw', '请在网站选择本人或可管理的同行；逾期正式报名须申请，批准前保留名额。'),
    '确认安排': ('conditions', '请逐人核对新版安排；未确认或暂不同意不代表自动退出。'),
    '款项': ('finance', '请登录网站查看本人待补、应退及垫付待收回款项。'),
    '账本': ('finance', '结算决定应付，账本记录实际收付；申报须核实后才计入。'),
    '已付款': ('report', '请在网站申报实际转账，发起者核实后才计入已确认款项；目前尚未登记。'),
    '申报': ('report', '请核对实际转款人、付款责任人、金额及时间，再预览提交；申报不等于已到账。'),
    '补报': ('invite', '补报名须有报名管理权限的人生成指定邀请；邀请不预留名额。'),
    '认领': ('claim', '请找原管理人发本人认领链接；申请后仍需核对，不要重复报名。'),
    '协办': ('management', '请在网站按权限生成或接受交接邀请；专属链接只交指定人。'),
    '管理': ('manage', '请登录网站按发起者／协办权限处理；此入口不授予管理权。'),
    '再约': ('copy', '只复制安排；请重新填写日期与截止，不复制名册、账务或收款码。'),
}
FINANCE_COMMANDS = {'结算', '款项', '账本', '已付款', '申报'}


def parse(content):
    text = re.sub(r'<@!?[A-Za-z0-9_-]+>', ' ', str(content or '')).strip()
    text = text.lstrip('＠@').strip()
    if not text:
        return '活动', ''
    match = re.match(r'^[/／]?\s*([^\s]+)\s*(.*)$', text)
    if not match:
        return None, ''
    head, argument = match.group(1).lstrip('/／').lower(), match.group(2).strip()
    return ALIASES.get(head), argument


def read_db(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    return connection


class SelectionError(ValueError):
    pass


def candidates(db, command='活动'):
    terminal = " AND lifecycle IN ('ended','cancelled')" if command == '往期' else ''
    active = command not in FINANCE_COMMANDS | {'往期', '待办', '管理', '再约'}
    if active:
        terminal = " AND lifecycle IN ('scheduled','ongoing')"
    archived = '' if command == '往期' else ' AND archived_at IS NULL'
    order = ("CASE WHEN lifecycle IN ('ended','cancelled') THEN 0 ELSE 1 END, starts_at DESC"
             if command in FINANCE_COMMANDS else "ABS(strftime('%s',starts_at)-strftime('%s','now')),id")
    # Public queries are independent of the owner's active-broadcast opt-in.
    rows = db.execute("SELECT * FROM events WHERE visibility='public' "
                      "AND lifecycle!='draft' AND status!='deleted'" + terminal + archived +
                      ' ORDER BY '+order)
    # Apply the time-zone-aware cutoff before the list limit; every active
    # command must share the same numbering as /活动.
    return list(islice((event for event in rows if not active or not _estimated_over(event)), 9))


def current_event(db, argument='', command='活动'):
    """Resolve a selection by list number (preferred) or legacy short code.

    The number always refers to the same ``candidates(db, command)`` order the
    selection list just showed, so ``/活动`` followed by ``/名额 2`` picks the
    second row the user saw. Numbers are re-evaluated on every request: they
    are a short-lived convenience, not a stable activity identifier.
    """
    rows = candidates(db, command)
    if argument:
        if re.fullmatch(r'[1-8]', argument):
            visible = rows[:8]
            index = int(argument) - 1
            if index >= len(visible):
                raise SelectionError('序号 %s 不在本次清单（共 %d 场）；请重新发送 /%s 查看最新序号。'
                                     % (argument, len(visible), command))
            return visible[index]
        if not re.fullmatch(r'[a-fA-F0-9]{8,16}', argument):
            raise SelectionError('活动选择请用清单里的 1–8 序号，或 8–16 位活动短码；请重新选择活动。')
        found = db.execute("SELECT * FROM events WHERE id LIKE ? AND visibility='public' "
                           "AND lifecycle!='draft' AND status!='deleted' LIMIT 2",
                           (argument.lower()+'%',)).fetchall()
        if not found:
            raise SelectionError('找不到可在本群查询的指定活动；请检查短码，并确认活动已发布且公开可见。')
        if len(found) != 1:
            raise SelectionError('活动短码不唯一，请使用完整活动编号。')
        return found[0]
    return rows[0] if len(rows) == 1 else None


def _event_when(event):
    when = bot_outbox.local_time(event['starts_at'], event['timezone'])
    countdown = bot_outbox.start_countdown(event)
    return when + (' · ' + countdown if countdown else '')


def _selection(db, command):
    rows = candidates(db, command)
    if not rows:
        return ('目前没有可在本群查询的活动（没有进行中的公开活动，或该分类暂无已发布的公开活动）。\n'
                '请到网站查看你有权访问的活动：\n'+bot_outbox.base_url()+'/'), None
    lines = ['请选择活动，点对应链接继续，或发送 /%s 序号（例如 /%s 1）：' % (command, command)]
    action = LINK_ACTIONS.get(command, ('settlement' if command == '结算' else 'detail', ''))[0]
    for index, event in enumerate(rows[:8], 1):
        lines += ['%d. %s · %s' % (index, str(event['title'])[:40],
                  _event_when(event)),
                  bot_outbox.event_url(event['id'], action=action)]
    if len(rows) > 8:
        lines.append('更多活动请到网站查看：'+bot_outbox.base_url()+'/')
    lines.append('序号以最近一次 /%s 清单为准；活动增减后会变，也可发送 8 位活动短码。' % command)
    return '\n'.join(lines), None


def answer(db, command, argument=''):
    if command == '缩写':
        return abbreviation_lookup.answer(argument), None
    if command == '帮助':
        return help_text(), None
    if command not in ALIASES.values():
        return '未识别这条指令，请使用下列指令：\n'+help_text(), None
    if command == '我的' and not argument:
        return ('机器人尚未绑定你的站内身份，请登录网站查看我的报名、同行、款项与待办。\n'
                +bot_outbox.base_url()+'/?action=mine'), None
    if command == '发起':
        return '请登录网站填写并核对后发布；目前尚未创建活动。\n'+bot_outbox.base_url()+'/?action=create', None
    try:
        event = current_event(db, argument, command)
    except SelectionError as exc:
        return str(exc), None
    if event is None:
        return _selection(db, command)
    url = bot_outbox.event_url(event['id'])
    c = bot_views.counts(db, event['id'])
    head = '【%s】%s' % (event['title'][:40], bot_outbox.local_time(event['starts_at'], event['timezone']))
    countdown = bot_outbox.start_countdown(event)
    if countdown:
        head += '\n' + countdown
    if command in LINK_ACTIONS:
        action, explanation = LINK_ACTIONS[command]
        text = '\n'.join([head, explanation, '', bot_outbox.event_url(event['id'], action=action)])
        if command == '报名':
            text = bot_views.with_roster(text, bot_views.roster_lines(db, event))
        return text, None
    if command in ('活动', '往期'):
        phase = {'scheduled': '待开始', 'ongoing': '进行中', 'ended': '已结束', 'cancelled': '已取消'}[event['lifecycle']]
        lines = [head, '地点：'+event['location'], '报名截止：'+bot_outbox.local_time(event['deadline'], event['timezone']),
                 '正式 %d 人，候补 %d 人' % (c['confirmed'], c['waiting']),
                 '当前阶段：%s · %s' % (phase, bot_views.registration_label(event)), '', url]
    elif command == '名额':
        lines = [head, bot_views.registration_label(event),
                 '正式 %d 人 / 上限 %s' % (c['confirmed'], event['capacity'] or '不限'),
                 '候补 %d 人，待确认参加 %d 人（不占名额）' % (c['waiting'], c['tentative'])]
        queue = db.execute("SELECT 1 FROM attendees a JOIN roster_parties p ON p.id=a.party_id "
                           "WHERE a.event_id=? AND a.status='waiting' AND p.queue_mode='together' LIMIT 1", (event['id'],)).fetchone()
        if queue:
            lines.append('存在整组候补，空位须按队列分配，不能保证直接报上。')
        if event['minimum_participants']:
            lines.append('最低成团 %d 人；%s' % (event['minimum_participants'],
                         '发起者已确认成团' if event['formation_state'] == 'confirmed' else '待发起者决定是否成团'))
        lines += ['', bot_outbox.event_url(event['id'], action='join')]
    elif command == '待办':
        lines = [head, '活动状态摘要（不是你的个人待办）：']
        lines += ['・'+text for text in bot_views.public_tasks(db, event)] or ['・暂无公开状态提醒']
        lines += ['认领、退出审批、款项申报及个人补退款，请登录网站按权限查看。', '',
                  bot_outbox.event_url(event['id'], action='todos')]
    elif command == '出席':
        rows = db.execute("SELECT attendance,count(*) AS n FROM attendees WHERE event_id=? "
                          "AND (status='confirmed' OR attendance!='unknown') GROUP BY attendance", (event['id'],)).fetchall()
        counts = {row['attendance']: row['n'] for row in rows}
        lines = [head, '到场 %d 人，迟到 %d 人，早退 %d 人，缺席 %d 人，未核对 %d 人' %
                 tuple(counts.get(s, 0) for s in ('present', 'late', 'left', 'absent', 'unknown')),
                 '尚未替你登记出席；核对已有人员与现场补录是不同流程，须按权限在网站操作。', '',
                 bot_outbox.event_url(event['id'], action='attendance')]
    elif command == '结算':
        version = bot_outbox._version(db, event['id'])
        bill = db.execute('SELECT total_cents,headcount FROM settlements WHERE event_id=?', (event['id'],)).fetchone()
        if not bill:
            lines = [head, '结算尚未发布；请发起者在实际结束或取消后核对发布。']
        else:
            closed = finance.summary(db, event)['state'] == 'closed'
            lines = [head, '第 %d 版，总额 %s 元，%d 人' % (version or 1, bot_outbox.money(bill['total_cents']), bill['headcount']),
                     '账务已确认结清。' if closed else '账单已发布，收退款与账务仍需核对；发布不代表款项已收齐。',
                     '每人应付与付款归属请到站内查看（不在此列出）。']
        lines += ['', bot_outbox.event_url(event['id'], action='settlement')]
    elif command == '我的':
        lines = [head, '尚未绑定你的身份；个人应付金额与付款归属请登录站内查看。', '', bot_outbox.event_url(event['id'], action='finance')]
    elif command == '地点':
        lines = [head, '地点：'+event['location'], '请到活动页点击导航。', '', url]
    elif command == '规则':
        lines = [head, '费用约定：'+(event['fee_policy'] or '未填写，请向发起者确认'),
                 '退出期限：'+bot_outbox.local_time(event['withdrawal_deadline'] or event['deadline'], event['timezone']),
                 '期限后正式报名须申请退出；退出不等于退款。最终金额以核对发布的账单为准。', '',
                 bot_outbox.event_url(event['id'], action='conditions')]
    else:
        return help_text(), None
    text = '\n'.join(lines)
    if command in ('活动', '名额'):
        text = bot_views.with_roster(text, bot_views.roster_lines(db, event))
    return text, None


def _selection_markdown(db, command):
    rows = candidates(db, command)
    site = bot_outbox.base_url()
    if not rows:
        return md.render_no_events(site)
    action = LINK_ACTIONS.get(command, ('settlement' if command == '结算' else 'detail', ''))[0]
    items = [(str(event['title'])[:40],
              _event_when(event),
              bot_outbox.event_url(event['id'], action=action))
             for event in rows[:8]]
    return md.render_selection(items, command, site, more=len(rows) > 8)


def _generic_markdown(db, command, argument):
    """Turn any remaining plain command answer into one consistent card.

    Reusing ``answer()`` guarantees the Markdown body never states a different
    fact than the plain-text fallback. The first line becomes a plain labelled
    summary (never a ``##`` heading or a ``**...**`` wrapper); user-authored
    values are sanitised by the shared renderer.
    """
    plain = answer(db, command, argument)[0]
    lines = [line for line in plain.split('\n') if line.strip()]
    url = lines.pop() if lines and lines[-1].startswith(('http://', 'https://')) else ''
    head = ''
    if lines and (lines[0].startswith('【') or len(lines[0]) <= 42):
        head = lines.pop(0)
    return md.render_command(command, head, lines, url)


def answer_markdown(db, command, argument=''):
    """Build a msg_type=2 reply, or None when this command stays plain text.

    Only system-authored fragments are stylised. Every activity title, place
    and task string goes through ``plain_text()`` (strips QQ Markdown syntax,
    platform mention tags and structural injection) before reaching a
    renderer, so user input can never become a heading, emphasis or link.
    """
    if command == '缩写':
        return None
    site = bot_outbox.base_url()
    if command is None or command not in ALIASES.values() or command == '帮助':
        prefix = '' if command == '帮助' else '未识别这条指令，请使用下列指令：'
        return md.render_help(COMMANDS, site, QUICK_COMMANDS, prefix=prefix)
    if command in ('我的', '发起') and not argument:
        return _generic_markdown(db, command, argument)
    try:
        event = current_event(db, argument, command)
    except SelectionError:
        return None
    if event is None:
        return _selection_markdown(db, command)
    title = str(event['title'])[:40]
    when = bot_outbox.local_time(event['starts_at'], event['timezone'])
    countdown = bot_outbox.start_countdown(event)
    if command in ('活动', '往期'):
        c = bot_views.counts(db, event['id'])
        phase = {'scheduled': '待开始', 'ongoing': '进行中',
                 'ended': '已结束', 'cancelled': '已取消'}[event['lifecycle']]
        text = md.render_event(title, when, [
            ('地点', str(event['location'] or '')[:120]),
            ('报名截止', bot_outbox.local_time(event['deadline'], event['timezone'])),
            ('人数', '正式 %d 人，候补 %d 人' % (c['confirmed'], c['waiting'])),
            ('当前阶段', '%s · %s' % (phase, bot_views.registration_label(event))),
        ], bot_outbox.event_url(event['id']), countdown=countdown)
        return (bot_views.with_roster(text, bot_views.roster_lines(db, event), markdown=True)
                if command == '活动' else text)
    if command == '待办':
        tasks = bot_views.public_tasks(db, event) or ['暂无公开状态提醒']
        return md.render_tasks(title, when, tasks,
                               bot_outbox.event_url(event['id'], action='todos'),
                               countdown=countdown)
    return _generic_markdown(db, command, argument)
