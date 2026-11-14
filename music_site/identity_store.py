"""Private legacy proofs and QQ identity mappings, separate from the board DB."""
import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path


class Rejected(Exception):
    def __init__(self, message, status=409):
        self.message, self.status = message, status


class Store:
    def __init__(self, path):
        self.path = Path(path)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(
                    token_hash TEXT PRIMARY KEY, qq TEXT NOT NULL, expires REAL NOT NULL,
                    source_session TEXT NOT NULL DEFAULT '', pending_until REAL NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS links(
                    qq TEXT PRIMARY KEY, app_id TEXT NOT NULL, openid TEXT NOT NULL,
                    user_id TEXT NOT NULL UNIQUE, created REAL NOT NULL,
                    source TEXT NOT NULL DEFAULT 'legacy_pin_and_qq_oauth',
                    UNIQUE(app_id,openid));
                CREATE TABLE IF NOT EXISTS used_oauth(attempt TEXT PRIMARY KEY, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS prelinks(
                    qq TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS login_attempts(bucket TEXT NOT NULL, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS attempt_bucket ON login_attempts(bucket,created);
                CREATE TABLE IF NOT EXISTS link_overrides(
                    qq TEXT PRIMARY KEY,user_id TEXT NOT NULL,revision INTEGER NOT NULL,updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS link_audit(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,qq TEXT NOT NULL,actor TEXT NOT NULL,
                    before_user_id TEXT NOT NULL,after_user_id TEXT NOT NULL,created REAL NOT NULL);
            ''')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def login_allowed(self, qq, ip):
        stamp = time.time()
        buckets = [('qq:' + self.digest(qq), 8, 3600), ('ip:' + self.digest(ip), 30, 900)]
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM login_attempts WHERE created<?', (stamp-3600,))
            for bucket, limit, seconds in buckets:
                count = db.execute('SELECT COUNT(*) FROM login_attempts WHERE bucket=? AND created>?', (bucket, stamp-seconds)).fetchone()[0]
                if count >= limit:
                    raise Rejected('登录尝试过多，请稍后重试或联系管理员', 429)
            for bucket, _, _ in buckets:
                db.execute('INSERT INTO login_attempts VALUES(?,?)', (bucket, stamp))

    def new_session(self, qq):
        token = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO sessions(token_hash,qq,expires) VALUES(?,?,?)', (self.digest(token), qq, time.time()+3600))
        return token

    def session(self, token):
        with self.connect() as db:
            return db.execute('SELECT * FROM sessions WHERE token_hash=? AND expires>?', (self.digest(token), time.time())).fetchone()

    def logout(self, token):
        with self.connect() as db:
            db.execute('DELETE FROM sessions WHERE token_hash=?', (self.digest(token),))

    def link_for_qq(self, qq):
        with self.connect() as db:
            return (db.execute('SELECT * FROM links WHERE qq=?', (qq,)).fetchone()
                    or db.execute('SELECT * FROM prelinks WHERE qq=?', (qq,)).fetchone())

    def linked_qq(self, context):
        if not context.get('user_id'):
            return ''
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT qq FROM links WHERE app_id=? AND openid=? AND user_id=?',
                             (context.get('app_id',''), context.get('openid',''), context['user_id'])).fetchone()
            if row:
                return row['qq']
            prelink = db.execute('SELECT * FROM prelinks WHERE user_id=?',(context['user_id'],)).fetchone()
            if not prelink:
                return ''
            existing = db.execute('SELECT 1 FROM links WHERE qq=? OR user_id=?',
                                  (prelink['qq'],context['user_id'])).fetchone()
            if existing:
                return ''
            if context.get('app_id') and context.get('openid'):
                try:
                    db.execute("INSERT INTO links(qq,app_id,openid,user_id,created,source) VALUES(?,?,?,?,?,'admin_board_user_id')",
                               (prelink['qq'],context['app_id'],context['openid'],context['user_id'],time.time()))
                except sqlite3.IntegrityError:
                    return ''
            return prelink['qq']

    def import_prelinks(self, records):
        """Only administrator-reviewed, current, unambiguous IDs are accepted."""
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for record in records:
                db.execute('INSERT INTO prelinks VALUES(?,?,?)', (record['qq'],record['user_id'],time.time()))

    def admin_state(self, db, qq):
        link=db.execute('SELECT * FROM links WHERE qq=?',(qq,)).fetchone()
        prelink=db.execute('SELECT * FROM prelinks WHERE qq=?',(qq,)).fetchone()
        override=db.execute('SELECT * FROM link_overrides WHERE qq=?',(qq,)).fetchone()
        revision=self.digest(json.dumps([dict(row) if row else None for row in (link,prelink,override)],sort_keys=True))
        return dict(user_id=(link or prelink)['user_id'] if link or prelink else '',
                    status='oauth' if link else 'prelinked' if prelink else 'unlinked',revision=revision)

    def admin_change(self, qq, user_id, revision, actor):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            before=self.admin_state(db,qq)
            if revision!=before['revision']:
                raise Rejected('成分站关联已改变，请重新载入后核对',409)
            for table in ('links','prelinks'):
                if user_id and db.execute('SELECT 1 FROM '+table+' WHERE user_id=? AND qq!=?',(user_id,qq)).fetchone():
                    raise Rejected('该看板账号已关联其他成分，请先核对并解除原关联',409)
            if user_id and user_id==before['user_id']:
                return before
            for table in ('links','prelinks','sessions'):
                db.execute('DELETE FROM '+table+' WHERE qq=?',(qq,))
            stamp=time.time()
            if user_id:db.execute('INSERT INTO prelinks VALUES(?,?,?)',(qq,user_id,stamp))
            db.execute('''INSERT INTO link_overrides VALUES(?,?,1,?) ON CONFLICT(qq)
                DO UPDATE SET user_id=excluded.user_id,revision=revision+1,updated=excluded.updated''',(qq,user_id,stamp))
            db.execute('INSERT INTO link_audit(qq,actor,before_user_id,after_user_id,created) VALUES(?,?,?,?,?)',
                       (qq,actor,before['user_id'],user_id,stamp))
            return self.admin_state(db,qq)

    def begin(self, token, context):
        if not context.get('session'):
            raise Rejected('请刷新页面后重试', 401)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM sessions WHERE token_hash=? AND expires>?', (self.digest(token), time.time())).fetchone()
            if not row:
                raise Rejected('请先用旧站 QQ 号和口令登录', 401)
            if (db.execute('SELECT 1 FROM links WHERE qq=?', (row['qq'],)).fetchone()
                    or db.execute('SELECT 1 FROM prelinks WHERE qq=?', (row['qq'],)).fetchone()):
                raise Rejected('此旧账号已经连接，请使用 QQ 登录')
            db.execute('UPDATE sessions SET source_session=?,pending_until=? WHERE token_hash=?',
                       (context['session'], time.time()+600, self.digest(token)))

    def complete(self, token, context):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM sessions WHERE token_hash=? AND expires>?', (self.digest(token), time.time())).fetchone()
            if not row or row['pending_until'] <= time.time():
                raise Rejected('连接已过期，请重新登录旧账号并连接 QQ', 401)
            if (not all(context.get(k) for k in ('app_id','openid','user_id','oauth_attempt','oauth_source'))
                    or context['oauth_source'] != row['source_session']):
                raise Rejected('请完成本次 QQ 授权后再连接', 401)
            existing = db.execute('SELECT * FROM links WHERE qq=? OR user_id=? OR (app_id=? AND openid=?)',
                                  (row['qq'], context['user_id'], context['app_id'], context['openid'])).fetchall()
            prelinked = db.execute('SELECT 1 FROM prelinks WHERE qq=? OR user_id=?', (row['qq'],context['user_id'])).fetchone()
            if existing or prelinked:
                raise Rejected('账号已有连接记录，请联系管理员核对，原资料不会覆盖')
            try:
                db.execute('INSERT INTO used_oauth VALUES(?,?)', (context['oauth_attempt'], time.time()))
                db.execute('INSERT INTO links(qq,app_id,openid,user_id,created) VALUES(?,?,?,?,?)',
                           (row['qq'], context['app_id'], context['openid'], context['user_id'], time.time()))
            except sqlite3.IntegrityError:
                raise Rejected('授权已使用或账号已有连接，请联系管理员核对') from None
            db.execute('DELETE FROM sessions WHERE qq=?', (row['qq'],))
            return row['qq']
