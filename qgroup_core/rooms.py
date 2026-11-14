"""Room plans and room-scoped reconciliation. Plans never imply money was paid."""
import json

from .common import APIError, now, string
from . import audit


def migrate(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=19').fetchone():return
    db.execute('''CREATE TABLE event_room_plans(event_id TEXT NOT NULL REFERENCES events(id),
        version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(event_id,version))''')
    for op in ('UPDATE','DELETE'):
        db.execute('CREATE TRIGGER event_room_plans_no_'+op.lower()+' BEFORE '+op+
                   " ON event_room_plans BEGIN SELECT RAISE(ABORT,'Room plans are append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(19,?)',(now(),))


def plan(db,event_id):
    row=db.execute('SELECT snapshot_json FROM event_room_plans WHERE event_id=? ORDER BY version DESC LIMIT 1',(event_id,)).fetchone()
    return json.loads(row[0]) if row else []


def current(db,event_id):
    from . import settlements
    detail=settlements.details(db,event_id,settlements.latest_version(db,event_id))
    return detail.get('rooms',[]) if detail else plan(db,event_id)


def normalize(source,people,payers,final=False):
    from . import settlements
    if not isinstance(source,list) or len(source)>50:raise APIError('包间最多 50 个')
    result=[];ids=set();names=set();assigned=set()
    for room in source:
        if not isinstance(room,dict) or not isinstance(room.get('id'),str) or not settlements.ID.fullmatch(room['id']) or room['id'] in ids:
            raise APIError('包间标识不正确或重复')
        ids.add(room['id']);name=string(room,'name',40)
        if name.casefold() in names:raise APIError('同一活动的包间名称不能重复')
        names.add(name.casefold())
        payer=room.get('payer_id')
        if not isinstance(payer,str) or payer not in payers:raise APIError('请选择本活动的包间付款人')
        members=room.get('person_ids')
        if not isinstance(members,list) or len(members)>500:raise APIError('请核对包间人员')
        for uid in members:
            if not isinstance(uid,str) or uid not in people or uid in assigned:raise APIError('包间人员重复、未列入本版或不属于本活动')
            assigned.add(uid)
        item=dict(id=room['id'],name=name,payer_id=payer,payer_name=payers[payer],person_ids=[uid for uid in people if uid in members])
        if final:
            value=room.get('amount');settlements.amount(value)
            mode=room.get('merchant_mode','unpaid')
            if mode not in ('unpaid','paid','recorded'):raise APIError('请确认各包间的实际付款情况')
            item.update(amount=value,merchant_mode=mode)
            if mode=='paid':item['paid_amount']=room.get('paid_amount',value)
        result.append(item)
    if final and assigned!=set(people):raise APIError('请为每位结算人员分配实际包间；免 A 者也须保留')
    return result


def save_plan(db,event,user,data):
    from . import settlements
    if event['owner_id']!=user['id']:raise APIError('只有发起者可以分配包间及指定付款人',403)
    if event['archived_at'] or event['lifecycle'] in ('draft','cancelled') or settlements.latest_version(db,event['id']):
        raise APIError('当前不能修改预分包间；已发布账单请在结算中更正实际包间',409)
    ctx=settlements.context(db,event,user)
    people={p['id']:p for p in ctx['people'] if p['status']!='withdrawn'}
    normalized=normalize(data.get('rooms'),people,{p['id']:p['name'] for p in ctx['payers']})
    for room in normalized:room['payer_label']=next(p['label'] for p in ctx['payers'] if p['id']==room['payer_id'])
    before=plan(db,event['id'])
    if before==normalized:return
    # Preserve room identities once money has been attributed to them.
    used=journal_room_ids(db,event['id'])
    if used-{r['id'] for r in normalized}:raise APIError('已有款项的包间须保留；先在账本核对并冲销错误款项',409)
    version=db.execute('SELECT COALESCE(MAX(version),0)+1 FROM event_room_plans WHERE event_id=?',(event['id'],)).fetchone()[0]
    db.execute('INSERT INTO event_room_plans VALUES(?,?,?,?)',(event['id'],version,json.dumps(normalized,ensure_ascii=False),now()))
    audit.append(db,event,user,'rooms_updated',dict(rooms=before),dict(rooms=normalized),string(data,'reason',300,False))


def journal_room_ids(db,event_id):
    from . import finance
    entries=finance.rows(db,event_id);reversed_ids=finance.project(entries)['reversed_ids']
    return {e['payload']['room_id'] for e in entries if e['id'] not in reversed_ids and e['payload'].get('room_id')}


def scoped_entries(entries,room_id):
    return [e for e in entries if e['payload'].get('room_id')==room_id or e['kind']=='reversal']


def validate_journal(entries,definitions,strict=False):
    from . import finance
    active=finance.project(entries)['reversed_ids'];known={r['id'] for r in definitions}
    for e in entries:
        if e['kind'] not in finance.KINDS or e['id'] in active:continue
        rid=e['payload'].get('room_id')
        if rid and rid not in known:raise APIError('已有款项的包间须保留；先在账本核对并冲销错误款项',409)
        if strict and rid not in known:raise APIError('已有未指定包间的款项，请先冲销并按包间重新登记后结算',409)
    for r in definitions:finance.project(scoped_entries(entries,r['id']))


def reconciliation(snapshot,entries):
    """Never net balances between rooms, even when an account participates in both."""
    from . import finance
    result=[]
    names={p['id']:p.get('label',p['name']) for p in snapshot['payers']}
    for e in entries:
        for p in e['payload'].get('parties',[]):names.setdefault(p['id'],p.get('label',p['name']))
    people={p['id']:p for p in snapshot['people']}
    for room in snapshot.get('rooms',[]):
        state=finance.project(scoped_entries(entries,room['id']));dues={}
        item=next(i for i in snapshot['items'] if i['id']==room['id'])
        for allocation in item['breakdown']:
            p=people[allocation['person_id']]
            # A person belongs to exactly one room, so their liability split is already exact.
            for payment in p['payments']:dues[payment['payer_id']]=dues.get(payment['payer_id'],0)+payment['amount_cents']
        balances=[dict(id=k,name=names.get(k,room['payer_name']),due_cents=dues.get(k,0),contributed_cents=state['credit'].get(k,0),
                       balance_cents=dues.get(k,0)-state['credit'].get(k,0)) for k in dict.fromkeys([*dues,*state['credit']])]
        transfers=[]
        for b in balances:
            delta=b['balance_cents'];collector=room['payer_id']
            if not delta or b['id']==collector:continue
            transfers.append(dict(from_id=b['id'] if delta>0 else collector,to_id=collector if delta>0 else b['id'],
                from_name=b['name'] if delta>0 else room.get('payer_label',room['payer_name']),to_name=room.get('payer_label',room['payer_name']) if delta>0 else b['name'],
                amount_cents=abs(delta),kind='collection' if delta>0 else 'reimbursement'))
        result.append(dict(id=room['id'],name=room['name'],payer_id=room['payer_id'],payer_name=room['payer_name'],
            payer_label=room.get('payer_label',room['payer_name']),total_cents=item['amount_cents'],cost_cents=state['cost_cents'],held_cents=state['held_cents'],deposit_cents=state['deposit_cents'],
            balances=balances,transfers=transfers))
    return result
