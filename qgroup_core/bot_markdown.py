"""Shared QQ custom-Markdown helpers (msg_type=2).

Both services need the same rules: web composes queued broadcasts, bot composes
passive replies and delivers both kinds. Keeping escaping and safety checks in
qgroup_core avoids two divergent implementations, while this module deliberately
imports neither ``server`` nor ``qgroup_bot``.

Only syntax documented by QQ is emitted: headings, bold/italic/strike, links,
ordered/unordered lists, quotes and horizontal rules. Code fences and tables
are NOT supported. QQ only keeps an empty paragraph when the blank line holds a
zero-width space.

Official references (checked 2026-11-11):
  https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html
  https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
Custom Markdown in group/single chats has been open to all bots since
2026-04-23; no template application is required. A markdown body must NOT carry
``content`` at the same time.

Real-device syntax probes (2026-11-11, test group): a card written with the
documented syntax renders correctly, while backslash escapes, zero-width
characters inserted next to syntax characters and full-width substitutions all
render badly. QQ documents no escape mechanism at all. User-authored text
therefore keeps its own **bold**, _italic_, [links](url) and ~~strike~~; we
neutralise only structural injection (see escape_markdown) and let
content_problem() enforce the outbound-link allowlist.
"""
import re
from urllib.parse import urlsplit

BLANK = '\u200B'
RULE = '***'
MAX_CHARS = 4000

_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
# Platform mention markup is the one construct that must never survive: a
# title containing <qqbot-at-everyone /> would mention the whole group.
# QQ's autolink <https://...> is left alone; only qqbot-at-* tags are removed.
_PLATFORM_TAG = re.compile(r'<\s*/?\s*qqbot-at-[^>]*>', re.IGNORECASE)
_URL = re.compile(r'https?://([^\s<>"\[\]{}()]+)')


def escape_markdown(text):
    """Keep inline Markdown live; remove only structural injection.

    Newlines, tabs and control characters are folded into spaces so a title or
    a note can never inject a heading, a list item or an extra paragraph.
    Platform ``<qqbot-at-*>`` tags are dropped so user text cannot @everyone.

    Deliberately NOT escaped: ``*``, ``_``, ``~``, ``[``, ``]``, ``(``, ``)``,
    ``#``, ``!`` and backticks. QQ has no escape syntax; backslashes, zero-width
    insertions and full-width replacements were all rejected by a real-device
    A/B/C/D comparison. Letting the documented syntax work is both the product
    requirement and the only option that renders cleanly. Outbound link targets
    are checked separately by content_problem() against the allowlist.
    """
    value = str(text if text is not None else '')
    value = _CONTROL.sub(' ', value)
    value = value.replace('\r', ' ').replace('\n', ' ').replace('\t', ' ')
    return _PLATFORM_TAG.sub('', value)


def content_problem(text, allowed_hosts=()):
    """Return a refusal reason, or None when the markdown body is safe to send."""
    if not isinstance(text, str) or not text.strip():
        return 'markdown 内容为空'
    if _CONTROL.search(text):
        return 'markdown 含控制字符'
    if len(text) > MAX_CHARS:
        return 'markdown 超过 4000 字'
    if allowed_hosts:
        hosts = {str(host).strip().lower() for host in allowed_hosts if host}
        for match in _URL.finditer(text):
            host = (urlsplit('https://' + match.group(1)).hostname or '').lower()
            if host and host not in hosts:
                return 'markdown 含未报备域名'
    return None


def render_broadcast(label, title, details, url, *, link_label='打开活动',
                     notice=(), footnote='指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。'):
    """System-authored card for one of the 14 active broadcast kinds.

    ``label`` is the fixed event label, ``title`` the (escaped) activity name,
    ``details`` the already-composed fact lines and ``notice`` the per-person
    settlement detail that an operator explicitly opted into. Every non-system
    value is escaped here, so a title or a note cannot become a link, a heading
    or a platform mention.
    """
    facts = ['- ' + escape_markdown(line) for line in details if str(line).strip()]
    lines = ['## ' + escape_markdown(label), '**%s**' % escape_markdown(title), BLANK]
    lines += facts or ['- 暂无其他说明']
    if notice:
        lines += [BLANK, '## 逐人应付']
        lines += ['- ' + escape_markdown(line) for line in notice if str(line).strip()]
    lines += [BLANK, '[%s](%s)' % (escape_markdown(link_label), url)]
    if footnote:
        lines += [BLANK, '> ' + escape_markdown(footnote)]
    return '\n'.join(lines)


