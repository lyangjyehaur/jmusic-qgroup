"""Synthetic compiled-web fixture only; transport cannot leave this process."""
import json
import socket
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


def deny_network(*_args, **_kwargs):
    raise AssertionError('Retained bot fixture cannot use network transport')


socket.socket = deny_network
source, database, mode, event_id, origin = sys.argv[1:]
source, database = Path(source).resolve(), Path(database).resolve()
assert mode in ('plain', 'rich', 'dry-run', 'inspect')
assert source.parent == database.parent and source.name == 'original-python'
assert database.name == 'synthetic.sqlite3'
assert origin.startswith('http://127.0.0.1:')
sys.path.insert(0, str(source))
from qgroup_bot import replies, worker  # noqa: E402

result = {}
if mode != 'inspect':
    config = SimpleNamespace(
        db=database, group='synthetic-group', dry_run=mode == 'dry-run',
        sandbox=False, claim_timeout=600, batch=100, max_attempts=5,
        markdown_replies=mode != 'plain', allowed_link_hosts=('127.0.0.1',),
        log_dir=database.parent / 'synthetic-logs', log_content=False)
    api = Mock()
    api.post.return_value = (True, 0, dict(id='SYNTHETIC_ONLY'))
    consumer = worker.OutboxWorker(config, api)
    result.update(first=consumer.poll_once(), second=consumer.poll_once(),
                  calls=[dict(path=c.args[0], body=c.args[1]) for c in api.post.call_args_list])

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
print(json.dumps(result, ensure_ascii=False))
