"""Atomic event revisions, append-only history, and station notifications."""
import json
import logging

from . import bot_outbox
from .common import APIError, now


def bot_hook(db, function, *args):
    """Queue bot messages without ever letting a bot failure affect the write.

    The outbox is a convenience, not business data. A malformed field, a schema
    mismatch or a SQLite error while composing a card must never roll back a
    registration, a settlement or an immutable ledger entry.
    """
    try:
        function(db, *args)
    except Exception:
        logging.exception('[bot] outbox hook failed; business write is unaffected')


def require_revision(event, data):
    value = data.get('base_revision')
    if type(value) is not int or value < 0:
        raise APIError('请刷新活动后再操作', 409)
    if value != event['revision']:
        raise APIError('活动或名单已有更新，请刷新后重新确认', 409)


def append(db, event, user, action, before, after, reason='', *, queue_bot=True):
    if before == after:
        return
    version = db.execute('SELECT revision FROM events WHERE id=?', (event['id'],)).fetchone()[0] + 1
    db.execute('UPDATE events SET revision=? WHERE id=?', (version,event['id']))
    db.execute('''INSERT INTO event_audit(event_id,version,actor_id,actor_name,action,
        before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)''',
        (event['id'],version,user['id'] if user else None,user['nickname'] if user else '系统',action,
         json.dumps(before,ensure_ascii=False),json.dumps(after,ensure_ascii=False),reason,now()))
    # Same transaction as the audit row: a broadcast describes a committed fact,
    # and de-duplication (not throttling) keeps one fact to one message.
    # Composite operations may defer this hook until their final write, while
    # keeping it inside the caller's transaction (e.g. automatic registration).
    if queue_bot:
        bot_hook(db, bot_outbox.on_append, event, user, action, before, after, reason)


def notify(db, user_id, event_id, kind, message):
    db.execute('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)',
        (user_id,event_id,kind,message,now()))
    bot_hook(db, bot_outbox.on_notify, user_id, event_id, kind, message)
