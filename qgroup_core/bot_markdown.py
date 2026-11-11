"""Shared QQ custom-Markdown helpers (msg_type=2).

Both services need the same rules: web composes queued broadcasts, bot composes
passive replies and delivers both kinds. Keeping sanitising and safety checks in
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

Real-device findings (2026-11-11, test group):
* A card written with the documented syntax renders correctly. Backslash
  escapes, zero-width insertions next to syntax characters and full-width
  substitutions all render badly; QQ documents no escape mechanism at all.
* Inline syntax does NOT render when user text is put in a ``##`` heading or
  wrapped in a ``**...**`` span. A six-way comparison card confirmed that only
  plain lines (bare text, fixed heading + plain line, plain list item) render
  inline syntax correctly.

Therefore the trust boundary is explicit: **only system-authored fragments may
emit Markdown**. Every user-authored value (activity titles, places, notes,
change summaries) goes through plain_text(), which removes QQ syntax characters
and keeps the words. Styling that carries meaning -- for example a struck-out
old time next to a bold new time after a reschedule -- is composed from system
values by system_time_change(). Admin-written @md template bodies are trusted
too, but every substituted value is sanitised before substitution.
"""
import re
from urllib.parse import urlsplit

BLANK = '\u200B'
RULE = '***'
MAX_CHARS = 4000

_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
# Platform mention markup must never survive: a title containing
# <qqbot-at-everyone /> would mention the whole group.
_PLATFORM_TAG = re.compile(r'<\s*/?\s*qqbot-at-[^>]*>', re.IGNORECASE)
_URL = re.compile(r'https?://([^\s<>"\[\]{}]+)', re.IGNORECASE)
# [text](url) and ![alt](url) keep their visible text but lose the link; QQ's
# autolink <https://...> loses the whole URL so it cannot become a hyperlink.
_LINK = re.compile(r'!?\[([^\]]*)\]\([^)]*\)')
_AUTOLINK = re.compile(r'<\s*https?://[^>]*>', re.IGNORECASE)
# QQ has no escape syntax: the only reliable way to stop user input from
# becoming a heading, emphasis, strike, quote, image or autolink is to remove
# the syntax characters. Brackets round Chinese text (e.g. (周六)) are kept:
# they are not Markdown by themselves once [ ] are gone.
_SYNTAX = re.compile(r'[*_`~<>\[\]!|\\#]')


def plain_text(text):
    """Return user-authored text as plain words, with QQ Markdown stripped.

    This is sanitising, not escaping. Real-device A/B/C/D probes showed
    backslashes, zero-width insertions and full-width replacements all render
    badly, and QQ documents no escape mechanism at all. So syntax is removed:
    links collapse to their visible text, autolinks and platform mention tags
    are dropped, emphasis/strike/heading/quote characters are removed, and
    newlines, tabs and control characters are folded into single spaces.

    Only system-authored fragments may emit Markdown after this point. A bare
    URL with no Markdown syntax is still visible to content_problem(), which
    keeps the existing outbound-link allowlist as a second safety net.
    """
    value = str(text if text is not None else '')
    value = _CONTROL.sub(' ', value)
    value = value.replace('\r', ' ').replace('\n', ' ').replace('\t', ' ')
    value = value.replace(BLANK, '')
    value = _PLATFORM_TAG.sub('', value)
    value = _AUTOLINK.sub('', value)
    value = _LINK.sub(lambda match: match.group(1), value)
    value = _SYNTAX.sub('', value)
    value = re.sub(r' {2,}', ' ', value).strip()
    # A leading "- " / "1. " would still read as a nested list once a renderer
    # prefixes the fact line with its own bullet. Time strings like 11-13 and
    # negative numbers have no following space, so they are unaffected.
    return re.sub(r'^\s*(?:[-+]\s+|\d+[.)]\s+)', '', value).strip()


def plain_line(label, text):
    """Put sanitised user text on a plain line with a fixed system label.

    ``label`` is a fixed system string. QQ ignores inline syntax inside a
    ``##`` heading, so user values are never placed there; the label also stops
    a leading '#' / '-' / '1.' from injecting heading or list structure.
    """
    return label + plain_text(text)


def system_time_change(previous, current):
    """System-authored reschedule fact: struck-out old time, bold new time.

    Both values are system-formatted timestamps, never user text. Returns None
    when there is no previous version or the time did not actually change.
    """
    before, after = plain_text(previous), plain_text(current)
    if not before or not after or before == after:
        return None
    return '- **时间** ~~%s~~ → **%s**' % (before, after)


def has_unapproved_link(text, allowed_hosts=()):
    """Use the same URL allowlist for rich text, plain fallbacks and buttons."""
    if not allowed_hosts:
        return False
    hosts = {str(host).strip().lower() for host in allowed_hosts if host}
    for match in _URL.finditer(text):
        try:
            # Keep parentheses in userinfo, but drop a Markdown link's closing
            # delimiter so links to a bare origin also pass the allowlist.
            host = (urlsplit('https://' + match.group(1).rstrip(')')).hostname or '').lower()
        except ValueError:
            return True
        if host not in hosts:
            return True
    return False


def content_problem(text, allowed_hosts=()):
    """Return a refusal reason, or None when the markdown body is safe to send."""
    if not isinstance(text, str) or not text.strip():
        return 'markdown 内容为空'
    if _CONTROL.search(text):
        return 'markdown 含控制字符'
    if len(text) > MAX_CHARS:
        return 'markdown 超过 4000 字'
    if has_unapproved_link(text, allowed_hosts):
        return 'markdown 含未报备域名'
    return None


