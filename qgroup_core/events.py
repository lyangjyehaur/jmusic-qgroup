"""Revisioned activity lifecycle, arrangements, drafts, and archives."""
import secrets
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .common import APIError, now, string, date_value
from . import audit, roster, conditions, permissions, bot_outbox
from .lifecycle import end_time, has_ended, phase

CATEGORIES = {'约K','聚餐','运动','出游','游戏','其他'}


def event_values(data,existing=None,draft=False):
    title=string(data,'title',60)
    category=string(data,'category',10)
    location=string(data,'location',120)
    description=string(data,'description',3000,False)
    start,deadline=date_value(data,'starts_at'),date_value(data,'deadline')
    cap,duration=data.get('capacity'),data.get('duration_hours',3)
    if category not in CATEGORIES or type(cap) is not int or not 0<=cap<=500:
        raise APIError('请选择活动类型与人数上限（不限，或 1–500 人）')
    if type(duration) is not int or not 1<=duration<=24:
        raise APIError('请选择持续时间（1–24 小时）')
    if not draft and start<=now() and (not existing or start!=existing['starts_at']):
        raise APIError('新的活动开始时间需要晚于现在')
    if deadline>start:
        raise APIError('报名截止时间不能晚于活动开始时间')
    return title,category,location,start,deadline,cap,description,duration


def public_snapshot(event):
    keys=('title','category','location','starts_at','deadline','capacity','description','duration_hours',
        'status','withdrawal_deadline','visibility','lifecycle','registration_open','actual_started_at',
        'actual_ended_at','archived_at','timezone','minimum_participants','formation_state','fee_policy',
        'conditions_version','cancellation_reason','bot_enabled')
    return {key:event[key] for key in keys}


def settings(data,existing=None):
    visibility=data.get('visibility',existing['visibility'] if existing else 'public')
    if visibility not in ('public','invitation'):
        raise APIError('请选择活动可见性')
    withdrawal=data.get('withdrawal_deadline',existing['withdrawal_deadline'] if existing else None)
    if withdrawal is not None:
        withdrawal=date_value({'time':withdrawal},'time')
        if withdrawal>date_value(data,'starts_at'):
            raise APIError('退出期限不能晚于活动开始时间')
    zone=data.get('timezone',existing['timezone'] if existing else 'Asia/Shanghai')
    if zone is not None:
        if not isinstance(zone,str) or len(zone)>100:
            raise APIError('请选择有效时区')
        try:ZoneInfo(zone)
        except (ZoneInfoNotFoundError,ValueError):raise APIError('请选择有效时区')
    minimum=data.get('minimum_participants',existing['minimum_participants'] if existing else 0)
    if type(minimum) is not int or not 0<=minimum<=500 or (data['capacity'] and minimum>data['capacity']):
        raise APIError('最低成团人数应为 0–500，且不能超过人数上限；0 表示不设置')
    fee=string(data,'fee_policy',1000,False) if 'fee_policy' in data else (existing['fee_policy'] if existing else '')
    return withdrawal,visibility,zone,minimum,fee


def bot_setting(data, visibility, existing=None):
    value = data.get('bot_enabled', bool(existing['bot_enabled']) if existing else False)
    if type(value) is not bool:
        raise APIError('请选择是否同步到 QQ 群')
    if visibility != 'public':
        if value and 'bot_enabled' in data:
            raise APIError('邀请可见活动不能同步到公开群，请先关闭群同步')
        return False
    return value


