"""Per-person registration, FIFO parties, delegated management, and withdrawals."""
import hashlib
import json
import secrets

from .common import APIError, now, string
from . import audit, conditions, permissions
from .lifecycle import is_open


def can_access(db, event, viewer):
    if event['lifecycle']=='draft':
        return bool(permissions.scopes(db,event,viewer))
    if event['visibility'] == 'public' or event['owner_id'] == viewer:
        return True
    if not viewer:
        return False
    return bool(db.execute('SELECT 1 FROM event_access WHERE event_id=? AND user_id=?',
        (event['id'],viewer)).fetchone())


def grant(db, event_id, user_id):
    db.execute('INSERT OR IGNORE INTO event_access VALUES(?,?,?)', (event_id,user_id,now()))


def rows(db, event_id):
    return db.execute('''SELECT a.*,COALESCE(u.nickname,a.name) AS nickname,m.nickname AS manager_name,
        p.queue_mode,p.seq AS party_order FROM attendees a
        JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id
        LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? ORDER BY p.seq,a.seq''',
        (event_id,)).fetchall()


def public_person(row):
    return {key: row[key] for key in ('id','nickname','note','status','payer_kind','manager_name',
        'withdrawal_requested','withdrawal_reason','created_at','updated_at','party_id','queue_mode',
        'accepted_conditions_version','confirmation_state','attendance','attendance_note','arrived_at','left_at')}


def snapshot(db, event_id):
    return {row['id']:public_person(row) for row in rows(db,event_id)}


def record(db, event, user, action, before, reason='', details=None):
    after = snapshot(db,event['id'])
    changed = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
    prior = {'participants':[before[key] for key in changed if key in before]}
    current = {'participants':[after[key] for key in changed if key in after]}
    if details:
        current.update(details)
    audit.append(db,event,user,action,prior,current,reason)


def allocate(existing, capacity, candidates=(), queue_mode='individual'):
    """Keep confirmed places; promote waiting parties in strict FIFO order."""
    remaining = 1000000 if capacity == 0 else max(0,capacity-sum(r['status']=='confirmed' for r in existing))
    groups = []
    for row in existing:
        if row['status'] != 'waiting':
            continue
        if groups and groups[-1][0] == row['party_id']:
            groups[-1][2].append(row['id'])
        else:
            groups.append([row['party_id'],row['queue_mode'],[row['id']]])
    if candidates:
        groups.append(['new',queue_mode,list(candidates)])
    result, blocked = {}, False
    for _, mode, ids in groups:
        if mode == 'together' and len(ids) > remaining:
            blocked = True
        for uid in ids:
            result[uid] = 'waiting' if blocked or remaining <= 0 else 'confirmed'
            if result[uid] == 'confirmed':
                remaining -= 1
    return result


def rebalance(db, event):
    if not is_open(event):
        return
    people = rows(db,event['id'])
    assignments = allocate(people,event['capacity'])
    for person in people:
        if person['status'] == 'waiting' and assignments.get(person['id']) == 'confirmed':
            db.execute("UPDATE attendees SET status='confirmed',updated_at=? WHERE id=?", (now(),person['id']))
            audit.notify(db,person['manager_id'],event['id'],'promoted',person['nickname']+' 已递补为正式报名')


def ensure_mutable(db, event):
    if db.execute('SELECT 1 FROM settlements WHERE event_id=?', (event['id'],)).fetchone():
        raise APIError('活动已有结算，暂不能改动报名名单',409)
    if event['lifecycle'] in ('draft','ended','cancelled') or event['status']=='deleted' or event['archived_at']:
        raise APIError('这个活动已结束或取消',409)


def normalized_people(db, event, user, data):
    people = data.get('people')
    if not isinstance(people,list) or not 1 <= len(people) <= 20:
        raise APIError('每次请填写 1–20 位参加者')
    result, has_self = [], False
    for person in people:
        if not isinstance(person,dict) or type(person.get('is_self',False)) is not bool:
            raise APIError('参加者格式不正确')
        own = person.get('is_self',False)
        if own:
            if has_self:
                raise APIError('本人只能报名一次')
            has_self = True
            if db.execute("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",
                (event['id'],user['id'])).fetchone():
                raise APIError('你已报名或待确认，请直接管理现有报名',409)
        payer = person.get('payer_kind','self' if own else 'manager')
        if payer not in ('self','manager') or (own and payer != 'self'):
            raise APIError('请选择正确的付款归属')
        result.append(dict(is_self=own,name=user['nickname'] if own else string(person,'name',24),
            note=string(person,'note',100,False),payer_kind=payer))
    return result