def render_broadcast(label, title, details, url, *, link_label='打开活动',
                     notice=(), system_facts=(),
                     footnote='指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。'):
    """System-authored card for an active broadcast kind.

    ``label`` is a fixed event label, ``title`` the user-authored activity
    name, ``details`` the already-composed fact lines and ``notice`` the
    per-person settlement detail that an operator explicitly opted into.
    User-authored values are sanitised; only headings, bullets, the link, the
    footnote and ``system_facts`` carry Markdown. ``system_facts`` must be
    built entirely from system values (see system_time_change) -- the caller is
    responsible for never passing raw user text there.
    """
    facts = [str(line) for line in system_facts if str(line).strip()]
    facts += ['- ' + plain_text(line) for line in details if str(line).strip()]
    lines = ['## ' + plain_text(label), plain_line('活动名称：', title), BLANK]
    lines += facts or ['- 暂无其他说明']
    if notice:
        lines += [BLANK, '## 逐人应付']
        lines += ['- ' + plain_text(line) for line in notice if str(line).strip()]
    lines += [BLANK, '[%s](%s)' % (plain_text(link_label), url)]
    if footnote:
        lines += [BLANK, '> ' + plain_text(footnote)]
    return '\n'.join(lines)


def render_help(commands, site, shortcuts, prefix='',
                selection_hint='多场活动点对应链接，或发送 **/名额 2** 选择清单里的第 2 场。'):
    lines = ['## 群聚看板 · 常用指令']
    if prefix:
        lines.append('> ' + plain_text(prefix))
    lines += [BLANK, '指令简繁均可，在群里 @ 机器人后发送：', BLANK]
    for item in commands:
        lines.append('- **%s**　%s' % (plain_text(item['name']),
                                      plain_text(item['desc'])))
    lines += [BLANK, RULE, BLANK]
    for line in str(shortcuts).split('\n'):
        if line.strip():
            lines.append('- ' + plain_text(line))
    lines += [BLANK, selection_hint, BLANK, RULE, BLANK,
              '[隐私政策](%s/privacy) · [联络与问题反馈](%s/contact)' % (site, site),
              BLANK,
              '> 群内消息只提供入口；不会替你报名、确认安排或登记付款。'
              '报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_command(command, head, body, url, link_label='打开活动'):
    """Generic card for the remaining commands, built from the plain answer.

    Every line comes from the already-composed plain text, so even a command
    we forgot to special-case keeps the same facts. The heading is a system
    string; user-authored values in the summary and bullets are sanitised.
    """
    lines = ['## /' + plain_text(command)]
    if head:
        lines.append(plain_line('查询结果：', head))
    lines.append(BLANK)
    lines += ['- ' + plain_text(line) for line in body] or ['- 暂无其他说明']
    if url:
        lines += [BLANK, '[%s](%s)' % (plain_text(link_label), url)]
    lines += [BLANK,
              '> 指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_event(title, when, facts, url, link_label='打开活动', *, countdown=''):
    """facts: sequence of (system label, value); values are sanitised here."""
    lines = ['## 活动详情', plain_line('活动名称：', title),
             '**%s**' % when]
    if countdown:
        lines.append('**%s**' % countdown)
    lines.append(BLANK)
    for label, value in facts:
        lines.append('- **%s**　%s' % (label, plain_text(value)))
    lines += [BLANK, '[%s](%s)' % (link_label, url), BLANK,
              '> 指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。']
    return '\n'.join(lines)


def render_tasks(title, when, tasks, url, *, countdown=''):
    lines = ['## 待办', plain_line('活动名称：', title),
             '**%s** · 活动状态摘要（不是你的个人待办）' % when]
    if countdown:
        lines.append('**%s**' % countdown)
    lines.append(BLANK)
    items = ['- ' + plain_text(task) for task in tasks]
    lines += items or ['- 暂无公开状态提醒']
    lines += [BLANK, '认领、退出审批、款项申报及个人补退款，请登录网站按权限查看。',
              BLANK, '[查看待办](%s)' % url]
    return '\n'.join(lines)


def render_selection(items, command, site, more=False):
    """items: sequence of (title, formatted time, system URL).

    The visible number IS the command argument: ``/名额 2`` resolves against the
    same candidate list, so users never need to copy an 8-character short code.
    Titles are sanitised and NOT wrapped in bold: only system fragments emit
    Markdown in this card.
    """
    lines = ['## 选择活动',
             '点对应链接继续，或发送 **/%s 序号**（例如 **/%s 1**）。'
             % (plain_text(command), plain_text(command)),
             BLANK]
    for index, (title, when, url) in enumerate(items, 1):
        lines.append('%d. %s · %s · [打开活动](%s)'
                     % (index, plain_text(title), when, url))
    lines += [BLANK,
              '> 序号以最近一次 **/%s** 清单为准；活动增减后会变，可重新 /%s 查看。'
              '仍可输入 8 位活动短码。' % (plain_text(command), plain_text(command))]
    if more:
        lines += [BLANK, '[更多活动请到网站查看](%s/)' % site]
    return '\n'.join(lines)


def render_no_events(site):
    return '\n'.join(['## 暂无可查询的活动',
                      '目前没有进行中的公开活动，或该分类暂无已发布的公开活动。',
                      BLANK, '[到网站查看](%s/)' % site])
