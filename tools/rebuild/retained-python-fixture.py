"""Synthetic compiled-web fixture only; transport cannot leave this process."""
import asyncio
import json
import socket
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


def deny_network(*_args, **_kwargs):
    raise AssertionError('Retained bot fixture cannot use network transport')


# asyncio needs a private Unix socketpair for thread completion wakeups. Create
# that event-loop plumbing before bot imports, then prohibit all new sockets.
event_loop = asyncio.new_event_loop()
socket.socket = deny_network
source, database, mode, event_id, origin, *faults = sys.argv[1:]
assert len(faults) <= 1
fault = faults[0] if faults else 'success'
assert fault in ('success', 'transient', 'permanent', 'rate-limit', 'unconfirmed')
source, database = Path(source).resolve(), Path(database).resolve()
assert mode in ('plain', 'rich', 'dry-run', 'inspect')
assert fault == 'success' or mode in ('plain', 'rich')
assert ((source.parent == database.parent and source.name == 'original-python') or
        (source == Path('/app/original-python') and database.parent == Path('/var/lib/qgroup')))
assert database.name == 'synthetic.sqlite3'
assert origin.startswith('http://127.0.0.1:')
sys.path.insert(0, str(source))
from qgroup_bot import main, replies, worker  # noqa: E402

result = {}
if mode != 'inspect':
    config = SimpleNamespace(
        db=database, group='synthetic-group', dry_run=mode == 'dry-run',
        sandbox=False, claim_timeout=600, batch=100, max_attempts=5,
        markdown_replies=mode != 'plain', allowed_link_hosts=('127.0.0.1',),
        log_dir=database.parent / 'synthetic-logs', log_content=False,
        verbose_events=False)
    api = Mock()
    def transport(path, body):
        assert path == '/v2/groups/synthetic-group/messages' or path == '/v2/groups/synthetic-group/files'
        if fault == 'transient': return False, None, dict(_http_status=503)
        if fault == 'permanent': return False, 304061, dict(_http_status=200)
        if fault == 'rate-limit': return False, None, dict(_http_status=429)
        if fault == 'unconfirmed': return False, 0, dict(_http_status=202, _unconfirmed_http=202)
        return True, 0, dict(file_info='SYNTHETIC_FILE') if path.endswith('/files') else dict(id='SYNTHETIC_ONLY')
    api.post.side_effect = transport
    consumer = worker.OutboxWorker(config, api)
    result.update(first=consumer.poll_once(), second=consumer.poll_once(),
                  calls=[dict(path=c.args[0], body=c.args[1]) for c in api.post.call_args_list])

    async def dispatch_original():
        passive = Mock()
        passive.reply_group.return_value = (True, 0, dict(id='SYNTHETIC_REPLY'))
        passive.ack_interaction.return_value = (True, 0, dict(id='SYNTHETIC_ACK'))
        # Only transport is replaced. Construction, event parsing, duplicate
        # handling, policy reads, replies and ACK ordering use the original Bot.
        with patch.object(main, 'QQBotAPI', return_value=passive):
            bot = main.Bot(config)
        await bot.handle_dispatch(None, dict(t='READY', d=dict(
            session_id='SYNTHETIC_SESSION', user=dict(id='SYNTHETIC'))))
        await bot.handle_dispatch(None, dict(t='RESUMED', d={}))
        assert bot.session_id == 'SYNTHETIC_SESSION' and bot.bot_id == 'SYNTHETIC'
        assert bot.last_ready is not None
        aliases = [alias for alias, command in replies.ALIASES.items() if command != '缩写']
        assert len(aliases) == 54
        first = None
        def original_body(alias):
            db = replies.read_db(database)
            try:
                command = replies.ALIASES[alias]
                text, keyboard = replies.answer(db, command, event_id)
                return text, keyboard, main._markdown_reply(db, command, event_id, config)
            finally:
                db.close()

        for index, alias in enumerate(aliases):
            message = dict(t='GROUP_AT_MESSAGE_CREATE', d=dict(
                id='synthetic-message-' + str(index), group_openid='synthetic-group',
                content='<@SYNTHETIC> /' + alias + ' ' + event_id,
                author=dict(id='SYNTHETIC_AUTHOR'), timestamp=str(index)))
            # Countdown text can change while the real clock crosses a minute.
            # Keep exact original bytes from both sides of dispatch; never
            # freeze time, normalize text, or accept arbitrary timer content.
            before_body = original_body(alias) if mode != 'dry-run' else None
            await bot.handle_dispatch(None, message)
            if mode != 'dry-run':
                after_body = original_body(alias)
                call = passive.reply_group.call_args
                assert call.args in [('synthetic-group', body[0]) for body in (before_body, after_body)], dict(alias=alias, actual=call.args, expected=(before_body, after_body))
                assert before_body[1] == after_body[1] == call.kwargs['keyboard']
                assert call.kwargs['seq'] == 1
                assert call.kwargs['msg_id'] == message['d']['id'] and call.kwargs['event_id'] is None
                assert call.kwargs.get('markdown') in (before_body[2], after_body[2])
                if before_body[2] is None and after_body[2] is None: assert 'markdown' not in call.kwargs
            first = first or message
        expected = 0 if mode == 'dry-run' else 54
        assert passive.reply_group.call_count == expected
        await bot.handle_dispatch(None, first)
        await bot.handle_dispatch(None, dict(first, t='GROUP_MESSAGE_CREATE'))
        assert passive.reply_group.call_count == expected
        for ignored in [
                dict(group_openid='synthetic-denied', content='<@SYNTHETIC> /帮助'),
                dict(group_openid='synthetic-group', content='<@all> /帮助', mention_everyone=True),
                dict(group_openid='synthetic-group', content='/帮助'),
                dict(group_openid='synthetic-group', content='<@SYNTHETIC> /帮助', author=dict(bot=True))]:
            await bot.handle_dispatch(None, dict(t='GROUP_AT_MESSAGE_CREATE', d=dict(
                id='synthetic-ignored-' + str(len(passive.mock_calls)), **ignored)))
        assert passive.reply_group.call_count == expected
        callback = dict(t='INTERACTION_CREATE', id='SYNTHETIC_OUTER', d=dict(
            id='SYNTHETIC_INTERACTION', type=11, group_openid='synthetic-group',
            data=dict(resolved=dict(button_data='/我的'))))
        before = len(passive.mock_calls)
        await bot.handle_dispatch(None, callback)
        assert passive.mock_calls[before].args == ('SYNTHETIC_INTERACTION', 0)
        assert passive.mock_calls[before][0] == 'ack_interaction'
        assert passive.ack_interaction.call_count == 1
        assert passive.reply_group.call_count == expected + (mode != 'dry-run')
        if mode != 'dry-run':
            reply = passive.reply_group.call_args
            assert '尚未绑定' in reply.args[1]
            assert reply.kwargs['event_id'] == 'SYNTHETIC_OUTER' and reply.kwargs['msg_id'] is None
        await bot.handle_dispatch(None, callback)
        assert passive.ack_interaction.call_count == 1
        denied = dict(callback, id='SYNTHETIC_DENIED_OUTER', d=dict(
            callback['d'], id='SYNTHETIC_DENIED_INTERACTION', group_openid='synthetic-denied'))
        await bot.handle_dispatch(None, denied)
        assert passive.ack_interaction.call_count == 2
        assert passive.reply_group.call_count == expected + (mode != 'dry-run')
        for call in passive.reply_group.call_args_list:
            assert call.args[0] == 'synthetic-group'
            assert 'PRIVATE_SYNTHETIC_NOTE' not in json.dumps([call.args, call.kwargs])
            if mode == 'plain': assert 'markdown' not in call.kwargs
        return dict(aliases=54, passiveMockReplies=passive.reply_group.call_count,
                    originalReplyBodiesVerified=True if mode != 'dry-run' else None,
                    callbackMockAcks=2, readyAndResumed=True, duplicateEventsSuppressed=True,
                    callbackAckBeforeReply=True if mode != 'dry-run' else None,
                    originalOuterEventIdPreserved=True if mode != 'dry-run' else None,
                    callbackReplySuppressed=mode == 'dry-run',
                    deniedGroupsNeverReplied=True, ignoredMessagesNeverReplied=True,
                    privateIdentityRestriction=True, actualTransportCalls=0)

    try:
        result['dispatch'] = event_loop.run_until_complete(dispatch_original())
    finally:
        event_loop.run_until_complete(event_loop.shutdown_asyncgens())
        event_loop.run_until_complete(event_loop.shutdown_default_executor())
        event_loop.close()

with replies.read_db(database) as db:
    queries = []
    for alias, command in replies.ALIASES.items():
        if command == '缩写':
            continue  # Upstream abbreviation transport has a separate fixture.
        parsed = replies.parse('<@SYNTHETIC> /' + alias + ' ' + event_id)
        assert parsed == (command, event_id)
        text, keyboard = replies.answer(db, *parsed)
        rich = replies.answer_markdown(db, *parsed)
        queries.append(dict(alias=alias, command=command, text=text,
                            keyboard=keyboard, rich=rich))
    result.update(queries=queries,
                  mine=replies.answer(db, '我的')[0],
                  rows=[dict(r) for r in db.execute('SELECT * FROM bot_outbox ORDER BY id')],
                  revision=db.execute('SELECT applied_revision FROM bot_runtime WHERE id=1').fetchone()[0])
if not event_loop.is_closed(): event_loop.close()
print(json.dumps(result, ensure_ascii=False))