def render_help(commands, site, shortcuts, prefix='',
                selection_hint='多场活动点对应链接，或发送 **/名额 2** 选择清单里的第 2 场。'):
    lines = ['## 群聚看板 · 常用指令']
    if prefix:
        lines.append('> ' + escape_markdown(prefix))
    lines += [BLANK, '指令简繁均可，在群里 @ 机器人后发送：', BLANK]
    for item in commands:
        lines.append('- **%s**　%s' % (escape_markdown(item['name']),
                                      escape_markdown(item['desc'])))
    lines += [BLANK, RULE, BLANK]
    for line in str(shortcuts).split('\n'):
        if line.strip():
            lines.append('- ' + escape_markdown(line))
    lines += [BLANK, selection_hint, BLANK, RULE, BLANK,
              '[隐私政策](%s/privacy) · [联络与问题反馈](%s/contact)' % (site, site),
              BLANK,
              '> 群内消息只提供入口；不会替你报名、确认安排或登记付款。'
              '报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_command(command, head, body, url, link_label='打开活动'):
    """Generic card for the remaining commands, built from the plain answer.

    Every line comes from the already-composed plain text, so even a command
    we forgot to special-case keeps the same facts. All of it is escaped: the
    heading is a system string, the bold line and the bullets may contain
    activity titles, places, amounts or notes authored by users.
    """
    lines = ['## /' + escape_markdown(command)]
    if head:
        lines.append('**%s**' % escape_markdown(head))
    lines.append(BLANK)
    lines += ['- ' + escape_markdown(line) for line in body] or ['- 暂无其他说明']
    if url:
        lines += [BLANK, '[%s](%s)' % (escape_markdown(link_label), url)]
    lines += [BLANK,
              '> 指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_event(title, when, facts, url, link_label='打开活动'):
    """facts: sequence of (system label, value); values are escaped here."""
    lines = ['## ' + escape_markdown(title), '**%s**' % when, BLANK]
    for label, value in facts:
        lines.append('- **%s**　%s' % (label, escape_markdown(value)))
    lines += [BLANK, '[%s](%s)' % (link_label, url), BLANK,
              '> 指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_tasks(title, when, tasks, url):
    lines = ['## 待办 · %s' % escape_markdown(title),
             '**%s** · 活动状态摘要（不是你的个人待办）' % when, BLANK]
    items = ['- ' + escape_markdown(task) for task in tasks]
    lines += items or ['- 暂无公开状态提醒']
    lines += [BLANK, '认领、退出审批、款项申报及个人补退款，请登录网站按权限查看。',
              BLANK, '[查看待办](%s)' % url]
    return '\n'.join(lines)


def render_selection(items, command, site, more=False):
    """items: sequence of (title, formatted time, system URL).

    The visible number IS the command argument: ``/名额 2`` resolves against the
    same candidate list, so users never need to copy an 8-character short code.
    """
    lines = ['## 选择活动',
             '点对应链接继续，或发送 **/%s 序号**（例如 **/%s 1**）。'
             % (escape_markdown(command), escape_markdown(command)),
             BLANK]
    for index, (title, when, url) in enumerate(items, 1):
        lines.append('%d. **%s** · %s · [打开活动](%s)'
                     % (index, escape_markdown(title), when, url))
    lines += [BLANK,
              '> 序号以最近一次 **/%s** 清单为准；活动增减后会变，可重新 /%s 查看。'
              '仍可输入 8 位活动短码。' % (escape_markdown(command), escape_markdown(command))]
    if more:
        lines += [BLANK, '[更多活动请到网站查看](%s/)' % site]
    return '\n'.join(lines)


def render_no_events(site):
    return '\n'.join(['## 暂无可查询的活动',
                      '目前没有进行中的公开活动，或该分类暂无已发布的公开活动。',
                      BLANK, '[到网站查看](%s/)' % site])
