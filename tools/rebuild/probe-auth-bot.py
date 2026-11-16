"""Read-only synthetic identity checkpoint probe. Never initializes or sends bot work."""
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from qgroup_core import accounts, bot_views, identity  # noqa: E402

path = Path(sys.argv[1]).resolve()
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    assert db.execute('SELECT baseline FROM rebuild_schema').fetchone()[0] == '8da877857f163853c449474e168534e2e493121b'
    assert db.execute("SELECT nickname FROM users WHERE id='alice'").fetchone()[0] == '小青'
    event = db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
    print(json.dumps(dict(
        shareable=bot_views.shareable(event),
        counts=bot_views.counts(db, 'listen'),
        roster=bot_views.roster_lines(db, event),
        scope=identity.scope('alice'),
        linked=accounts.linked(db, 'alice'),
        name_registration=accounts.settings(db)['allow_name_registration'],
        outbox=[dict(row) for row in db.execute('SELECT id,status,attempts,target,payload_json,claim_token,simulated_at FROM bot_outbox ORDER BY id')],
    ), ensure_ascii=False))
