"""Expiring, revocable cohost and ownership handoff invitations."""
import json
import secrets
from datetime import datetime,timedelta,timezone
from .common import APIError,now,string
from . import audit,permissions,roster


def visible_roles(db,event):
    return [dict(id=r['id'],name=r['nickname'],permissions=json.loads(r['permissions_json'])) for r in db.execute(
        'SELECT r.*,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.created_at,r.id',(event['id'],))]


def pending(db,event,viewer):
    if event['owner_id']!=viewer:return []
    return [dict(id=r['id'],token=r['token'],kind=r['kind'],target_name=r['target_name'],permissions=json.loads(r['permissions_json']),expires_at=r['expires_at'])
        for r in db.execute("SELECT * FROM management_invitations WHERE event_id=? AND status='pending' AND expires_at>? ORDER BY created_at",(event['id'],now()))]


def lookup(db,event,token):
    row=db.execute("SELECT * FROM management_invitations WHERE event_id=? AND token=? AND status='pending' AND expires_at>? AND initiator_id=?",
        (event['id'],token,now(),event['owner_id'])).fetchone()
    if not row:raise APIError('交接邀请不存在、已过期、已接受或已撤销',404)
    return row


def invite(db,event,user,data):
    permissions.require(db,event,user['id'],'owner')
    if event['archived_at']:raise APIError('请先取消归档再邀请管理者',409)
    kind=data.get('kind')
    if kind not in ('cohost','transfer'):raise APIError('请选择邀请协办或转交发起者')
    target=string(data,'target_name',24)
    reason=string(data,'reason',200)
    scopes=data.get('permissions',[])
    if not isinstance(scopes,list) or any(not isinstance(p,str) or p not in permissions.SCOPES for p in scopes):
        raise APIError('协办权限不正确')
    scopes=sorted(set(scopes)) if kind=='cohost' else []
    if kind=='cohost' and not scopes:raise APIError('请至少选择一项协办权限')
    recipient=None
    if data.get('attendee_id'):
        row=db.execute("SELECT user_id FROM attendees WHERE event_id=? AND id=? AND user_id IS NOT NULL AND status!='withdrawn'",(event['id'],data['attendee_id'])).fetchone()
        if not row:raise APIError('对方尚未绑定本人报名，请使用专属交接链接')
        recipient=row[0]
        if recipient==user['id']:raise APIError('不能邀请自己接受交接')
    if kind=='transfer':
        db.execute("UPDATE management_invitations SET status='revoked' WHERE event_id=? AND kind='transfer' AND status='pending'",(event['id'],))
    uid,token=secrets.token_hex(8),secrets.token_urlsafe(24)
    expires=(datetime.now(timezone.utc)+timedelta(days=7)).isoformat(timespec='seconds')
    db.execute('''INSERT INTO management_invitations(id,event_id,token,kind,target_name,recipient_id,permissions_json,initiator_id,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)''',(uid,event['id'],token,kind,target,recipient,json.dumps(scopes),user['id'],now(),expires))
    audit.append(db,event,user,'management_invited',{},dict(invitation_id=uid,kind=kind,target_name=target,permissions=scopes,expires_at=expires),reason)


