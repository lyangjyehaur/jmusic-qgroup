"""Attendance observations and explicit on-site additions, separate from billing."""
import secrets
from .common import APIError,now,string,date_value
from . import audit,roster,conditions,permissions
from .lifecycle import phase

STATES={'unknown','present','absent','late','left'}


def serialize(db,event):
    return [dict(roster.public_person(r),is_guest=r['user_id'] is None,payer_name=r['nickname'] if r['payer_kind']=='self' else r['manager_name'])
        for r in roster.rows(db,event['id']) if r['status']=='confirmed' or r['attendance']!='unknown']


def change(db,event,user,uid,data):
    permissions.require(db,event,user['id'],'attendance')
    if phase(event) not in ('ongoing','ended','cancelled') or event['archived_at']:
        raise APIError('活动开始后才能核对出席；归档后请先取消归档',409)
    person=next((r for r in roster.rows(db,event['id']) if r['id']==uid),None)
    if not person or (person['status']!='confirmed' and person['attendance']=='unknown'):
        raise APIError('请先确认正式名额，临时加入请使用现场补录',409)
    state=data.get('attendance')
    if state not in STATES:raise APIError('请选择有效出席状态')
    note=string(data,'attendance_note',200,False)
    reason=string(data,'reason',200,phase(event) in ('ended','cancelled'))
    arrived=date_value(data,'arrived_at') if data.get('arrived_at') else None
    left=date_value(data,'left_at') if data.get('left_at') else None
    if (arrived and arrived>now()) or (left and left>now()) or (arrived and left and left<arrived):
        raise APIError('实际到离场时间不能在将来，离场不能早于到场')
    if state in ('unknown','absent') and (arrived or left):raise APIError('未核对或缺席状态不能填写到离场时间')
    before=roster.snapshot(db,event['id'])
    if (state,note,arrived,left)!=(person['attendance'],person['attendance_note'],person['arrived_at'],person['left_at']):
        db.execute('UPDATE attendees SET attendance=?,attendance_note=?,arrived_at=?,left_at=?,updated_at=? WHERE id=?',
            (state,note,arrived,left,now(),uid))
    roster.record(db,event,user,'attendance_updated',before,reason)


def onsite(db,event,user,data):
    permissions.require(db,event,user['id'],'roster')
    permissions.require(db,event,user['id'],'attendance')
    if phase(event) not in ('ongoing','ended') or event['archived_at']:
        raise APIError('只有进行中或已结束待核对的活动可以现场补录',409)
    if db.execute('SELECT 1 FROM settlements WHERE event_id=?',(event['id'],)).fetchone():
        raise APIError('已有结算，不能补录正式名额；请先按结算流程核对',409)
    reason=string(data,'reason',200)
    if data.get('accept_terms') is not True:
        raise APIError('请确认已与现场参加者核对当前安排和费用规则')
    people=roster.normalized_people(db,event,user,data)
    count=db.execute("SELECT count(*) FROM attendees WHERE event_id=? AND status='confirmed'",(event['id'],)).fetchone()[0]
    if event['capacity'] and count+len(people)>event['capacity'] and data.get('allow_over_capacity') is not True:
        raise APIError('补录会超过人数上限，请明确确认超额名额',409)
    if db.execute("SELECT 1 FROM attendees WHERE event_id=? AND status='waiting' LIMIT 1",(event['id'],)).fetchone() and data.get('override_waitlist') is not True:
        raise APIError('仍有候补，请先协调并明确确认本次现场补录不按原候补排队',409)
    if type(data.get('conditions_version')) is not int or data['conditions_version']!=event['conditions_version']:
        raise APIError('请载入最新安排并确认现场人员已接受当前费用规则',409)
    before=roster.snapshot(db,event['id'])
    party=secrets.token_hex(8)
    db.execute('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)',(party,event['id'],user['id'],'individual',now()))
    for person in people:
        uid=secrets.token_hex(8)
        db.execute('''INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,attendance,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'confirmed','present',?,?)''',
            (uid,event['id'],user['id'],user['id'] if person['is_self'] else None,party,person['name'],person['note'],person['payer_kind'],now(),now()))
        conditions.accept_new(db,event,uid,user)
    roster.record(db,event,user,'onsite_added',before,reason)