def prepare(db, event, user, data):
    if not is_open(event):
        raise APIError('这个活动已停止报名',409)
    people = normalized_people(db,event,user,data)
    mode, intent = data.get('queue_mode','individual'), data.get('intent','registered')
    if mode not in ('individual','together') or intent not in ('registered','tentative'):
        raise APIError('请选择排队方式和参加意愿')
    ids = [str(index) for index in range(len(people))]
    assignment = allocate(rows(db,event['id']),event['capacity'],ids,mode)
    statuses = ['tentative' if intent=='tentative' else assignment[uid] for uid in ids]
    token = hashlib.sha256(json.dumps([event['id'],event['revision'],people,mode,intent,statuses],
        sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return people, mode, intent, statuses, token


def preview(db, event, user, data):
    if 'base_revision' in data or event['fee_policy'] or event['conditions_version']>1:
        audit.require_revision(event,data)
    people, mode, intent, statuses, token = prepare(db,event,user,data)
    return dict(base_revision=event['revision'],preview_token=token,
        conditions_version=event['conditions_version'],
        allocation=[dict(name=p['name'],status=status) for p,status in zip(people,statuses)])


def add_party(db, event, user, data, require_preview=True):
    ensure_mutable(db,event)
    people, mode, intent, statuses, token = prepare(db,event,user,data)
    if require_preview and data.get('preview_token') != token:
        raise APIError('报名预览已有变化，请重新预览并确认',409)
    if 'confirmed' in statuses and 'waiting' in statuses and data.get('accept_partial') is not True:
        raise APIError('部分人需要候补，请明确选择接受部分候补或一起参加',409)
    before = snapshot(db,event['id'])
    party = secrets.token_hex(8)
    db.execute('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)',
        (party,event['id'],user['id'],mode,now()))
    for person,status in zip(people,statuses):
        person_id=secrets.token_hex(8)
        db.execute('''INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,
            status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
            (person_id,event['id'],user['id'],user['id'] if person['is_self'] else None,
             party,person['name'],person['note'],person['payer_kind'],status,now(),now()))
        conditions.accept_new(db,event,person_id,user)
    grant(db,event['id'],user['id'])
    rebalance(db,event)
    record(db,event,user,'signup',before)


def lookup(db, event, uid):
    row = next((row for row in rows(db,event['id']) if row['id']==uid),None)
    if not row or row['status']=='withdrawn':
        raise APIError('这条报名不存在或已退出',404)
    return row


def can_manage(db, event, person, user):
    if not permissions.has(db,event,user['id'],'roster') and person['manager_id'] != user['id']:
        raise APIError('只能管理本人或由你代报的人员',403)


def change_person(db, event, user, uid, data):
    ensure_mutable(db,event)
    person = lookup(db,event,uid)
    can_manage(db,event,person,user)
    if not is_open(event):
        raise APIError('报名已截止；如需退出，请提交退出申请',409)
    before = snapshot(db,event['id'])
    action = data.get('action','edit')
    if action == 'confirm':
        if person['status'] != 'tentative':
            raise APIError('只有待确认人员可以确认参加',409)
        party = secrets.token_hex(8)
        db.execute('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)',
            (party,event['id'],person['manager_id'],person['queue_mode'] or 'individual',now()))
        if person['queue_mode']=='together':
            db.execute("UPDATE attendees SET status='waiting',party_id=?,updated_at=? WHERE party_id=? AND status='tentative'",
                (party,now(),person['party_id']))
        else:
            db.execute("UPDATE attendees SET status='waiting',party_id=?,updated_at=? WHERE id=?", (party,now(),uid))
        rebalance(db,event)
    elif action == 'split':
        if person['status']!='waiting' or person['queue_mode']!='together':
            raise APIError('只有整组候补可以改为分开排队',409)
        # Splitting does not inherit an earlier person's place: this party keeps its own queue ticket.
        db.execute("UPDATE roster_parties SET queue_mode='individual' WHERE id=?", (person['party_id'],))
        rebalance(db,event)
    elif action == 'edit':
        name = person['name'] if person['user_id'] else string(data,'name',24)
        note = string(data,'note',100,False)
        payer = data.get('payer_kind',person['payer_kind'])
        if payer not in ('self','manager') or (person['user_id'] and payer!='self' and not db.execute('SELECT 1 FROM attendee_payment_origins WHERE attendee_id=?',(person['id'],)).fetchone()):
            raise APIError('请选择正确的付款归属')
        if db.execute('SELECT 1 FROM attendee_payment_origins WHERE attendee_id=?',(person['id'],)).fetchone() and payer!=person['payer_kind']:raise APIError('认领保留原付款责任；更改请在结算中核对并留版本',409)
        if (name,note,payer)!=(person['name'],person['note'],person['payer_kind']):
            db.execute('UPDATE attendees SET name=?,note=?,payer_kind=?,updated_at=? WHERE id=?',
                (name,note,payer,now(),uid))
    else:
        raise APIError('报名操作不正确')
    reason = string(data,'reason',200,False)
    if person['manager_id']!=user['id'] and not reason:
        raise APIError('管理其他人的报名时请填写原因')
    record(db,event,user,'attendee_'+action,before,reason)


def withdraw(db, event, user, uid, data, decision=None):
    ensure_mutable(db,event)
    person = lookup(db,event,uid)
    can_manage(db,event,person,user)
    before = snapshot(db,event['id'])
    reason = string(data,'reason',200,False)
    owner = permissions.has(db,event,user['id'],'roster')
    if decision is not None:
        if not owner or not person['withdrawal_requested']:
            raise APIError('只有发起者可以处理待审核的退出申请',403)
        if decision not in ('approve','reject') or not reason:
            raise APIError('请选择处理结果并填写原因')
        if decision=='reject':
            db.execute('UPDATE attendees SET withdrawal_requested=0,withdrawal_reason=?,updated_at=? WHERE id=?',
                (reason,now(),uid))
        else:
            db.execute("UPDATE attendees SET status='withdrawn',withdrawal_requested=0,updated_at=? WHERE id=?", (now(),uid))
            rebalance(db,event)
        audit.notify(db,person['manager_id'],event['id'],'withdrawal_decision',
            person['nickname']+' 的退出申请已'+('同意' if decision=='approve' else '拒绝')+'：'+reason)
        record(db,event,user,'withdrawal_'+decision,before,reason)
        return
    if owner and person['manager_id']!=user['id']:
        if not reason:
            raise APIError('撤销他人报名时请填写原因')
        audit.notify(db,person['manager_id'],event['id'],'removed',person['nickname']+' 的报名已由发起者撤销：'+reason)
    elif person['status']=='confirmed' and (event['withdrawal_deadline'] or event['deadline']) <= now():
        if not reason:
            raise APIError('已过退出期限，请填写退出原因，交由发起者处理')
        if person['withdrawal_requested']:
            raise APIError('退出申请已提交，请等待发起者处理',409)
        db.execute('UPDATE attendees SET withdrawal_requested=1,withdrawal_reason=?,updated_at=? WHERE id=?', (reason,now(),uid))
        audit.notify(db,event['owner_id'],event['id'],'withdrawal_request',person['nickname']+' 申请退出：'+reason)
        record(db,event,user,'withdrawal_request',before,reason)
        return
    db.execute("UPDATE attendees SET status='withdrawn',withdrawal_requested=0,invitation_token=NULL,updated_at=? WHERE id=?", (now(),uid))
    rebalance(db,event)
    record(db,event,user,'withdraw',before,reason)


def invite(db, event, user, data):
    ensure_mutable(db,event)
    if not permissions.has(db,event,user['id'],'roster'):
        raise APIError('只有发起者可以邀请补报名',403)
    reason = string(data,'reason',200)
    people = normalized_people(db,event,user,data)
    if any(p['is_self'] for p in people):
        raise APIError('请填写受邀者称呼，发送链接由对方接受')
    before = snapshot(db,event['id'])
    for person in people:
        db.execute('''INSERT INTO attendees(id,event_id,manager_id,name,note,payer_kind,status,
            invitation_token,created_at,updated_at) VALUES(?,?,?,?,?,?,'invited',?,?,?)''',
            (secrets.token_hex(8),event['id'],user['id'],person['name'],person['note'],'self',
             secrets.token_urlsafe(24),now(),now()))
    record(db,event,user,'invite',before,reason)


def invitation(db, event, token):
    row = db.execute("SELECT * FROM attendees WHERE event_id=? AND invitation_token=? AND status='invited'",
        (event['id'],token)).fetchone()
    if not row:
        raise APIError('邀请不存在、已使用或已撤销',404)
    return row


def accept_invitation(db, event, user, token, data):
    ensure_mutable(db,event)
    person = invitation(db,event,token)
    if db.execute("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",
        (event['id'],user['id'])).fetchone():
        raise APIError('你已有报名，请让发起者核对，不能重复接受为本人报名',409)
    people = rows(db,event['id'])
    if is_open(event):
        status = allocate(people,event['capacity'],['new'])['new']
    else:
        count = sum(p['status']=='confirmed' for p in people)
        status = 'confirmed' if not event['capacity'] or count < event['capacity'] else 'waiting'
    if status=='waiting' and data.get('accept_waiting') is not True:
        raise APIError('名额已有变化，目前需候补；请确认接受候补后重试',409)
    before = snapshot(db,event['id'])
    party = secrets.token_hex(8)
    db.execute('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)',
        (party,event['id'],user['id'],'individual',now()))
    db.execute('''UPDATE attendees SET manager_id=?,user_id=?,name=?,party_id=?,status=?,
        invitation_token=NULL,updated_at=? WHERE id=?''',
        (user['id'],user['id'],user['nickname'],party,status,now(),person['id']))
    grant(db,event['id'],user['id'])
    conditions.accept_new(db,event,person['id'],user)
    record(db,event,user,'invitation_accepted',before)


def serialize(db, event, viewer):
    people = rows(db,event['id'])
    settled = bool(db.execute('SELECT 1 FROM settlements WHERE event_id=?',(event['id'],)).fetchone())
    result, invited, managed = [], [], []
    position, waiting_position = 0, 0
    for person in people:
        if person['status']=='withdrawn':
            continue
        item = public_person(person)
        item['is_me'] = person['user_id']==viewer
        item['managed_by_me'] = person['manager_id']==viewer
        item['can_manage'] = permissions.has(db,event,viewer,'roster') or item['managed_by_me']
        item['is_guest'] = person['user_id'] is None
        origin=db.execute('SELECT * FROM attendee_payment_origins WHERE attendee_id=?',(person['id'],)).fetchone()
        item['payment_locked']=bool(origin)
        item['can_claim']=person['status'] in ('confirmed','waiting','tentative') and not person['user_id'] and item['can_manage'] and not event['archived_at'] and (person['queue_mode']!='together' or person['status']=='confirmed')
        item['payer_name'] = origin['payer_name'] if origin else person['nickname'] if person['payer_kind']=='self' else person['manager_name']
        item['can_change'] = item['can_manage'] and is_open(event) and not settled
        item['can_withdraw'] = item['can_manage'] and event['lifecycle'] in ('scheduled','ongoing') and not event['archived_at'] and not settled
        item['can_respond'] = item['managed_by_me'] and event['lifecycle'] in ('scheduled','ongoing') and not event['archived_at']
        item['needs_withdrawal_request'] = person['status']=='confirmed' and (event['withdrawal_deadline'] or event['deadline']) <= now()
        if person['status']=='invited':
            if item['can_manage']:
                item['invitation_token'] = person['invitation_token']
                invited.append(item)
            continue
        position += 1
        item['position'] = position
        if person['status']=='waiting':
            waiting_position += 1
        item['waiting_position'] = waiting_position if person['status']=='waiting' else None
        result.append(item)
        if item['managed_by_me']:
            managed.append(item)
    # Public lists put confirmed first without altering FIFO queue tickets.
    result.sort(key=lambda p: {'confirmed':0,'waiting':1,'tentative':2}[p['status']])
    return dict(participants=result,my_attendees=managed,pending_invitations=invited,
        confirmed_count=sum(p['status']=='confirmed' for p in result),
        waiting_count=sum(p['status']=='waiting' for p in result),
        tentative_count=sum(p['status']=='tentative' for p in result),
        my_registration=next((p for p in result if p['is_me']),None))