def accept(db,event,user,token,data):
    invite=lookup(db,event,token)
    if user['id']==event['owner_id']:raise APIError('发起者不能接受自己的交接邀请',409)
    if invite['recipient_id'] and invite['recipient_id']!=user['id']:raise APIError('这份交接邀请属于另一位报名者',403)
    if data.get('accept_responsibility') is not True:raise APIError('请明确勾选接受管理责任')
    before=dict(owner_name=db.execute('SELECT nickname FROM users WHERE id=?',(event['owner_id'],)).fetchone()[0],roles=visible_roles(db,event))
    if invite['kind']=='transfer':
        # Old-owner grants cannot be redeemed after ownership changes.
        db.execute('UPDATE events SET owner_id=? WHERE id=?',(user['id'],event['id']))
        db.execute('DELETE FROM event_roles WHERE event_id=? AND user_id=?',(event['id'],user['id']))
        db.execute("UPDATE management_invitations SET status='revoked' WHERE event_id=? AND status='pending'",(event['id'],))
        audit.notify(db,event['owner_id'],event['id'],'ownership_transferred',event['title']+' 已由 '+user['nickname']+' 接任发起者；你仍可管理自己的报名')
    else:
        accepted=set(json.loads(invite['permissions_json']))
        # Only one appointed settlement person. Preserve unrelated cohost duties.
        if 'settlement' in accepted:
            for role in db.execute('SELECT * FROM event_roles WHERE event_id=?',(event['id'],)).fetchall():
                prior=set(json.loads(role['permissions_json']))
                if role['user_id']!=user['id'] and 'settlement' in prior:
                    prior.remove('settlement')
                    if prior:db.execute('UPDATE event_roles SET permissions_json=? WHERE id=?',(json.dumps(sorted(prior)),role['id']))
                    else:db.execute('DELETE FROM event_roles WHERE id=?',(role['id'],))
                    audit.notify(db,role['user_id'],event['id'],'cohost_removed',event['title']+' 已另行指定结算人，你的结算权限已撤销')
            prior=db.execute('SELECT permissions_json FROM event_roles WHERE event_id=? AND user_id=?',(event['id'],user['id'])).fetchone()
            if prior:accepted.update(json.loads(prior[0]))
        db.execute('''INSERT INTO event_roles(id,event_id,user_id,permissions_json,created_at) VALUES(?,?,?,?,?)
            ON CONFLICT(event_id,user_id) DO UPDATE SET permissions_json=excluded.permissions_json''',
            (secrets.token_hex(8),event['id'],user['id'],json.dumps(sorted(accepted)),now()))
        audit.notify(db,event['owner_id'],event['id'],'cohost_accepted',user['nickname']+' 已接受 '+event['title']+' 的协办邀请')
    db.execute("UPDATE management_invitations SET status='accepted',accepted_by=?,accepted_at=? WHERE id=?",(user['id'],now(),invite['id']))
    roster.grant(db,event['id'],user['id'])
    updated=db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone()
    after=dict(owner_name=db.execute('SELECT nickname FROM users WHERE id=?',(updated['owner_id'],)).fetchone()[0],roles=visible_roles(db,updated))
    audit.append(db,event,user,'ownership_transferred' if invite['kind']=='transfer' else 'cohost_joined',before,after,'本人接受管理邀请')


def revoke_invitation(db,event,user,uid,data):
    permissions.require(db,event,user['id'],'owner')
    reason=string(data,'reason',200)
    row=db.execute("SELECT * FROM management_invitations WHERE event_id=? AND id=? AND status='pending'",(event['id'],uid)).fetchone()
    if not row:raise APIError('没有这份待接受邀请',404)
    db.execute("UPDATE management_invitations SET status='revoked' WHERE id=?",(uid,))
    audit.append(db,event,user,'management_invitation_revoked',dict(invitation_id=uid,target_name=row['target_name'],kind=row['kind']),{},reason)


def revoke_role(db,event,user,uid,data):
    permissions.require(db,event,user['id'],'owner')
    reason=string(data,'reason',200)
    row=db.execute('SELECT r.*,u.nickname FROM event_roles r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.id=?',(event['id'],uid)).fetchone()
    if not row:raise APIError('没有这位协办',404)
    before=visible_roles(db,event)
    db.execute('DELETE FROM event_roles WHERE id=?',(uid,))
    audit.append(db,event,user,'cohost_removed',dict(roles=before),dict(roles=visible_roles(db,event)),reason)
    audit.notify(db,row['user_id'],event['id'],'cohost_removed',event['title']+' 的协办权限已撤销：'+reason)
