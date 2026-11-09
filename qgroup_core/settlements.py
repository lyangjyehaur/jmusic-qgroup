"""Versioned per-person invoices. Integer cents and rational largest-remainder allocation."""
import hashlib
import json
import re
from fractions import Fraction
from .common import APIError, now, string
from . import audit, billing, roster, media, payment_codes

ID=re.compile(r'[a-f0-9]{16}\Z')
MAX_CENTS=999999999


def amount(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{1,7}(?:\.[0-9]{1,2})?',value):
        raise APIError('金额最多七位整数、两位小数，不能为负数')
    whole,_,decimal=value.partition('.')
    return int(whole)*100+int(decimal.ljust(2,'0') or '0')


def weight(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{1,4}(?:\.[0-9]{1,3})?',value) or Fraction(value)>1000:
        raise APIError('份数／比例为 0–1000，最多三位小数')
    return Fraction(value)


def split(cents,weights):
    """Largest remainders first, ties in frozen roster order. Sign does not affect ordering."""
    total=sum(weights,Fraction())
    if not total:
        if cents:raise APIError('这项费用没有有效分摊对象，请选择人员或设置正份数')
        return [0]*len(weights)
    exact=[abs(cents)*w/total for w in weights]
    result=[int(v) for v in exact]
    for i in sorted(range(len(weights)),key=lambda i:(-(exact[i]-result[i]),i))[:abs(cents)-sum(result)]:
        result[i]+=1
    return [v if cents>=0 else -v for v in result]


def account_key(event_id,user_id):
    return 'account:'+hashlib.sha256((event_id+':'+user_id).encode()).hexdigest()[:16]


def context(db,event,user):
    if event['owner_id']!=user['id']:raise APIError('只有发起者可以核对结算名单',403)
    people=[];payers={}
    owner=db.execute('SELECT nickname FROM users WHERE id=?',(event['owner_id'],)).fetchone()[0]
    payers[account_key(event['id'],event['owner_id'])]=owner
    versions={r[0]:json.loads(r[1]) for r in db.execute('SELECT version,snapshot_json FROM event_conditions WHERE event_id=?',(event['id'],))}
    for row in roster.rows(db,event['id']):
        if row['status']=='invited':continue
        manager=account_key(event['id'],row['manager_id'])
        own=account_key(event['id'],row['user_id']) if row['user_id'] else 'person:'+row['id']
        payers[manager]=row['manager_name'];payers[own]=row['nickname']
        origin=db.execute('SELECT * FROM attendee_payment_origins WHERE attendee_id=?',(row['id'],)).fetchone()
        payer_id=origin['payer_id'] if origin else manager if row['payer_kind']=='manager' else own
        if origin:payers.setdefault(origin['payer_id'],origin['payer_name'])
        people.append(dict(id=row['id'],name=row['nickname'],status=row['status'],attendance=row['attendance'],
            manager_name=row['manager_name'],payer_id=payer_id,
            accepted_conditions_version=row['accepted_conditions_version'],confirmation_state=row['confirmation_state'],
            accepted_arrangement=versions.get(row['accepted_conditions_version']),withdrawal_requested=bool(row['withdrawal_requested'])))
    # Confirmed prepayments/advances may belong to a person outside the signup roster.
    # Preserve that same ID when assigning final liability; never match by nickname.
    for row in db.execute('SELECT payload_json FROM finance_entries WHERE event_id=? ORDER BY seq',(event['id'],)):
        for p in json.loads(row[0]).get('parties',[]):payers.setdefault(p['id'],p['name'])
    for i,p in enumerate(people,1):p['label']=p['name']+('（报名 '+str(i)+'）' if sum(q['name']==p['name'] for q in people)>1 else '')
    payer_list=[dict(id=k,name=v,label=v+('（付款人 '+str(i)+'）' if list(payers.values()).count(v)>1 else '')) for i,(k,v) in enumerate(payers.items(),1)]
    return dict(people=people,payers=payer_list)


def latest_version(db,event_id):
    return db.execute('SELECT COALESCE(MAX(version),0) FROM settlement_history WHERE event_id=?',(event_id,)).fetchone()[0]


def details(db,event_id,version):
    row=db.execute('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?',(event_id,version)).fetchone()
    return json.loads(row[0]) if row else None


def decorate(db,event_id,bill):
    result=billing.serialize_settlement(bill)
    result['payment_codes']=payment_codes.descriptors(db,event_id,bill['version'])
    result['has_qr']=bool(result['payment_codes'])
    detail=details(db,event_id,bill['version'])
    if detail:
        result.update(mode='detailed',detail=detail,headcount=len(detail['people']),per_person_amount=None,rounding_difference_cents=0)
    else:result['mode']='legacy'
    return result


def validate_version(db,event,data):
    if event['lifecycle'] not in ('ended','cancelled'):raise APIError('实际结束或取消后才能发布结算',409)
    version=latest_version(db,event['id'])
    if type(data.get('base_version')) is not int or data['base_version']!=version:
        raise APIError('结算已有更新，请保留输入后载入最新版本重新核对',409)
    return version


def receipt(db,event_id,item,version):
    value=item.get('receipt')
    if value is None:return None
    if isinstance(value,str):return billing.qr_image(value)
    if not isinstance(value,dict) or type(value.get('version')) is not int or not ID.fullmatch(str(value.get('item_id',''))):
        raise APIError('消费凭证引用不正确')
    if value['version']>version:raise APIError('消费凭证不存在，请重新选择图片')
    raw=media.receipt(db,event_id,value['version'],value['item_id'])
    if not raw:raise APIError('消费凭证不存在，请重新选择图片')
    return raw


def changes(before,after):
    if not before:return ['发布逐人核对后的费用与付款归属；旧人均版本如有则保留原样。']
    result=[]
    for key in ('people','items','payers'):
        prior={p['id']:p for p in before[key]};current={p['id']:p for p in after[key]}
        for uid in dict.fromkeys([*prior,*current]):
            old,new=prior.get(uid),current.get(uid);label=(new or old).get('label',(new or old)['name'])
            if old is None:result.append('新增'+label)
            elif new is None:result.append('不再列入本版：'+label)
            elif old!=new:
                if key=='people':
                    result.append(label+'：应付 '+billing.money(old['due_cents'])+' → '+billing.money(new['due_cents'])+' 元；共同份数 '+old['share']+' → '+new['share'])
                    if old['name']!=new['name']:result.append('称呼：'+old['name']+' → '+new['name'])
                    if old['payments']!=new['payments']:
                        describe=lambda p:'、'.join(v['name']+' '+billing.money(v['amount_cents']) for v in p['payments'])
                        result.append(label+' 付款归属：'+describe(old)+' → '+describe(new))
                    if old['attendance']!=new['attendance']:result.append(label+' 出席：'+old['attendance']+' → '+new['attendance'])
                    if old['accepted_conditions_version']!=new['accepted_conditions_version']:result.append(label+' 接受约定版本已更新')
                    if old['reason']!=new['reason']:result.append(label+' 核对原因：'+old['reason']+' → '+new['reason'])
                elif key=='items':
                    result.append(label+'：'+billing.money(old['amount_cents'])+' → '+billing.money(new['amount_cents'])+' 元；'+('分摊明细有调整' if old['breakdown']!=new['breakdown'] else '分摊明细不变'))
                    if old['name']!=new['name']:result.append('项目名称：'+old['name']+' → '+new['name'])
                    if old['receipt_digest']!=new['receipt_digest']:result.append(label+'：消费凭证已变更，原图保留于旧版本')
                    if old['reason']!=new['reason']:result.append(label+' 分摊依据：'+old['reason']+' → '+new['reason'])
                else:
                    result.append(label+' 付款合计：'+billing.money(old['amount_cents'])+' → '+billing.money(new['amount_cents'])+' 元')
                    if old['name']!=new['name']:result.append('付款人称呼：'+old['name']+' → '+new['name'])
    if before['note']!=after['note']:result.append('备注：'+(before['note'] or '无')+' → '+(after['note'] or '无'))
    if before['qr_digest']!=after['qr_digest'] or before.get('payment_codes',[])!=after.get('payment_codes',[]):result.append('收款码或收款方式已变更，旧图仍可在历史版本查看')
    return result


def calculate(db,event,user,data):
    current_version=validate_version(db,event,data)
    ctx=context(db,event,user)
    if data.get('reviewed_roster') is not True:raise APIError('请先逐人核对结算名单及费用约定')
    if db.execute('SELECT 1 FROM settlements WHERE event_id=?',(event['id'],)).fetchone() and not details(db,event['id'],current_version) and data.get('convert_legacy') is not True:
        raise APIError('旧人均账单需要明确确认转换；旧版本将完整保留')
    known={p['id']:p for p in ctx['people']};payers={p['id']:p['name'] for p in ctx['payers']}
    custom=data.get('custom_payers',[])
    if not isinstance(custom,list) or len(custom)>50:raise APIError('额外付款人数过多')
    custom_normal=[];custom_seen=set()
    for entry in custom:
        if not isinstance(entry,dict) or not re.fullmatch(r'custom:[a-f0-9]{16}',str(entry.get('id',''))) or entry['id'] in custom_seen:
            raise APIError('额外付款人标识不正确或重复')
        custom_seen.add(entry['id']);label=string(entry,'name',24);payers[entry['id']]=label;custom_normal.append(dict(id=entry['id'],name=label))
    source=data.get('people')
    if not isinstance(source,list) or len(source)>500:raise APIError('请核对结算人员（最多 500 人）')
    submitted={}
    for person in source:
        if not isinstance(person,dict) or not isinstance(person.get('id'),str) or person.get('id') not in known or person['id'] in submitted:
            raise APIError('结算名单含重复或其他活动的人员')
        submitted[person['id']]=person
    # Freeze the database roster order, independent of arbitrary request list ordering.
    payer_labels={key:name+('（付款人 '+str(index)+'）' if list(payers.values()).count(name)>1 else '') for index,(key,name) in enumerate(payers.items(),1)}
    people=[];inputs=[]
    for uid,original in known.items():
        person=submitted.get(uid)
        if person is None:
            if original['status']=='confirmed':raise APIError('请保留所有正式人员；不分摊共同费用可设为免 A 并写原因')
            continue
        share=person.get('share','1');weight(share)
        reason=string(person,'reason',300,False)
        exceptional=(weight(share)!=1 or original['status']!='confirmed' or original['attendance']=='absent' or original['withdrawal_requested'] or original['confirmation_state']!='accepted')
        if exceptional and not reason:raise APIError(original['name']+' 的份数、缺席／退出或约定差异需要核对原因')
        payments=person.get('payments',[dict(payer_id=original['payer_id'],share='1')])
        if not isinstance(payments,list) or not 1<=len(payments)<=20:raise APIError('每位参加者需指定 1–20 位付款人')
        mode=person.get('payment_mode','shares')
        if mode not in ('shares','fixed'):raise APIError('请选择付款归属分配方式')
        normalized=[];used=set()
        for payment in payments:
            if not isinstance(payment,dict) or not isinstance(payment.get('payer_id'),str) or payment.get('payer_id') not in payers or payment['payer_id'] in used:raise APIError('付款人不正确或重复')
            used.add(payment['payer_id']);value=payment.get('amount') if mode=='fixed' else payment.get('share','1')
            if mode=='fixed':amount(value)
            else:weight(value)
            normalized.append(dict(payer_id=payment['payer_id'],**{('amount' if mode=='fixed' else 'share'):value}))
        if (len(payments)!=1 or payments[0].get('payer_id')!=original['payer_id']) and not reason:raise APIError('变更付款归属请填写核对原因')
        people.append(dict(original,share=share,reason=reason,due_cents=0,allocations=[],payments=[]))
        inputs.append(dict(id=uid,share=share,reason=reason,payment_mode=mode,payments=normalized))
    by_id={p['id']:p for p in people}
    items=data.get('items')
    if not isinstance(items,list) or not 1<=len(items)<=50:raise APIError('请填写 1–50 项费用，免费活动可填 0 元')
    calculated=[];item_inputs=[];images={};seen=set();total=0
    for item in items:
        if not isinstance(item,dict) or not ID.fullmatch(str(item.get('id',''))) or item['id'] in seen:raise APIError('费用项标识不正确或重复')
        seen.add(item['id']);label=string(item,'name',80);kind=item.get('kind','expense')
        if kind not in ('expense','refund','discount'):raise APIError('请选择消费、店家退款或减免')
        unsigned=amount(item.get('amount'));cents=unsigned if kind=='expense' else -unsigned
        mode=item.get('mode','shares');scope=item.get('scope','common');reason=string(item,'reason',300,False)
        if mode not in ('shares','equal','weights','fixed','duration') or scope not in ('common','selected'):raise APIError('分摊方式或范围不正确')
        if (kind!='expense' or scope=='selected' or mode!='shares') and not reason:raise APIError('指定消费、退款、减免或特殊分摊需要填写依据')
        requested=item.get('allocations',[])
        if not isinstance(requested,list) or len(requested)>500:raise APIError('费用分配格式不正确')
        allocations={}
        for a in requested:
            if not isinstance(a,dict) or not isinstance(a.get('person_id'),str) or a.get('person_id') not in by_id or a['person_id'] in allocations:raise APIError('费用含重复或名单以外的分摊对象')
            allocations[a['person_id']]=a
        selected=people if scope=='common' else [p for p in people if p['id'] in allocations]
        if mode in ('fixed','weights','duration') and set(allocations)!={p['id'] for p in selected}:
            raise APIError('固定金额、比例及按时长分摊需为每位选中人员填写数值')
        weights=[];entries=[]
        for p in selected:
            a=allocations.get(p['id'],{})
            if mode=='fixed':value=amount(a.get('amount'));weights.append(Fraction(value));entries.append(dict(person_id=p['id'],amount=billing.money(value)))
            elif mode=='weights':value=a.get('weight','');weights.append(weight(value));entries.append(dict(person_id=p['id'],weight=value))
            elif mode=='duration':
                value=a.get('minutes')
                if type(value) is not int or not 0<=value<=1440:raise APIError('参与时长须为 0–1440 整分钟')
                weights.append(Fraction(value));entries.append(dict(person_id=p['id'],minutes=value))
            else:
                weights.append(weight(p['share']) if mode=='shares' else Fraction(1));entries.append(dict(person_id=p['id']))
        if mode=='fixed' and sum(weights)!=unsigned:raise APIError('固定指定金额合计必须等于这项费用')
        allocated=split(cents,weights)
        image=receipt(db,event['id'],item,current_version)
        if image:
            images[item['id']]=image
            if len(images)>3:raise APIError('每版最多三张消费凭证')
        digest=hashlib.sha256(image).hexdigest() if image else None
        normalized=dict(id=item['id'],name=label,kind=kind,amount=billing.money(unsigned),scope=scope,mode=mode,reason=reason,allocations=entries,receipt_digest=digest)
        breakdown=[]
        for p,value,entry in zip(selected,allocated,entries):
            p['due_cents']+=value;p['allocations'].append(dict(item_id=item['id'],amount_cents=value))
            breakdown.append(dict(person_id=p['id'],amount_cents=value,**{k:v for k,v in entry.items() if k!='person_id'}))
        calculated.append(dict(normalized,amount_cents=cents,breakdown=breakdown,has_receipt=bool(image)))
        item_inputs.append(normalized);total+=cents
    if total<0 or total>MAX_CENTS:raise APIError('结算净额需为 0–9999999.99 元；预收款退款请使用后续收退款账本')
    payer_totals={}
    for p,entry in zip(people,inputs):
        if p['due_cents']<0:raise APIError(p['name']+' 的退款／减免超过其消费，请核对对应项目；预收款退款不应冲减消费')
        payments=entry['payments']
        if entry['payment_mode']=='fixed':
            values=[amount(v['amount']) for v in payments]
            if sum(values)!=p['due_cents']:raise APIError(p['name']+' 的固定付款归属合计须等于其应付金额')
        else:values=split(p['due_cents'],[weight(v['share']) for v in payments])
        for v,cents in zip(payments,values):
            key=v['payer_id'];payer_totals[key]=payer_totals.get(key,0)+cents
            p['payments'].append(dict(payer_id=key,name=payers[key],label=payer_labels[key],amount_cents=cents))
    note=string(data,'note',1000,False)
    qr=payment_codes.resolve(db,event,user,data,current_version)
    if sum(len(im) for im in images.values())+sum(len(raw) for _,raw in qr)>6*1024*1024:raise APIError('本版图片合计超过 6 MiB，请压缩后重试')
    reason=string(data,'reason',300,False)
    if current_version and not reason:raise APIError('修改或转换结算请填写原因')
    used_payers={v['payer_id'] for p in inputs for v in p['payments']}
    custom_normal=[p for p in custom_normal if p['id'] in used_payers]
    snapshot=dict(people=people,items=calculated,payers=[dict(id=k,name=payers[k],label=payer_labels[k],amount_cents=v) for k,v in payer_totals.items()],
        total_cents=total,note=note,reason=reason,qr_digest=qr[0][0]['digest'] if qr else None,payment_codes=[meta for meta,_ in qr],
        rounding_rule='按最大余数补分，余数相同按本版冻结的报名顺序；每项独立分配。',
        input=dict(people=inputs,items=item_inputs,custom_payers=custom_normal))
    snapshot['changes']=changes(details(db,event['id'],current_version),snapshot)
    return snapshot,images,qr


def token(snapshot,event,version):
    return hashlib.sha256(json.dumps(dict(snapshot=snapshot,revision=event['revision'],version=version),sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def preview(db,event,user,data):
    snapshot,_,_=calculate(db,event,user,data)
    return dict(snapshot=snapshot,preview_token=token(snapshot,event,data['base_version']),base_revision=event['revision'],base_version=data['base_version'])


def save(db,event,user,data):
    snapshot,images,qr=calculate(db,event,user,data)
    version=data['base_version']
    if data.get('preview_token')!=token(snapshot,event,version):raise APIError('费用、图片或名单已改变，请重新预览再发布',409)
    previous=details(db,event['id'],version)
    # A repeated reviewed save is not a new business version.
    comparable=lambda s:{k:v for k,v in s.items() if k not in ('reason','changes')}
    if previous and comparable(previous)==comparable(snapshot):return
    stamp=now();next_version=version+1
    fields=[k for k in ('people','items','payers','note','qr_digest','payment_codes') if not previous or previous.get(k)!=snapshot[k]]
    row=db.execute('SELECT total_cents FROM settlements WHERE event_id=?',(event['id'],)).fetchone()
    db.execute('''INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)''',(event['id'],next_version,snapshot['total_cents'],max(1,len(snapshot['people'])),snapshot['note'],None,stamp,user['id'],user['nickname'],
        'detailed_edited' if previous else 'converted' if row else 'detailed_published',json.dumps(fields)))
    db.execute('INSERT INTO settlement_details VALUES(?,?,?)',(event['id'],next_version,json.dumps(snapshot,ensure_ascii=False)))
    payment_codes.attach(db,event['id'],next_version,qr)
    for uid,image in images.items():db.execute('INSERT INTO settlement_receipt_images VALUES(?,?,?,?)',(event['id'],next_version,uid,media.put(db,image)))
    db.execute('''INSERT INTO settlements(event_id,total_cents,headcount,qr_image,note,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET total_cents=excluded.total_cents,headcount=excluded.headcount,qr_image=excluded.qr_image,note=excluded.note,updated_at=excluded.updated_at''',
        (event['id'],snapshot['total_cents'],max(1,len(snapshot['people'])),None,snapshot['note'],stamp))
    audit.append(db,event,user,'settlement_saved',dict(version=version,total_amount=billing.money(row[0])) if row else {},
        dict(version=next_version,total_amount=billing.money(snapshot['total_cents']),mode='detailed',changed_fields=fields),snapshot['reason'])
    recipients={r[0] for r in db.execute("SELECT DISTINCT manager_id FROM attendees WHERE event_id=? AND status!='invited'",(event['id'],))}
    for uid in recipients:audit.notify(db,uid,event['id'],'settlement_updated',event['title']+' 已发布逐人结算第 '+str(next_version)+' 版，请查看应付与付款归属')
