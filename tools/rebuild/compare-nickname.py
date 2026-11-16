"""Apply the preserved Python profile behavior only to a caller-created synthetic DB."""
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from qgroup_core import audit, roster  # noqa: E402

path, nickname, stamp = sys.argv[1:]
# No initialization, network calls, bot worker or production configuration loading.
with sqlite3.connect(path) as db:
    db.row_factory = sqlite3.Row
    assert db.execute('SELECT baseline FROM rebuild_schema').fetchone()[0] == '8da877857f163853c449474e168534e2e493121b'
    user = db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
    assert user['nickname'] == '小青'
    assert db.execute("SELECT simulated_at FROM bot_outbox LIMIT 1").fetchone()[0] == 'simulation-only'
    audit.now = lambda: stamp
    # This is the legacy /api/profile write; roster.record/audit.append/bot hooks
    # remain the original Python implementation, not a second TypeScript model.
    if nickname != user['nickname']:
        affected = db.execute("SELECT DISTINCT event_id FROM attendees WHERE user_id=? AND status!='withdrawn'", (user['id'],)).fetchall()
        snapshots = {row[0]: roster.snapshot(db, row[0]) for row in affected}
        db.execute('UPDATE users SET nickname=? WHERE id=?', (nickname, user['id']))
        for event_id, before in snapshots.items():
            event = db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()
            roster.record(db, event, user, 'nickname_changed', before)
    tables = ['users', 'events', 'attendees', 'roster_parties', 'finance_entries', 'settlements', 'bot_settings', 'bot_outbox']
    result = {table: [dict(row) for row in db.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in tables}
    result['event_audit'] = []
    for row in db.execute('SELECT * FROM event_audit ORDER BY event_id,version'):
        value = dict(row)
        value.pop('id')  # New audit IDs are global, while the contract is per-event version.
        for field in ('before_json', 'after_json'):
            value[field] = json.loads(value[field])
        result['event_audit'].append(value)
    print(json.dumps(result, ensure_ascii=False))
