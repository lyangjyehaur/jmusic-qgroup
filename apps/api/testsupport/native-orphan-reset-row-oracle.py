"""Read only serialized fixture copies; independent SQLite storage oracle."""
import json
import sqlite3
import sys
from contextlib import ExitStack, closing
from pathlib import Path

root = Path(sys.argv[1])
with ExitStack() as stack:
    before, source, candidate = [stack.enter_context(closing(sqlite3.connect(
        (root / name).as_uri() + '?mode=ro', uri=True)))
        for name in ('before.sqlite3', 'source.sqlite3', 'candidate.sqlite3')]
    assert candidate.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    assert not candidate.execute('PRAGMA foreign_key_check').fetchall()
    assert source.execute('SELECT * FROM sqlite_master ORDER BY name').fetchall() == candidate.execute('SELECT * FROM sqlite_master ORDER BY name').fetchall()
    for name in ('user_version', 'application_id', 'encoding'):
        assert source.execute('PRAGMA ' + name).fetchall() == candidate.execute('PRAGMA ' + name).fetchall()
    scope = {
        'music_shouts': {(r[0],) for r in before.execute('SELECT id FROM music_shouts')},
        'music_shout_authors': {(r[0],) for r in before.execute('SELECT profile_id FROM music_shout_authors')},
        'music_documents': set(before.execute("SELECT kind,position FROM music_documents WHERE kind IN ('shouts','shoutHistory','trend','trend_sample')")),
        'migration_map': set(before.execute("SELECT source,entity_type,source_id FROM migration_map WHERE source='music' AND entity_type IN ('shouts','shoutHistory','trend')")),
    }
    fields = {'music_shouts': ['id'], 'music_shout_authors': ['profile_id'],
              'music_documents': ['kind', 'position'], 'migration_map': ['source', 'entity_type', 'source_id']}
    removed = changed = retained = 0
    tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for table in tables:
        cols = [r[1] for r in source.execute('PRAGMA table_xinfo("' + table + '")')]
        query = 'SELECT rowid,*,' + ','.join('typeof("' + col + '")' for col in cols) + ' FROM "' + table + '" ORDER BY rowid'
        wanted = []
        for row in source.execute(query):
            value = dict(zip(['_rowid'] + cols, row[:len(cols) + 1]))
            included = table in scope and tuple(value[k] for k in fields[table]) in scope[table]
            if included and table != 'migration_map':
                removed += 1
                continue
            next_row = list(row)
            if included:
                next_row[1 + cols.index('status')] = 'deleted'
            if next_row == list(row):
                retained += 1
            else:
                changed += 1
            wanted.append(tuple(next_row))
        assert wanted == candidate.execute(query).fetchall(), table
    assert removed == 7 and changed == 4 and retained > 0
    print(json.dumps(dict(allTables=len(tables), removedRows=removed,
                         changedRows=changed, retainedRows=retained,
                         allRowsAndStorageVerified=True)))
