"""Explicit browser access grants and approved attendee identity claims; never merge ledgers."""
import hashlib
import secrets
from datetime import datetime,timedelta,timezone
from .common import APIError,now,string
from . import roster,audit,permissions


def scope(user_id):return hashlib.sha256(('kanban-drafts-v1:'+user_id).encode()).hexdigest()
def expires(minutes):return (datetime.now(timezone.utc)+timedelta(minutes=minutes)).isoformat(timespec='seconds')
def session_hash(headers):
    from http import cookies
    jar=cookies.SimpleCookie()
    try:jar.load(headers.get('Cookie',''))
    except cookies.CookieError:return ''
    return hashlib.sha256(jar['kanban_session'].value.encode()).hexdigest() if 'kanban_session' in jar else ''


def accounts(db,user,session):
    allowed={user['id']}
    allowed.update(r[0] for r in db.execute('SELECT user_id FROM browser_accounts WHERE token_hash=?',(session,)))
    return [dict(scope=scope(uid),nickname=db.execute('SELECT nickname FROM users WHERE id=?',(uid,)).fetchone()[0],current=uid==user['id']) for uid in sorted(allowed)]


def devices(db,user,session):
    return [dict(id=hashlib.sha256((user['id']+r[0]).encode()).hexdigest(),current=r[0]==session,created_at=r[1])
        for r in db.execute('SELECT token_hash,MIN(created_at) FROM (SELECT token_hash,created_at FROM browser_sessions WHERE user_id=? UNION SELECT b.token_hash,b.created_at FROM browser_accounts b JOIN browser_sessions s ON s.token_hash=b.token_hash WHERE b.user_id=?) GROUP BY token_hash',(user['id'],user['id']))]


def link_view(db,token):
    row=db.execute("SELECT l.*,u.nickname FROM device_links l JOIN users u ON u.id=l.user_id WHERE l.token=? AND l.expires_at>? AND l.status='pending'",(token,now())).fetchone()
    if not row:raise APIError('连接已过期、使用或撤销',404)
    return row


def account_command(db,user,session,path,data):
    if path=='/api/account/link':
        if data.get('authorize_device') is not True:raise APIError('请确认只授权自己的另一台设备')
        token=secrets.token_urlsafe(24);uid=secrets.token_hex(8)
        db.execute("UPDATE device_links SET status='revoked' WHERE user_id=? AND status='pending'",(user['id'],))
        db.execute('INSERT INTO device_links VALUES(?,?,?,?,?,?,?)',(uid,token,user['id'],'pending',expires(10),now(),None))
        account_log(db,user,'device_link_issued',dict(link_id=uid))
        return dict(ok=True,link_token=token,expires_at=expires(10))
    if path=='/api/account/accept':
        row=link_view(db,string(data,'token',100))
        if data.get('accept_access') is not True:raise APIError('请明确确认授权内容与账号分开保留')
        # Grant access to this device only. Keep its existing account and all of its data intact.
        db.execute('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)',(session,user['id'],now()))
        db.execute('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)',(session,row['user_id'],now()))
        db.execute("UPDATE device_links SET status='used',used_by=? WHERE id=?",(session,row['id']))
        account_log(db,{'id':row['user_id']},'device_link_accepted',dict(link_id=row['id'],device=hashlib.sha256((row['user_id']+session).encode()).hexdigest()))
        return dict(ok=True,accounts=accounts(db,user,session))
    if path=='/api/account/switch':
        selected=next((a for a in accounts(db,user,session) if a['scope']==data.get('scope')),None)
        if not selected:raise APIError('此设备没有该账号的授权',403)
        candidates=[user['id']]+[r[0] for r in db.execute('SELECT user_id FROM browser_accounts WHERE token_hash=?',(session,))]
        target=next(uid for uid in candidates if scope(uid)==selected['scope'])
        db.execute('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)',(session,user['id'],now()))
        db.execute('UPDATE browser_sessions SET user_id=? WHERE token_hash=?',(target,session))
        account_log(db,user,'account_switched',dict(target_scope=selected['scope']))
        return dict(ok=True,switched=True)
    if path=='/api/account/revoke':
        target=next((r for r in devices(db,user,session) if r['id']==data.get('device_id')),None)
        if not target:raise APIError('设备授权不存在',404)
        if target['current']:raise APIError('不能在这里撤销当前设备')
        hashes=[r[0] for r in db.execute('SELECT token_hash FROM browser_sessions')]
        token_hash=next(h for h in hashes if hashlib.sha256((user['id']+h).encode()).hexdigest()==target['id'])
        db.execute('DELETE FROM browser_accounts WHERE token_hash=? AND user_id=?',(token_hash,user['id']))
        current=db.execute('SELECT user_id FROM browser_sessions WHERE token_hash=?',(token_hash,)).fetchone()
        if current and current[0]==user['id']:
            alternate=db.execute('SELECT user_id FROM browser_accounts WHERE token_hash=?',(token_hash,)).fetchone()
            if alternate:db.execute('UPDATE browser_sessions SET user_id=? WHERE token_hash=?',(alternate[0],token_hash))
            else:db.execute('DELETE FROM browser_sessions WHERE token_hash=?',(token_hash,))
        db.execute("UPDATE device_links SET status='revoked' WHERE user_id=? AND status='pending'",(user['id'],))
        account_log(db,user,'device_revoked',dict(device=target['id']))
        return dict(ok=True)
    raise APIError('账号操作不存在',404)


