"""Optional QQ UnionID metadata; OpenID remains the account lookup key."""
import logging
import re
from .common import now


def normalize(value):
    return value if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,256}',value) else ''


def migrate(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=12').fetchone():return
    if 'union_id' not in {r['name'] for r in db.execute('PRAGMA table_info(login_attempts)')}:
        db.execute("ALTER TABLE login_attempts ADD COLUMN union_id TEXT NOT NULL DEFAULT ''")
    db.execute('''CREATE TABLE IF NOT EXISTS external_unionids(
        provider TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,
        union_id TEXT NOT NULL CHECK(length(union_id)>0),created_at TEXT NOT NULL,
        PRIMARY KEY(provider,client_id,subject),
        FOREIGN KEY(provider,client_id,subject)
            REFERENCES external_identities(provider,client_id,subject) ON DELETE CASCADE)''')
    db.execute('INSERT INTO schema_migrations VALUES(12,?)',(now(),))


def link(db,app_id,openid,value):
    """Backfill only the exact existing provider identity, never merge accounts."""
    value=normalize(value)
    if not value:return
    row=db.execute("SELECT union_id FROM external_unionids WHERE provider='qq' AND client_id=? AND subject=?",
                   (app_id,openid)).fetchone()
    if row:
        # Unexpected changes require investigation, not overwriting an existing link.
        logging.info('qq_unionid_link status=%s','unchanged' if row[0]==value else 'conflict_preserved')
        return
    db.execute("INSERT INTO external_unionids VALUES('qq',?,?,?,?)",(app_id,openid,value,now()))
    logging.info('qq_unionid_link status=backfill_staged')
