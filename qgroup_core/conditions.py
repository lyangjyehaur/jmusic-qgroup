"""Immutable arrangements and explicit per-person agreement versions."""
import json
from .common import APIError, now, string
from . import audit

FIELDS=('category','starts_at','duration_hours','location','description','withdrawal_deadline','timezone','fee_policy')
LABELS={'category':'类型','starts_at':'时间','duration_hours':'时长','location':'地点','description':'注意事项',
    'withdrawal_deadline':'退出期限','timezone':'时区','fee_policy':'费用规则'}


def snapshot(event):
    result={key:event[key] for key in FIELDS}
    result['withdrawal_deadline']=event['withdrawal_deadline'] or event['deadline']
    return result


def publish(db,event,user=None,summary='初始安排'):
    db.execute('''INSERT INTO event_conditions(event_id,version,snapshot_json,summary,actor_name,created_at)
        VALUES(?,?,?,?,?,?)''',(event['id'],event['conditions_version'],json.dumps(snapshot(event),ensure_ascii=False),
        summary,user['nickname'] if user else '原有安排',now()))


def current(db,event):
    row=db.execute('SELECT snapshot_json,summary,created_at FROM event_conditions WHERE event_id=? AND version=?',
        (event['id'],event['conditions_version'])).fetchone()
    if not row:
        return dict(version=event['conditions_version'],arrangement=snapshot(event),summary='尚未发布的安排',created_at=event['created_at'])
    return dict(version=event['conditions_version'],arrangement=json.loads(row[0]),summary=row[1],created_at=row[2])


def accept_new(db,event,person_id,user):
    db.execute("UPDATE attendees SET accepted_conditions_version=?,confirmation_state='accepted' WHERE id=?",
        (event['conditions_version'],person_id))
    db.execute('''INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at)
        VALUES(?,?,?,'accepted',?,?,?,?)''',(person_id,event['id'],event['conditions_version'],user['id'],user['nickname'],'报名时接受当前安排',now()))


def revise(db,before,after,user,reason):
    prior,current=snapshot(before),snapshot(after)
    changed=[key for key in FIELDS if prior[key]!=current[key]]
    if not changed or after['lifecycle']=='draft':
        return []
    version=before['conditions_version']+1
    summary='、'.join(LABELS[key] for key in changed)+'已变更'
    db.execute('UPDATE events SET conditions_version=?,change_summary=? WHERE id=?',(version,summary,after['id']))
    updated=db.execute('SELECT * FROM events WHERE id=?',(after['id'],)).fetchone()
    publish(db,updated,user,summary+('：'+reason if reason else ''))
    # Existing agreements remain intact. No automatic withdrawal, acceptance, or new fee liability.
    affected=db.execute("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status IN ('confirmed','waiting','tentative')",(after['id'],)).fetchall()
    db.execute("UPDATE attendees SET confirmation_state='pending' WHERE event_id=? AND status IN ('confirmed','waiting','tentative')",(after['id'],))
    for manager in affected:
        audit.notify(db,manager[0],after['id'],'conditions_changed',after['title']+'：'+summary+'，请确认本人及代报名单的安排')
    return changed


def respond(db,event,user,person_id,data):
    if event['lifecycle'] not in ('scheduled','ongoing') or event['archived_at']:
        raise APIError('活动已结束、取消或归档，不能再确认新安排',409)
    person=db.execute("SELECT a.*,COALESCE(u.nickname,a.name) AS current_name FROM attendees a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.event_id=? AND status IN ('confirmed','waiting','tentative')",(person_id,event['id'])).fetchone()
    if not person:
        raise APIError('这位参加者不在有效名单中',404)
    if person['manager_id']!=user['id']:
        raise APIError('只能确认本人或自己代报人员的安排',403)
    if type(data.get('conditions_version')) is not int or data['conditions_version']!=event['conditions_version']:
        raise APIError('安排又有变更，请载入最新安排再确认',409)
    decision=data.get('decision')
    if decision not in ('accepted','declined'):
        raise APIError('请选择接受或暂不同意')
    reason=string(data,'reason',200,decision=='declined')
    if person['confirmation_state']==decision and (decision!='accepted' or person['accepted_conditions_version']==event['conditions_version']):
        return
    before=dict(person_id=person_id,nickname=person['current_name'],confirmation=person['confirmation_state'],accepted_version=person['accepted_conditions_version'])
    db.execute('UPDATE attendees SET confirmation_state=?,accepted_conditions_version=?,updated_at=? WHERE id=?',
        (decision,event['conditions_version'] if decision=='accepted' else person['accepted_conditions_version'],now(),person_id))
    db.execute('''INSERT INTO attendee_consents(attendee_id,event_id,version,decision,actor_id,actor_name,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?)''',(person_id,event['id'],event['conditions_version'],decision,user['id'],user['nickname'],reason,now()))
    audit.append(db,event,user,'conditions_response',before,
        dict(person_id=person_id,nickname=person['current_name'],confirmation=decision,accepted_version=event['conditions_version'] if decision=='accepted' else person['accepted_conditions_version']),reason)
    if decision=='declined':
        audit.notify(db,event['owner_id'],event['id'],'conditions_declined',person['current_name']+' 暂不同意新安排：'+reason+'；原报名及原约定保留，请协调处理')