def account_log(db,user,action,details):
    import json
    db.execute('INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,?,?,?)',(user['id'],action,json.dumps(details),now()))


def may_issue(db,event,person,viewer):
    return person['manager_id']==viewer or permissions.has(db,event,viewer,'roster')


def eligible(event,person):
    if person['user_id'] or person['status'] not in ('confirmed','waiting','tentative'):raise APIError('只能认领尚未绑定账号的有效代报名',409)
    if event['archived_at']:raise APIError('请先取消归档再核对认领',409)
    if person['queue_mode']=='together' and person['status']!='confirmed':raise APIError('整组候补／待确认须先由管理人协调排队，正式后再认领',409)


def claims_visible(db,event,viewer):
    result=[]
    for r in db.execute('SELECT c.*,u.nickname AS requester_name FROM attendee_claims c LEFT JOIN users u ON u.id=c.requester_id WHERE c.event_id=? ORDER BY c.created_at DESC',(event['id'],)):
        p=next((p for p in roster.rows(db,event['id']) if p['id']==r['attendee_id']),None)
        manager=p and may_issue(db,event,p,viewer)
        if not manager and viewer!=r['requester_id']:continue
        result.append(dict(id=r['id'],attendee_id=r['attendee_id'],name=p['nickname'] if p else '',status='expired' if r['status'] in ('invited','requested') and r['expires_at']<=now() else r['status'],requester_name=r['requester_name'],token=r['token'] if manager and r['status']=='invited' and r['expires_at']>now() else None,can_decide=bool(manager and r['status']=='requested' and r['expires_at']>now()),expires_at=r['expires_at']))
    return result


def claim_lookup(db,event,token):
    row=db.execute("SELECT * FROM attendee_claims WHERE event_id=? AND token=? AND status IN ('invited','requested') AND expires_at>?",(event['id'],token,now())).fetchone()
    if not row:raise APIError('认领链接不存在、已使用、撤销或过期',404)
    p=roster.lookup(db,event,row['attendee_id']);eligible(event,p)
    if not may_issue(db,event,p,row['issuer_id']):raise APIError('原邀请人已失去管理权限，请重新邀请',409)
    return row,p


def claim_view(db,event,user,token):
    completed=db.execute("SELECT attendee_id FROM attendee_claims WHERE event_id=? AND token=? AND status='approved' AND requester_id=?",(event['id'],token,user['id'] if user else '')).fetchone()
    if completed:
        p=roster.lookup(db,event,completed['attendee_id'])
        return dict(claimed=True,event_id=event['id'],title=event['title'],name=p['nickname'])
    row,p=claim_lookup(db,event,token)
    duplicate=db.execute("SELECT id,status FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",(event['id'],user['id'] if user else '')).fetchone()
    return dict(title=event['title'],name=p['nickname'],status=p['status'],payer_name=p['manager_name'] if p['payer_kind']=='manager' else p['nickname'],payer_kind=p['payer_kind'],base_revision=event['revision'],expires_at=row['expires_at'],claim_status=row['status'],requested_by_me=bool(user and row['requester_id']==user['id']),duplicate=bool(duplicate),event_id=event['id'])


