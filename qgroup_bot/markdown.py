"""Bot-side Markdown entry point.

Escaping, safety checks and renderers live in ``qgroup_core.bot_markdown`` so
the web composer and the bot sender cannot drift apart. This module keeps the
bot-only API (platform rejection codes) and re-exports the shared helpers for
``main.py``, ``worker.py``, ``replies.py`` and the existing tests.
"""
from qgroup_core.bot_markdown import (  # noqa: F401  (re-exported API)
    BLANK, RULE, MAX_CHARS,
    escape_markdown, plain_line, content_problem,
    render_broadcast, render_help, render_command, render_event, render_tasks,
    render_selection, render_no_events,
)

# Platform codes that mean "this markdown payload was refused". They are only
# logged; we never auto-resend, so a failed send can never become a duplicate.
MARKDOWN_REJECTION_CODES = frozenset({
    22006,     # 消息类型与内容不匹配
    304036,    # 无 Markdown 模板权限
    304061,    # 消息内容无效
    40034008,  # markdown 参数有空值
    40034009,  # markdown 参数有换行符
    40034011,  # 无效的 markdown 内容
    40034124,  # markdown 消息参数错误
    40034127,  # 无 markdown 模板权限
})
