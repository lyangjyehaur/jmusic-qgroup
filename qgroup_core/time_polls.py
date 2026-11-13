"""Availability polls precede normal events and never reserve roster places."""
import json
import secrets
from datetime import datetime, timedelta

from . import audit, events, bot_outbox
from .common import APIError, date_value, now, string


def migrate(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=16').fetchone():
        migrate_notifications(db)
        return
    statements = [
        '''CREATE TABLE time_polls (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
            title TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
            description TEXT NOT NULL, timezone TEXT NOT NULL, duration_hours INTEGER NOT NULL,
            capacity INTEGER NOT NULL, minimum_participants INTEGER NOT NULL,
            fee_policy TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
            revision INTEGER NOT NULL DEFAULT 1, vote_revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, decided_at TEXT, selected_option_id TEXT,
            event_id TEXT UNIQUE REFERENCES events(id), reason TEXT NOT NULL DEFAULT '',
            result_json TEXT, respondent_count INTEGER)''',
        '''CREATE TABLE time_poll_options (
            id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES time_polls(id),
            position INTEGER NOT NULL, starts_at TEXT NOT NULL,
            UNIQUE(poll_id,id), UNIQUE(poll_id,starts_at))''',
        '''CREATE TABLE time_poll_ballots (
            poll_id TEXT NOT NULL REFERENCES time_polls(id), user_id TEXT NOT NULL REFERENCES users(id),
            updated_at TEXT NOT NULL, PRIMARY KEY(poll_id,user_id))''',
        '''CREATE TABLE time_poll_votes (
            poll_id TEXT NOT NULL, user_id TEXT NOT NULL, option_id TEXT NOT NULL,
            choice TEXT NOT NULL CHECK(choice IN ('yes','maybe','no')),
            PRIMARY KEY(poll_id,user_id,option_id),
            FOREIGN KEY(poll_id,user_id) REFERENCES time_poll_ballots(poll_id,user_id),
            FOREIGN KEY(poll_id,option_id) REFERENCES time_poll_options(poll_id,id))''',
        '''CREATE TABLE time_poll_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id TEXT NOT NULL REFERENCES time_polls(id),
            actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
            details_json TEXT NOT NULL, created_at TEXT NOT NULL)''',
        '''CREATE TRIGGER time_poll_history_no_update BEFORE UPDATE ON time_poll_history
            BEGIN SELECT RAISE(ABORT, 'Time poll history is append-only'); END''',
        '''CREATE TRIGGER time_poll_history_no_delete BEFORE DELETE ON time_poll_history
            BEGIN SELECT RAISE(ABORT, 'Time poll history is append-only'); END''',
    ]
    for statement in statements:
        db.execute(statement)
    db.execute('INSERT INTO schema_migrations VALUES(16,?)', (now(),))
    migrate_notifications(db)


def migrate_notifications(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=17').fetchone():
        return
    db.execute('ALTER TABLE time_polls ADD COLUMN bot_enabled INTEGER NOT NULL DEFAULT 0 CHECK(bot_enabled IN (0,1))')
    # Polls precede events. Preserve existing jobs and delivery fences while
    # allowing each immutable intent to belong to exactly one of the two.
    sequence = db.execute("SELECT seq FROM sqlite_sequence WHERE name='bot_outbox'").fetchone()
    db.execute('''CREATE TABLE bot_outbox_with_polls(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT REFERENCES events(id), poll_id TEXT REFERENCES time_polls(id),
        kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'group' CHECK(channel IN ('group','private')),
        target TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL, due_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped')),
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        claimed_at TEXT, created_at TEXT NOT NULL, sent_at TEXT, retry_at TEXT,
        simulated_at TEXT, delivered_payload_json TEXT, claim_token TEXT NOT NULL DEFAULT '',
        recipient_user_id TEXT REFERENCES users(id),
        CHECK((event_id IS NOT NULL AND poll_id IS NULL) OR (event_id IS NULL AND poll_id IS NOT NULL)),
        UNIQUE(event_id,kind,dedupe_key,channel,target),
        UNIQUE(poll_id,kind,dedupe_key,channel,target))''')
    columns=','.join(r['name'] for r in db.execute('PRAGMA table_info(bot_outbox)'))
    db.execute('INSERT INTO bot_outbox_with_polls('+columns+') SELECT '+columns+' FROM bot_outbox')
    db.execute('DROP TABLE bot_outbox')
    db.execute('ALTER TABLE bot_outbox_with_polls RENAME TO bot_outbox')
    if sequence:
        db.execute("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='bot_outbox'",(sequence[0],))
    db.execute('CREATE INDEX bot_outbox_due ON bot_outbox(status,due_at,id)')
    db.execute('CREATE INDEX bot_outbox_event ON bot_outbox(event_id,created_at)')
    db.execute('CREATE INDEX bot_outbox_poll ON bot_outbox(poll_id,created_at)')
    db.execute('''CREATE TRIGGER bot_outbox_payload_immutable BEFORE UPDATE ON bot_outbox
        WHEN NEW.event_id IS NOT OLD.event_id OR NEW.poll_id IS NOT OLD.poll_id OR NEW.kind!=OLD.kind
          OR NEW.dedupe_key!=OLD.dedupe_key OR NEW.channel!=OLD.channel
          OR NEW.payload_json!=OLD.payload_json OR NEW.due_at IS NOT OLD.due_at
          OR NEW.created_at!=OLD.created_at
        BEGIN SELECT RAISE(ABORT,'Outbox payload is immutable'); END''')
    db.execute('INSERT INTO schema_migrations VALUES(17,?)',(now(),))


def get(db, poll_id):
    poll = db.execute('SELECT * FROM time_polls WHERE id=?', (poll_id,)).fetchone()
    if not poll:
        raise APIError('时间投票不存在', 404)
    return poll


def record(db, poll_id, user, action, details):
    db.execute('''INSERT INTO time_poll_history(poll_id,actor_id,action,details_json,created_at)
        VALUES(?,?,?,?,?)''', (poll_id, user['id'], action, json.dumps(details, ensure_ascii=False), now()))


def options(db, poll):
    return db.execute('SELECT * FROM time_poll_options WHERE poll_id=? ORDER BY position', (poll['id'],)).fetchall()


def totals(db, poll):
    if poll['result_json']:
        return json.loads(poll['result_json'])
    result = {o['id']: dict(yes=0, maybe=0, no=0) for o in options(db, poll)}
    for row in db.execute('''SELECT option_id,choice,count(*) AS total FROM time_poll_votes
                             WHERE poll_id=? GROUP BY option_id,choice''', (poll['id'],)):
        result[row['option_id']][row['choice']] = row['total']
    return result


def serialize(db, poll, viewer):
    owner = poll['owner_id'] == viewer
    counts = totals(db, poll)
    choices = {r['option_id']: r['choice'] for r in db.execute(
        'SELECT option_id,choice FROM time_poll_votes WHERE poll_id=? AND user_id=?', (poll['id'], viewer))}
    status = 'closed' if poll['status'] == 'open' and poll['deadline'] <= now() else poll['status']
    opts = [dict(id=o['id'], starts_at=o['starts_at'],
                 ends_at=(datetime.fromisoformat(o['starts_at'])+timedelta(hours=poll['duration_hours'])).isoformat(),
                 **counts[o['id']]) for o in options(db, poll)]
    maximum = max(o['yes'] for o in opts)
    result = {k: poll[k] for k in ('id','title','category','location','description','timezone','duration_hours',
        'capacity','minimum_participants','fee_policy','deadline','revision','vote_revision','created_at',
        'decided_at','selected_option_id','event_id','reason')}
    result.update(time_poll=True, status=status, is_owner=owner, my_choices=choices,
                  has_voted=bool(choices), can_vote=bool(viewer and status == 'open'),
                  can_manage=owner and status in ('open','closed'), options=opts,
                  leading_option_ids=[o['id'] for o in opts if o['yes'] == maximum and maximum > 0],
                  respondent_count=poll['respondent_count'] if poll['respondent_count'] is not None else db.execute(
                      'SELECT count(*) FROM time_poll_ballots WHERE poll_id=?', (poll['id'],)).fetchone()[0],
                  owner_name=db.execute('SELECT nickname FROM users WHERE id=?', (poll['owner_id'],)).fetchone()[0])
    if owner:
        result['bot_enabled']=bool(poll['bot_enabled'])
        result['bot_feature_enabled']=bot_outbox.enabled(db)
        result['bot_notice_enabled']=bot_outbox.enabled(db) and 'time_poll_published' in bot_outbox.broadcast_kinds(db)
        result['bot_delivery']=[dict(r,state='simulated' if r['simulated_at'] or r['last_error']=='dry-run' else r['status'])
            for r in db.execute('''SELECT id,status,attempts,last_error,created_at,sent_at,simulated_at
                FROM bot_outbox WHERE poll_id=? AND channel='group' ORDER BY id DESC LIMIT 12''',(poll['id'],))]
        result['respondents'] = [dict(name=r['nickname'], updated_at=r['updated_at'],
            choices={v['option_id']: v['choice'] for v in db.execute(
                'SELECT option_id,choice FROM time_poll_votes WHERE poll_id=? AND user_id=?', (poll['id'],r['user_id']))})
            for r in db.execute('''SELECT b.user_id,b.updated_at,u.nickname FROM time_poll_ballots b
                JOIN users u ON u.id=b.user_id WHERE poll_id=? ORDER BY b.updated_at''', (poll['id'],))]
        result['history'] = [dict(action=r['action'], details=json.loads(r['details_json']), created_at=r['created_at'])
            for r in db.execute('SELECT * FROM time_poll_history WHERE poll_id=? ORDER BY id', (poll['id'],))]
    return result


def create(db, user, data):
    if data.get('visibility','public') != 'public':
        raise APIError('当前时间投票为公开可见，请勿填写私人信息')
    candidates = data.get('options')
    if not isinstance(candidates, list) or not 2 <= len(candidates) <= 6 or any(not isinstance(c,dict) for c in candidates):
        raise APIError('请提供 2–6 个候选时段')
    starts = [date_value(c,'starts_at') for c in candidates]
    if len(set(starts)) != len(starts):
        raise APIError('候选时段不能重复')
    deadline = date_value(data,'deadline')
    if not now() < deadline < min(starts):
        raise APIError('投票截止需晚于现在，并早于所有候选时段')
    template = dict(data, starts_at=min(starts), deadline=deadline, visibility='public', bot_enabled=False)
    title,category,location,_,_,capacity,description,duration = events.event_values(template)
    _,_,zone,minimum,fee = events.settings(template)
    bot_enabled=events.bot_setting(dict(data,bot_enabled=data.get('bot_enabled',True)),'public')
    if not zone:
        raise APIError('请选择有效时区')
    uid = secrets.token_hex(8)
    db.execute('''INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,
        duration_hours,capacity,minimum_participants,fee_policy,deadline,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (uid,user['id'],title,category,location,description,zone,duration,capacity,minimum,fee,deadline,now()))
    for index,start in enumerate(starts):
        db.execute('INSERT INTO time_poll_options VALUES(?,?,?,?)', (secrets.token_hex(8),uid,index,start))
    db.execute('UPDATE time_polls SET bot_enabled=? WHERE id=?',(int(bot_enabled),uid))
    record(db,uid,user,'created',dict(options=starts,deadline=deadline))
    audit.bot_hook(db,bot_outbox.announce_poll,get(db,uid))
    return get(db,uid)


def vote(db, poll, user, data):
    audit.require_revision(poll,data)
    if poll['status'] != 'open' or poll['deadline'] <= now():
        raise APIError('投票已截止，请查看最终安排',409)
    choices = data.get('choices')
    option_ids = {o['id'] for o in options(db,poll)}
    if (not isinstance(choices,list) or len(choices)!=len(option_ids)
            or any(not isinstance(c,dict) or not isinstance(c.get('option_id'),str)
                   or c.get('choice') not in ('yes','maybe','no') for c in choices)
            or {c['option_id'] for c in choices} != option_ids):
        raise APIError('请为每个候选时段选择可以、勉强可以或不行')
    db.execute('''INSERT INTO time_poll_ballots VALUES(?,?,?) ON CONFLICT(poll_id,user_id)
        DO UPDATE SET updated_at=excluded.updated_at''', (poll['id'],user['id'],now()))
    db.execute('DELETE FROM time_poll_votes WHERE poll_id=? AND user_id=?', (poll['id'],user['id']))
    for choice in choices:
        db.execute('INSERT INTO time_poll_votes VALUES(?,?,?,?)',
                   (poll['id'],user['id'],choice['option_id'],choice['choice']))
    db.execute('UPDATE time_polls SET vote_revision=vote_revision+1 WHERE id=?',(poll['id'],))


def manage(db, poll, user, data):
    if poll['owner_id'] != user['id']:
        raise APIError('只有发起者可以管理时间投票',403)
    audit.require_revision(poll,data)
    if poll['status'] not in ('open','closed'):
        raise APIError('时间投票已定案或取消',409)
    action = data.get('action')
    reason = string(data,'reason',200,False)
    details = dict(reason=reason)
    if action == 'bot_sync':
        enabled=events.bot_setting(data,'public',poll)
        db.execute('UPDATE time_polls SET bot_enabled=? WHERE id=?',(int(enabled),poll['id']))
        if enabled:audit.bot_hook(db,bot_outbox.announce_poll,get(db,poll['id']),'sync:'+str(poll['revision']))
        else:db.execute("UPDATE bot_outbox SET status='skipped',last_error='投票已关闭群同步' WHERE poll_id=? AND status IN ('pending','sending')",(poll['id'],))
        details['bot_enabled']=enabled
    elif action == 'bot_retry':
        bot_outbox.retry_poll(db,poll,data.get('outbox_id'))
    elif action == 'close':
        db.execute("UPDATE time_polls SET status='closed' WHERE id=?",(poll['id'],))
    elif action == 'extend':
        deadline = date_value(data,'deadline')
        if not now() < deadline < min(o['starts_at'] for o in options(db,poll)):
            raise APIError('投票截止需晚于现在，并早于所有候选时段')
        db.execute("UPDATE time_polls SET deadline=?,status='open' WHERE id=?",(deadline,poll['id']))
        details['deadline'] = deadline
    elif action == 'cancel':
        if not reason:
            raise APIError('请填写取消投票的原因')
        db.execute("UPDATE time_polls SET status='cancelled',reason=?,decided_at=? WHERE id=?",(reason,now(),poll['id']))
    elif action == 'finalize':
        if data.get('accept_terms') is not True:
            raise APIError('请确认场地与安排，并在发布后另行接受正式报名')
        if type(data.get('base_vote_revision')) is not int or data['base_vote_revision'] != poll['vote_revision']:
            raise APIError('票数已有更新，请刷新并重新核对后定案',409)
        selected = next((o for o in options(db,poll) if o['id']==data.get('option_id')),None)
        if selected is None:
            raise APIError('请选择本次投票的候选时段')
        counts = totals(db,poll)
        support = counts[selected['id']]['yes']
        if (support == 0 or support < poll['minimum_participants'] or support < max(c['yes'] for c in counts.values())) and not reason:
            raise APIError('未选最高票或未达最低人数，请填写仍决定举行的原因')
        deadline = date_value(data,'registration_deadline')
        if not now() < deadline <= selected['starts_at']:
            raise APIError('报名截止需晚于现在，且不能晚于选定的开始时间')
        event_id = events.create(db,user,dict(title=poll['title'],category=poll['category'],location=poll['location'],
            description=poll['description'],timezone=poll['timezone'],duration_hours=poll['duration_hours'],
            capacity=poll['capacity'],minimum_participants=poll['minimum_participants'],fee_policy=poll['fee_policy'],
            starts_at=selected['starts_at'],deadline=deadline,visibility='public',bot_enabled=bool(poll['bot_enabled'])))
        db.execute('''UPDATE time_polls SET status='finalized',event_id=?,selected_option_id=?,reason=?,
            decided_at=?,result_json=?,respondent_count=? WHERE id=?''',
            (event_id,selected['id'],reason,now(),json.dumps(counts),
             db.execute('SELECT count(*) FROM time_poll_ballots WHERE poll_id=?',(poll['id'],)).fetchone()[0],poll['id']))
        for row in db.execute('SELECT user_id FROM time_poll_ballots WHERE poll_id=? AND user_id!=?',(poll['id'],user['id'])):
            audit.notify(db,row['user_id'],event_id,'time_poll_finalized',poll['title']+' 的时间已确定，请查看安排后报名')
        details.update(event_id=event_id,option_id=selected['id'],counts=counts)
    else:
        raise APIError('不支持的时间投票操作')
    if action in ('close','cancel','finalize'):
        db.execute("UPDATE bot_outbox SET status='skipped',last_error='投票已截止、定案或取消' WHERE poll_id=? AND status IN ('pending','sending')",(poll['id'],))
    db.execute('UPDATE time_polls SET revision=revision+1 WHERE id=?',(poll['id'],))
    record(db,poll['id'],user,action,details)
