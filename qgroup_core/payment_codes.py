"""Account-owned reusable codes and immutable, version-bound settlement choices."""
import hashlib
import re
import secrets
from .common import APIError,now,string
from . import billing,media

KINDS=('wechat','alipay','other')


def owned(db,user_id,code_id):
    if not isinstance(code_id,str) or not re.fullmatch(r'[a-f0-9]{16}',code_id):raise APIError('收款码引用不正确')
    row=db.execute('SELECT * FROM user_payment_codes WHERE id=? AND user_id=? AND archived_at IS NULL',(code_id,user_id)).fetchone()
    if not row:raise APIError('收款码不存在或不属于当前账号',404)
    return row


def view(row):
    return dict(id=row['id'],kind=row['kind'],name=row['name'],created_at=row['created_at'],url='/api/payment-codes/'+row['id']+'/image')


def library(db,user_id):
    return [view(row) for row in db.execute('SELECT * FROM user_payment_codes WHERE user_id=? AND archived_at IS NULL ORDER BY created_at DESC,id DESC',(user_id,))]


def published_by(db,event_id,version,user_id):
    row=db.execute('SELECT actor_id FROM settlement_history WHERE event_id=? AND version=?',(event_id,version)).fetchone()
    return bool(row and row[0]==user_id)


def create(db,user,data):
    kind=data.get('kind')
    if kind not in KINDS:raise APIError('请选择微信、支付宝或其他收款方式')
    name=string(data,'name',40,False)
    if 'source' in data:
        source=data['source']
        if not isinstance(source,dict) or not isinstance(source.get('event_id'),str) or not re.fullmatch(r'[a-f0-9]{16}',source['event_id']) or type(source.get('version')) is not int or source['version']<1 or source.get('kind') not in KINDS:
            raise APIError('原版收款码引用不正确')
        event=db.execute("SELECT * FROM events WHERE id=? AND status!='deleted'",(source['event_id'],)).fetchone()
        if not event or not published_by(db,event['id'],source['version'],user['id']):raise APIError('只能保存自己发布结算时使用的收款码',403)
        prior=next((raw for meta,raw in existing(db,event['id'],source['version']) if meta['kind']==source['kind']),None)
        if not prior:raise APIError('原版收款码不存在，请重新选择')
        raw=prior
    else:raw=billing.qr_image(data.get('image'))
    if not raw:raise APIError('请选择收款码图片')
    digest=hashlib.sha256(raw).hexdigest()
    prior=db.execute('SELECT * FROM user_payment_codes WHERE user_id=? AND kind=? AND digest=? AND name=? AND archived_at IS NULL',(user['id'],kind,digest,name)).fetchone()
    if prior:return view(prior)
    if db.execute('SELECT count(*) FROM user_payment_codes WHERE user_id=? AND archived_at IS NULL',(user['id'],)).fetchone()[0]>=30:
        raise APIError('最多保存 30 张收款码，请先移除不再使用的码')
    media.put(db,raw);uid=secrets.token_hex(8)
    db.execute('INSERT INTO user_payment_codes VALUES(?,?,?,?,?,?,NULL)',(uid,user['id'],kind,name,digest,now()))
    return view(owned(db,user['id'],uid))


def archive(db,user,code_id):
    owned(db,user['id'],code_id)
    db.execute('UPDATE user_payment_codes SET archived_at=? WHERE id=?',(now(),code_id))
    return {'ok':True}


def frozen(db,event_id,version):
    rows=db.execute('SELECT kind,name,digest FROM settlement_code_images WHERE event_id=? AND version=?',(event_id,version)).fetchall()
    return sorted([dict(row) for row in rows],key=lambda row:KINDS.index(row['kind']))


def existing(db,event_id,version):
    rows=frozen(db,event_id,version)
    if rows:return [(row,media.read(db,row['digest'])) for row in rows]
    old=db.execute('SELECT qr_image FROM settlement_history WHERE event_id=? AND version=?',(event_id,version)).fetchone()
    if old and old[0]:return [(dict(kind='other',name='',digest=hashlib.sha256(old[0]).hexdigest()),old[0])]
    return []


def descriptors(db,event_id,version):
    rows=frozen(db,event_id,version)
    if rows:return [dict(kind=row['kind'],name=row['name'],url=f'/api/events/{event_id}/settlement/history/{version}/payment-codes/{row["kind"]}') for row in rows]
    old=db.execute('SELECT length(qr_image) FROM settlement_history WHERE event_id=? AND version=?',(event_id,version)).fetchone()
    return [dict(kind='other',name='',url=f'/api/events/{event_id}/settlement/history/{version}/payment-code')] if old and old[0] else []


def resolve(db,event,user,data,version):
    if 'payment_codes' not in data:
        if 'qr_image' in data:
            raw=billing.qr_image(data['qr_image'])
            return [(dict(kind='other',name='',digest=hashlib.sha256(raw).hexdigest()),raw)] if raw else []
        return existing(db,event['id'],version) if published_by(db,event['id'],version,user['id']) else []
    if 'qr_image' in data:raise APIError('请刷新收款码选择后重新预览')
    choices=data['payment_codes']
    if not isinstance(choices,list) or len(choices)>3:raise APIError('每种收款方式最多选择一张，合计最多三张')
    result=[];seen=set()
    for choice in choices:
        if not isinstance(choice,dict) or choice.get('kind') not in KINDS or choice['kind'] in seen:raise APIError('每种收款方式最多选择一张，合计最多三张')
        kind=choice['kind'];seen.add(kind)
        if 'code_id' in choice:
            row=owned(db,user['id'],choice['code_id'])
            if row['kind']!=kind:raise APIError('收款码类别不一致，请重新选择')
            result.append((dict(kind=kind,name=row['name'],digest=row['digest']),media.read(db,row['digest'])))
        elif 'image' in choice:
            raw=billing.qr_image(choice['image'])
            if not raw:raise APIError('请选择收款码图片')
            result.append((dict(kind=kind,name=string(choice,'name',40,False),digest=hashlib.sha256(raw).hexdigest()),raw))
        elif type(choice.get('version')) is int and 0<choice['version']<=version:
            if not published_by(db,event['id'],choice['version'],user['id']):raise APIError('收款人已变更，请选择当前账号自己的收款码',403)
            prior=next(((meta,raw) for meta,raw in existing(db,event['id'],choice['version']) if meta['kind']==kind),None)
            if not prior:raise APIError('原版收款码不存在，请重新选择')
            result.append(prior)
        else:raise APIError('收款码引用不正确，请重新选择')
    return sorted(result,key=lambda row:KINDS.index(row[0]['kind']))


def attach(db,event_id,version,choices):
    for meta,raw in choices:
        digest=media.put(db,raw)
        db.execute('INSERT INTO settlement_code_images VALUES(?,?,?,?,?)',(event_id,version,meta['kind'],meta['name'],digest))