def claim_command(db,event,user,suffix,data):
    import re
    if suffix=='/claims':
        p=roster.lookup(db,event,string(data,'attendee_id',32));eligible(event,p)
        if not may_issue(db,event,p,user['id']):raise APIError('只有原管理人或报名协办可以发出认领邀请',403)
        reason=string(data,'reason',200)
        superseded=[r[0] for r in db.execute("SELECT id FROM attendee_claims WHERE attendee_id=? AND status IN ('invited','requested')",(p['id'],))]
        db.execute("UPDATE attendee_claims SET status='revoked' WHERE attendee_id=? AND status IN ('invited','requested')",(p['id'],))
        uid=secrets.token_hex(8);token=secrets.token_urlsafe(24)
        db.execute('INSERT INTO attendee_claims VALUES(?,?,?,?,?,?,?,?,?,?)',(uid,event['id'],p['id'],token,user['id'],None,'invited',expires(7*1440),now(),None))
        audit.append(db,event,user,'claim_invited',{},dict(claim_id=uid,attendee_id=p['id'],name=p['nickname'],superseded=superseded),reason)
        return
    requested=re.fullmatch(r'/claims/([A-Za-z0-9_-]{32})/request',suffix)
    if requested:
        row,p=claim_lookup(db,event,requested[1])
        if row['status']!='invited':raise APIError('已有认领申请，请等待管理人核对',409)
        if data.get('confirm_identity') is not True or data.get('keep_payment') is not True:raise APIError('请确认本人身份以及保留原付款责任')
        if not user['nickname']:raise APIError('请先设置自己的称呼')
        if user['id']==p['manager_id']:raise APIError('请由被代报者自己的浏览器申请认领',409)
        if db.execute("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",(event['id'],user['id'])).fetchone():raise APIError('你已有本人报名：请先核对并取消重复项；截止后或已有费用请由管理人协调，不能自动合并名额或款项',409)
        db.execute("UPDATE attendee_claims SET status='requested',requester_id=? WHERE id=?",(user['id'],row['id']))
        audit.append(db,event,user,'claim_requested',{},dict(claim_id=row['id'],name=p['nickname'],requester_name=user['nickname']))
        audit.notify(db,p['manager_id'],event['id'],'claim_requested',p['nickname']+' 的报名认领申请待核对')
        if p['manager_id']!=event['owner_id']:audit.notify(db,event['owner_id'],event['id'],'claim_requested',p['nickname']+' 的报名认领申请待核对')
        return
    decided=re.fullmatch(r'/claims/([a-f0-9]{16})',suffix)
    if not decided:raise APIError('认领操作不存在',404)
    row=db.execute('SELECT * FROM attendee_claims WHERE id=? AND event_id=?',(decided[1],event['id'])).fetchone()
    if not row:raise APIError('认领申请不存在',404)
    p=roster.lookup(db,event,row['attendee_id'])
    if not may_issue(db,event,p,user['id']):raise APIError('只有管理人可以核对认领',403)
    if row['status'] not in ('requested','invited') or row['expires_at']<=now():raise APIError('认领邀请已失效',409)
    decision=data.get('decision');reason=string(data,'reason',200)
    if decision not in ('approve','reject','revoke'):raise APIError('请选择认领处理结果')
    if decision=='approve':
        if row['status']!='requested':raise APIError('对方尚未申请认领',409)
        eligible(event,p)
        if data.get('confirm_person') is not True:raise APIError('请确认核对了申请人就是这位参加者')
        target=row['requester_id']
        if db.execute("SELECT 1 FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",(event['id'],target)).fetchone():raise APIError('申请人新增了本人报名，请先处理重复项后重新核对',409)
        # Freeze pre-claim payment IDs. No invoice, receipt, cash row or consent is rewritten.
        origin=('account:'+hashlib.sha256((event['id']+':'+p['manager_id']).encode()).hexdigest()[:16]) if p['payer_kind']=='manager' else 'person:'+p['id']
        db.execute('INSERT INTO attendee_payment_origins VALUES(?,?,?,?,?)',(p['id'],origin,p['manager_name'] if p['payer_kind']=='manager' else p['nickname'],int(p['payer_kind']=='self'),p['manager_id'] if p['payer_kind']=='manager' else None))
        before=roster.snapshot(db,event['id'])
        db.execute('UPDATE attendees SET user_id=?,manager_id=?,updated_at=? WHERE id=?',(target,target,now(),p['id']))
        roster.grant(db,event['id'],target)
        roster.record(db,event,user,'claim_approved',before,reason,dict(claim_id=row['id'],attendee_id=p['id'],payer_id=origin))
    else:audit.append(db,event,user,'claim_'+decision,dict(claim_id=row['id'],status=row['status']),dict(status=decision),reason)
    db.execute('UPDATE attendee_claims SET status=?,decided_at=? WHERE id=?',('approved' if decision=='approve' else 'rejected' if decision=='reject' else 'revoked',now(),row['id']))
    if row['requester_id']:audit.notify(db,row['requester_id'],event['id'],'claim_decided','报名认领已'+('通过，原名额及款项保留' if decision=='approve' else '结束，请联系管理人'))
