"""Simplified-Chinese group UI; Simplified/Traditional command aliases."""
import re
import sqlite3
from pathlib import Path

from qgroup_core import bot_outbox, bot_views, finance
from qgroup_core.bot_views import estimated_over as _estimated_over

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
    '款项', '账本', '已付款', '申报', '补报', '认领', '协办', '往期')}
ALIASES.update({
    '活動': '活动', '報名': '报名', '結算': '结算', '幫助': '帮助', '名額': '名额',
    '待辦': '待办', '签到': '出席', '簽到': '出席', '發起': '发起', '再約': '再约',
    '待確認': '待确认', '確認安排': '确认安排', '地點': '地点', '規則': '规则',
    '款項': '款项', '帳本': '账本', '賬本': '账本', '帐本': '账本', '申報': '申报',
    '補報': '补报', '認領': '认领', '協辦': '协办',
    'help': '帮助', 'events': '活动', 'todos': '待办', 'me': '我的',
    'settle': '结算', 'quota': '名额', 'join': '报名',
})
HELP = ('群聚看板常用指令（简繁均可）：\n'
        '/活动  选择活动，查看时间与地点\n'
        '/报名  查看安排并进入报名\n'
        '/我的  登录网站查看我的报名、同行与款项\n'
        '/结算  往期账单与收退款\n'
        '/管理  按权限查看活动待办\n'
        '/帮助  显示本说明\n\n'
        '快捷指令：/名额 /待办 /出席（/签到） /同行 /退出 /待确认 /确认安排\n'
        '/地点 /规则 /款项 /账本 /已付款 /申报 /发起 /再约 /补报 /认领 /协办 /往期\n'
        '多场活动请点对应链接，或在指令后加 8 位活动短码，例如 /名额 a1b2c3d4。\n'
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
    if command not in FINANCE_COMMANDS | {'往期', '待办', '管理', '再约'}:
        terminal = " AND lifecycle IN ('scheduled','ongoing')"
    archived = '' if command == '往期' else ' AND archived_at IS NULL'
    order = ("CASE WHEN lifecycle IN ('ended','cancelled') THEN 0 ELSE 1 END, starts_at DESC"
             if command in FINANCE_COMMANDS else "ABS(strftime('%s',starts_at)-strftime('%s','now')),id")
    return db.execute("SELECT * FROM events WHERE visibility='public' AND bot_enabled=1 "
                      "AND lifecycle!='draft' AND status!='deleted'" + terminal + archived +
                      ' ORDER BY '+order+' LIMIT 9').fetchall()


def current_event(db, argument='', command='活动'):
    if argument:
        if not re.fullmatch(r'[a-fA-F0-9]{8,16}', argument):
            raise SelectionError('活动短码应为 8–16 位字母 a–f 与数字，请重新选择活动。')
        rows = db.execute("SELECT * FROM events WHERE id LIKE ? AND visibility='public' "
                          "AND bot_enabled=1 AND lifecycle!='draft' AND status!='deleted' LIMIT 2",
                          (argument.lower()+'%',)).fetchall()
        if not rows:
            raise SelectionError('找不到可在本群查询的指定活动；请检查短码或向发起者确认群同步设置。')
        if len(rows) != 1:
            raise SelectionError('活动短码不唯一，请使用完整活动编号。')
        return rows[0]
    rows = candidates(db, command)
    return rows[0] if len(rows) == 1 else None


def _selection(db, command):
    rows = candidates(db, command)
    if not rows:
        return ('目前没有可在本群查询的活动（没有进行中、尚未开启群同步，或该分类暂无活动）。\n'
                '请到网站查看你有权访问的活动：\n'+bot_outbox.base_url()+'/'), None
    lines = ['请选择活动，点对应链接继续：']
    action = LINK_ACTIONS.get(command, ('settlement' if command == '结算' else 'detail', ''))[0]
    for index, event in enumerate(rows[:8], 1):
        lines += ['%d. %s · %s [%s]' % (index, event['title'][:40],
                  bot_outbox.local_time(event['starts_at'], event['timezone']), event['id'][:8]),
                  bot_outbox.event_url(event['id'], action=action)]
    if len(rows) > 8:
        lines.append('更多活动请到网站查看：'+bot_outbox.base_url()+'/')
    lines.append('也可发送 /%s 活动短码。' % command)
    return '\n'.join(lines), None


def answer(db, command, argument=''):
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
    if command in LINK_ACTIONS:
        action, explanation = LINK_ACTIONS[command]
        return '\n'.join([head, explanation, '', bot_outbox.event_url(event['id'], action=action)]), None
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
    return '\n'.join(lines), None
