"""Administrator operations reached only through the authenticated board gateway."""
from .identity_store import Rejected


def projection(data, store):
    """Replay durable unlink/correction decisions before the current identity map."""
    with store.connect() as db:
        for table in ('link_overrides','prelinks','links'):
            for row in db.execute('SELECT qq,user_id FROM '+table):
                if row['qq'] in data['members']:
                    data['members'][row['qq']]['boardUserId']=row['user_id']


def view(data, store):
    with store.connect() as db:
        db.execute('BEGIN')
        members=[dict(qq=qq,name=m.get('name',''),has_pin=bool(m.get('pinHash')),
                      **store.admin_state(db,qq)) for qq,m in data['members'].items()]
        history=[dict(r) for r in db.execute('SELECT qq,actor,before_user_id,after_user_id,created FROM link_audit ORDER BY id DESC LIMIT 20')]
    return dict(members=members,history=history)


def change(data, store, body, actor):
    qq=body.get('qq');uid=body.get('user_id');revision=body.get('base_revision')
    if not all(isinstance(value,str) for value in (qq,uid,revision)) or len(revision)!=64:
        raise Rejected('成分站关联格式不正确',400)
    if qq not in data['members']:raise Rejected('成分会员不存在',404)
    result=store.admin_change(qq,uid,revision,actor)
    projection(data,store)
    return result