def create(db,user,data):
    lifecycle=data.get('lifecycle','scheduled')
    if lifecycle not in ('draft','scheduled'):
        raise APIError('新活动只能保存草稿或发布')
    values=event_values(data,draft=lifecycle=='draft')
    withdrawal,visibility,zone,minimum,fee=settings(data)
    bot_enabled=bot_setting(data,visibility)
    join_owner=data.get('join_owner',True)
    if type(join_owner) is not bool:
        raise APIError('请选择发起人是否参加')
    if lifecycle!='draft' and join_owner and values[4]<=now():
        raise APIError('报名截止已过，请调整截止时间')
    uid=secrets.token_hex(8)
    db.execute('''INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,
        description,duration_hours,created_at,withdrawal_deadline,visibility,invite_token,lifecycle,
        registration_open,status,timezone,minimum_participants,fee_policy,draft_join_owner)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (uid,user['id'])+values+(now(),withdrawal,visibility,secrets.token_urlsafe(24),lifecycle,
        int(lifecycle!='draft'),'closed' if lifecycle=='draft' else 'open',zone,minimum,fee,int(join_owner)))
    db.execute('UPDATE events SET bot_enabled=? WHERE id=?',(int(bot_enabled),uid))
    event=db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
    roster.grant(db,uid,user['id'])
    if lifecycle!='draft':conditions.publish(db,event,user)
    snapshot=public_snapshot(event)
    audit.append(db,event,user,'event_created',{},snapshot,queue_bot=False)
    if join_owner and lifecycle!='draft':
        roster.add_party(db,event,user,{'people':[{'is_self':True}]},require_preview=False,queue_bot=False)
    # Freeze the publication roster after automatic registration, in this same
    # transaction, while retaining event_created as the first audit record.
    audit.bot_hook(db,bot_outbox.on_append,event,user,'event_created',{},snapshot,'')
    return uid


def notify_managers(db,event,kind,message):
    targets={r[0] for r in db.execute("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status!='withdrawn'",(event['id'],))}
    targets.update(r[0] for r in db.execute('SELECT user_id FROM event_roles WHERE event_id=?',(event['id'],)))
    for uid in targets:
        audit.notify(db,uid,event['id'],kind,message)


def patch(db,event,user,data):
    owner=event['owner_id']==user['id']
    action=data.get('action')
    if action is None and 'title' not in data:
        action={'finished':'finish','cancelled':'cancel','open':'resume','closed':'pause','deleted':'remove'}.get(data.get('status'))
    assisted=not owner and action is None and 'title' in data and permissions.can_assist_schedule(db,event,user['id'])
    if assisted:audit.require_revision(event,data)
    settlement_retry=action=='bot_retry' and type(data.get('outbox_id')) is int and bool(db.execute("SELECT 1 FROM bot_outbox WHERE id=? AND event_id=? AND kind='settlement_updated'",(data.get('outbox_id'),event['id'])).fetchone())
    if settlement_retry:
        permissions.require(db,event,user['id'],'settlement')
    elif action in ('cancel','archive','unarchive','publish','formation','remove','bot_sync','bot_retry'):
        permissions.require(db,event,user['id'],'owner')
    elif not assisted:
        permissions.require(db,event,user['id'],'schedule')
    before,roster_before=public_snapshot(event),roster.snapshot(db,event['id'])
    reason=string(data,'reason',200,False)
    settled=bool(db.execute('SELECT 1 FROM settlements WHERE event_id=?',(event['id'],)).fetchone())
    terminal=event['lifecycle'] in ('ended','cancelled')
    if event['archived_at'] and action!='unarchive':
        raise APIError('请先取消归档再修改活动；结算更正仍可从结算入口操作',409)
    if 'title' in data:
        if terminal or settled:
            raise APIError('活动已实际结束或取消，不能重写安排',409)
        if assisted and not reason:
            raise APIError('管理员协助修改活动请填写原因')
        values=event_values(data,event,draft=event['lifecycle']=='draft')
        withdrawal,visibility,zone,minimum,fee=settings(data,event)
        bot_enabled=bot_setting(data,visibility,event)
        if not owner and bot_enabled!=bool(event['bot_enabled']):
            raise APIError('群同步设置需由发起者修改',403)
        prior_withdrawal=event['withdrawal_deadline'] or event['deadline']
        linked_withdrawal=assisted and prior_withdrawal==event['deadline'] and (withdrawal or values[4])==values[4]
        if not owner and (fee!=event['fee_policy'] or ((withdrawal or values[4])!=prior_withdrawal and not linked_withdrawal) or visibility!=event['visibility']):
            raise APIError('费用规则、退出期限及可见性需由发起者修改',403)
        count=db.execute("SELECT count(*) FROM attendees WHERE event_id=? AND status='confirmed'",(event['id'],)).fetchone()[0]
        if values[5] and values[5]<count:
            raise APIError('人数上限低于正式报名人数，请先明确处理超额人员',409)
        proposed=dict(event)
        proposed.update(dict(zip(('title','category','location','starts_at','deadline','capacity','description','duration_hours'),values)))
        proposed.update(withdrawal_deadline=withdrawal,timezone=zone,fee_policy=fee)
        important=conditions.snapshot(proposed)!=conditions.snapshot(event)
        active=db.execute("SELECT 1 FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative') LIMIT 1",(event['id'],)).fetchone()
        if important and active and not reason:
            raise APIError('重要安排变更请填写原因，参加者需要重新确认')
        join_owner=data.get('join_owner',bool(event['draft_join_owner']))
        if type(join_owner) is not bool:
            raise APIError('请选择本人是否参加')
        db.execute('''UPDATE events SET title=?,category=?,location=?,starts_at=?,deadline=?,capacity=?,
            description=?,duration_hours=?,withdrawal_deadline=?,visibility=?,timezone=?,minimum_participants=?,fee_policy=?,draft_join_owner=? WHERE id=?''',
            values+(withdrawal,visibility,zone,minimum,fee,int(join_owner),event['id']))
        db.execute('UPDATE events SET bot_enabled=? WHERE id=?',(int(bot_enabled),event['id']))
        updated=db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone()
        conditions.revise(db,event,updated,user,reason)
    elif action=='bot_retry':
        row_id=data.get('outbox_id')
        if type(row_id) is not int:
            raise APIError('请选择要重送的通知')
        new_id=bot_outbox.retry(db,event,row_id)
        audit.append(db,event,user,'bot_delivery_retry',{},dict(original_id=row_id,outbox_id=new_id),reason)
        return
    elif action=='bot_sync':
        db.execute('UPDATE events SET bot_enabled=? WHERE id=?',
            (int(bot_setting(data,event['visibility'],event)),event['id']))
    elif action=='publish':
        if event['lifecycle']!='draft':raise APIError('只有草稿可以发布',409)
        if event['starts_at']<=now():raise APIError('请先把草稿的活动时间调整到将来',409)
        if event['deadline']<=now():raise APIError('报名截止已过，请先调整截止时间',409)
        db.execute("UPDATE events SET lifecycle='scheduled',registration_open=1,status='open',draft_join_owner=1 WHERE id=?",(event['id'],))
        updated=db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone()
        conditions.publish(db,updated,user)
        roster.add_party(db,updated,user,{'people':[{'is_self':True}]},require_preview=False,queue_bot=False)
    elif action in ('pause','resume'):
        if terminal or settled or event['lifecycle']=='draft':raise APIError('这个活动不能切换报名状态',409)
        if action=='resume' and (event['deadline']<=now() or event['starts_at']<=now()):raise APIError('报名截止已过，请先调整安排或使用邀请补报名',409)
        db.execute('UPDATE events SET registration_open=?,status=? WHERE id=?',(int(action=='resume'),'open' if action=='resume' else 'closed',event['id']))
    elif action=='start':
        if terminal or event['lifecycle']=='draft':raise APIError('这个活动不能开始',409)
        if event['lifecycle']=='ongoing' and event['actual_started_at']:return
        db.execute("UPDATE events SET lifecycle='ongoing',actual_started_at=?,registration_open=0,status='closed' WHERE id=?",(now(),event['id']))
        notify_managers(db,event,'event_started',event['title']+' 已开始')
    elif action=='finish':
        if event['lifecycle']=='ended':return
        if event['lifecycle'] in ('draft','cancelled'):raise APIError('草稿或已取消活动不能标记为结束；取消活动可直接填写结算',409)
        db.execute("UPDATE events SET lifecycle='ended',actual_ended_at=?,registration_open=0,status='finished' WHERE id=?",(now(),event['id']))
        notify_managers(db,event,'event_finished',event['title']+' 已结束，请核对结算')
    elif action=='cancel':
        if event['lifecycle']=='draft':raise APIError('草稿尚未发布，请修改后发布',409)
        if not reason:raise APIError('请填写取消原因；原名单和帐务将保留')
        if event['lifecycle']=='cancelled' and event['cancellation_reason']==reason:return
        db.execute("UPDATE events SET lifecycle='cancelled',registration_open=0,status='cancelled',cancellation_reason=? WHERE id=?",(reason,event['id']))
        notify_managers(db,event,'event_cancelled',event['title']+' 已取消：'+reason+'；费用与退款以公布的结算为准')
    elif action in ('archive','unarchive'):
        if not terminal:raise APIError('只有实际结束或取消的活动可以归档',409)
        db.execute('UPDATE events SET archived_at=? WHERE id=?',(now() if action=='archive' else None,event['id']))
    elif action=='formation':
        if event['formation_state']=='confirmed':return
        if terminal or event['lifecycle']=='draft':raise APIError('这个活动不能确认成团',409)
        count=db.execute("SELECT count(*) FROM attendees WHERE event_id=? AND status='confirmed'",(event['id'],)).fetchone()[0]
        if count<event['minimum_participants'] and not reason:raise APIError('尚未达到最低人数，请填写仍决定成团的原因')
        db.execute("UPDATE events SET formation_state='confirmed' WHERE id=?",(event['id'],))
        notify_managers(db,event,'formation_confirmed',event['title']+' 已由发起者确认成团')
    elif action=='remove':
        raise APIError('请使用归档保留活动和帐务记录',409)
    else:
        raise APIError('操作格式不正确')
    updated=db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone()
    roster.rebalance(db,updated)
    roster_after=roster.snapshot(db,event['id'])
    changed=sorted(uid for uid in roster_before.keys()|roster_after.keys() if roster_before.get(uid)!=roster_after.get(uid))
    audit.append(db,event,user,'event_admin_updated' if assisted else 'event_'+(action or 'updated'),
        dict(event=before,participants=[roster_before[uid] for uid in changed if uid in roster_before]),
        dict(event=public_snapshot(updated),participants=[roster_after[uid] for uid in changed if uid in roster_after]),reason)
    if assisted and before!=public_snapshot(updated):
        audit.notify(db,event['owner_id'],event['id'],'admin_event_updated',user['nickname']+' 以管理员身份协助修改了「'+updated['title']+'」：'+reason+'；请查看活动记录核对')
