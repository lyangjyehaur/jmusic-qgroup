"""Explicit consent, browser logout, and truthful account erasure tracking.

Shared activity/finance records require individual review. Closing an account
removes provider credentials and private data, without rewriting other people's
immutable ledgers. Such requests stay open in the administrator queue.
"""
import json
import os
import secrets
from pathlib import Path
from .common import APIError, now
from . import identity, media

VERSION='2026-11-10'
CONTACT='203008876@qq.com'


def accepted(db,user):
    return bool(user and db.execute('SELECT 1 FROM privacy_consents WHERE user_id=? AND version=?',(user['id'],VERSION)).fetchone())


def require_consent(data):
    if data.get('accept_privacy') is not True or data.get('privacy_version')!=VERSION:
        raise APIError('请阅读并勾选同意隐私政策后继续',400)


def consent(db,uid):
    db.execute('INSERT OR REPLACE INTO privacy_consents VALUES(?,?,?)',(uid,VERSION,now()))


def logout(db,session):
    db.execute('DELETE FROM login_attempts WHERE token_hash=?',(session,))
    db.execute('DELETE FROM auth_requests WHERE token_hash=?',(session,))
    db.execute('DELETE FROM browser_accounts WHERE token_hash=?',(session,))
    db.execute('DELETE FROM browser_sessions WHERE token_hash=?',(session,))
    db.execute('DELETE FROM visitor_sessions WHERE token_hash=?',(session,))
    return dict(ok=True)


def shared_records(db,uid):
    # Include historical/withdrawn records and non-FK actor IDs. A request cannot
    # be marked complete just because its current roster happens to be empty.
    checks={
        'events':('owner_id',), 'registrations':('user_id',),
        'roster_parties':('manager_id',), 'attendees':('user_id','manager_id'),
        'event_audit':('actor_id',),'attendee_consents':('actor_id',),
        'event_roles':('user_id',),'management_invitations':('recipient_id','initiator_id','accepted_by'),
        'settlement_history':('actor_id',),'finance_reports':('reporter_id',),
        'finance_report_actions':('actor_id',),'finance_entries':('actor_id',),
        'attendee_claims':('issuer_id','requester_id'), 'attendee_payment_origins':('payer_user_id',),
        'time_polls':('owner_id',), 'time_poll_history':('actor_id',),
    }
    return {table:count for table,columns in checks.items()
            if (count:=db.execute('SELECT count(*) FROM '+table+' WHERE '+' OR '.join(c+'=?' for c in columns),(uid,)*len(columns)).fetchone()[0])}


def journal(db,entry):
    # This deletion-only journal deliberately lives outside rolling DB backups.
    # Reapply it before accepting traffic after a restore. It contains random
    # internal IDs only; never OpenIDs, names, email addresses or tokens.
    path=Path(next(r[2] for r in db.execute('PRAGMA database_list') if r[1]=='main')).with_suffix('.erasures.jsonl')
    fd=os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600)
    with os.fdopen(fd,'a') as stream:
        stream.write(json.dumps(entry,separators=(',',':'))+'\n');stream.flush();os.fsync(stream.fileno())
    directory=os.open(str(path.parent),os.O_RDONLY)
    try:os.fsync(directory)
    finally:os.close(directory)


def erase(db,uid,request_id,created_at):
    if not db.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone():return
    role=db.execute('SELECT * FROM user_admin_roles WHERE user_id=? AND is_admin=1',(uid,)).fetchone()
    if role:
        stamp=now()
        db.execute('UPDATE user_admin_roles SET is_admin=0,revision=revision+1,updated_at=? WHERE user_id=?',(stamp,uid))
        db.execute('''INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at)
            VALUES(?,'account_closure',1,0,?,?)''',(uid,role['revision']+1,stamp))
    shared=shared_records(db,uid)
    db.execute('''UPDATE time_polls SET vote_revision=vote_revision+1
        WHERE status IN ('open','closed') AND id IN
        (SELECT poll_id FROM time_poll_ballots WHERE user_id=?)''',(uid,))
    db.execute('DELETE FROM time_poll_votes WHERE user_id=?',(uid,))
    db.execute('DELETE FROM time_poll_ballots WHERE user_id=?',(uid,))
    db.execute('''DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(
        SELECT 1 FROM external_identities x WHERE x.user_id=? AND x.provider='qq'
        AND x.client_id=login_attempts.app_id AND x.subject=login_attempts.openid)''',(uid,))
    sessions=[r[0] for r in db.execute('SELECT token_hash FROM browser_sessions WHERE user_id=?',(uid,))]
    for session in sessions:logout(db,session)
    db.execute('DELETE FROM browser_accounts WHERE user_id=?',(uid,))
    for table in ('external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts',
                  'privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata'):
        db.execute('DELETE FROM '+table+' WHERE user_id=?',(uid,))
    db.execute('''DELETE FROM image_assets WHERE NOT EXISTS(SELECT 1 FROM user_payment_codes WHERE digest=image_assets.digest)
        AND NOT EXISTS(SELECT 1 FROM settlement_code_images WHERE digest=image_assets.digest)
        AND NOT EXISTS(SELECT 1 FROM settlement_receipt_images WHERE digest=image_assets.digest)''')
    db.execute('DELETE FROM event_access WHERE user_id=?',(uid,))
    # Keep a non-login tombstone to preserve shared ledger foreign keys. This is
    # account closure, not a claim that all shared content has been anonymized.
    db.execute("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=?",(secrets.token_hex(32),uid))
    status='shared_review' if shared else 'completed'
    db.execute('''INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at''',
        (request_id,uid,status,created_at,now()))
    return dict(ok=True,request_id=request_id,status=status,shared_records=shared)


def close(db,user,data):
    if data.get('confirm_close') is not True:raise APIError('请确认注销账号并申请删除资料')
    if db.execute("SELECT 1 FROM time_polls WHERE owner_id=? AND status IN ('open','closed')",(user['id'],)).fetchone():
        raise APIError('请先定案或取消仍由你管理的时间投票，再注销账号',409)
    if db.execute("SELECT 1 FROM events WHERE owner_id=? AND lifecycle NOT IN ('ended','cancelled') AND status!='deleted' AND archived_at IS NULL",(user['id'],)).fetchone():
        raise APIError('请先转交或结束仍由你管理的活动，再注销账号',409)
    request_id=secrets.token_hex(16);created_at=now()
    # Once this durable intent is written, a restart must finish it even if the
    # HTTP connection dies. All validation happens before writing the intent.
    journal(db,dict(user_id=user['id'],request_id=request_id,created_at=created_at))
    return erase(db,user['id'],request_id,created_at)


def recover(path):
    from . import storage
    ledger=Path(path).with_suffix('.erasures.jsonl')
    if ledger.exists():
        with storage.connect(path) as db:
            db.execute('BEGIN IMMEDIATE')
            for line in ledger.read_text().splitlines():
                item=json.loads(line)
                if not db.execute('SELECT 1 FROM privacy_requests WHERE user_id=?',(item['user_id'],)).fetchone():
                    erase(db,item['user_id'],item['request_id'],item['created_at'])
    prune(path)


def prune(path):
    from . import storage
    # All app image writers obtain BEGIN IMMEDIATE before writing their files.
    # Holding the same lock protects files of in-flight uploads from collection.
    with storage.connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        folder=media.root(db)
        for image in folder.glob('*/*.png'):
            if image.is_symlink():continue
            if not db.execute('SELECT 1 FROM image_assets WHERE digest=?',(image.stem,)).fetchone():image.unlink()


def queue(db):
    return [dict(r,shared_records=shared_records(db,r['user_id'])) for r in db.execute('SELECT * FROM privacy_requests ORDER BY created_at DESC LIMIT 100')]


def review(db,data):
    entry=db.execute('SELECT * FROM privacy_requests WHERE id=?',(data.get('request_id'),)).fetchone()
    if not entry:raise APIError('删除申请不存在',404)
    note=data.get('note')
    if not isinstance(note,str) or not 1<=len(note.strip())<=1000:raise APIError('请填写处理说明，最多 1000 字')
    # Completing a shared-record erasure requires real data removal. A free-form
    # administrator checkbox is not sufficient evidence that it happened.
    status='shared_review' if shared_records(db,entry['user_id']) else 'completed'
    db.execute('UPDATE privacy_requests SET note=?,status=?,updated_at=? WHERE id=?',(note.strip(),status,now(),entry['id']))
    return dict(ok=True)
