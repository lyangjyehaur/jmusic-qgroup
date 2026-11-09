"""Append-only cash journal, reviewed payment claims and exact per-payer reconciliation.

Contributions = merchant costs + open deposits + money held for the event.
Invoice obligations are independent: changing a bill never moves confirmed money.
"""
import hashlib
import json
import re
from datetime import datetime, timezone

from . import audit, billing, roster, settlements
from .common import APIError, date_value, now, string

KINDS={'collection':'收款','refund':'退还参加者','reimbursement':'偿还垫付','expense':'支付店家',
    'merchant_refund':'店家退差价','deposit':'支付订金／押金','deposit_return':'店家退订金／押金',
    'deposit_apply':'订金抵消费／押金转损失','credit_transfer':'更正款项归属','cash_transfer':'移交代收资金'}
METHODS={'wechat':'微信','alipay':'支付宝','qq':'QQ','cash':'现金','other':'其他'}
PARTY=re.compile(r'(?:account:[a-f0-9]{16}|person:[a-f0-9]{16}|custom:[a-f0-9]{16})\Z')


def rows(db,event_id):
    return [dict(r, payload=json.loads(r['payload_json'])) for r in db.execute(
        'SELECT * FROM finance_entries WHERE event_id=? ORDER BY seq',(event_id,))]


def reports(db,event_id):
    return [dict(r,payload=json.loads(r['payload_json'])) for r in db.execute('''SELECT r.*,a.decision,a.reason AS decision_reason,
        a.actor_name AS decision_by,a.created_at AS decided_at FROM finance_reports r
        LEFT JOIN finance_report_actions a ON a.report_id=r.id WHERE r.event_id=? ORDER BY r.seq''',(event_id,))]


def participants(db,event,viewer=None,entries=None,claims=None):
    """Stable IDs; same names never merge. Retain parties no longer on the current bill."""
    result={};users={};owned=set()
    def add(uid,name,label=None):
        result[uid]=dict(id=uid,name=name,label=label or name)
    ctx=settlements.context(db,event,{'id':event['owner_id']})
    for p in ctx['payers']:add(p['id'],p['name'],p['label'])
    related={event['owner_id']}
    for r in db.execute('SELECT manager_id,user_id FROM attendees WHERE event_id=?',(event['id'],)):
        related.add(r['manager_id'])
        if r['user_id']:related.add(r['user_id'])
    related.update(r[0] for r in db.execute('SELECT user_id FROM event_roles WHERE event_id=?',(event['id'],)))
    related.update(r[0] for r in db.execute('SELECT o.payer_user_id FROM attendee_payment_origins o JOIN attendees a ON a.id=o.attendee_id WHERE a.event_id=? AND o.payer_user_id IS NOT NULL',(event['id'],)))
    for uid in related:
        u=db.execute('SELECT nickname FROM users WHERE id=?',(uid,)).fetchone()
        if u:
            key=settlements.account_key(event['id'],uid);add(key,u[0]);users[key]=uid
            if uid==viewer:owned.add(key)
    for r in db.execute('SELECT id,manager_id,user_id FROM attendees WHERE event_id=?',(event['id'],)):
        if not r['user_id'] and r['manager_id']==viewer:owned.add('person:'+r['id'])
    for r in db.execute('SELECT o.*,a.user_id,a.manager_id FROM attendee_payment_origins o JOIN attendees a ON a.id=o.attendee_id WHERE a.event_id=?',(event['id'],)):
        if r['claimant_owns'] and r['user_id']:
            users[r['payer_id']]=r['user_id']
            if r['user_id']==viewer:owned.add(r['payer_id'])
        if viewer and r['payer_id']==settlements.account_key(event['id'],viewer):owned.add(r['payer_id']);users[r['payer_id']]=viewer
    for r in db.execute('SELECT snapshot_json FROM settlement_details WHERE event_id=? ORDER BY version',(event['id'],)):
        snapshot=json.loads(r[0])
        for p in snapshot['input'].get('custom_payers',[]):
            if p['id'] not in result:add(p['id'],p['name'])
        for p in snapshot['payers']:
            if p['id'] not in result:add(p['id'],p['name'],p.get('label'))
    for entry in (entries if entries is not None else rows(db,event['id']))+(claims if claims is not None else reports(db,event['id'])):
        for p in entry['payload'].get('parties',[]):
            if p['id'] not in result:add(p['id'],p['name'],p.get('label'))
    # Distinguish custom names from current roster names as well.
    counts={p['name']:sum(q['name']==p['name'] for q in result.values()) for p in result.values()}
    for index,p in enumerate(result.values(),1):
        p['label']=p['name']+('（账户 '+str(index)+'）' if counts[p['name']]>1 else '')
    return result,owned,users


def bill(db,event_id):
    version=settlements.latest_version(db,event_id)
    return version,settlements.details(db,event_id,version) if version else None


def project(entries):
    """Project active journal rows and validate accounting invariants in integer cents."""
    reversed_ids={e['reversal_of'] for e in entries if e['kind']=='reversal'}
    active={e['id']:e for e in entries if e['id'] not in reversed_ids and e['kind'] in KINDS}
    credit={};cash={};deposits={};expenses={};cost=0
    def bump(target,key,amount):target[key]=target.get(key,0)+amount
    for e in active.values():
        p=e['payload'];amount=p['amount_cents'];kind=e['kind']
        if kind=='collection':bump(credit,p['payer_id'],amount);bump(cash,p['custodian_id'],amount)
        elif kind in ('refund','reimbursement'):
            bump(credit,p['payer_id'],-amount)
            if p.get('funding','pool')=='payer':bump(credit,p['funder_id'],amount)
            else:bump(cash,p['custodian_id'],-amount)
        elif kind in ('expense','deposit'):
            if p['funding']=='payer':bump(credit,p['payer_id'],amount)
            else:bump(cash,p['custodian_id'],-amount)
            if kind=='expense':cost+=amount;expenses[e['id']]=dict(entry=e,remaining_cents=amount)
            else:deposits[e['id']]=dict(entry=e,remaining_cents=amount)
        elif kind=='merchant_refund':
            cost-=amount
            if p['funding']=='payer':bump(credit,p['payer_id'],-amount)
            else:bump(cash,p['custodian_id'],amount)
        elif kind=='deposit_return':
            if p['funding']=='payer':bump(credit,p['payer_id'],-amount)
            else:bump(cash,p['custodian_id'],amount)
        elif kind=='deposit_apply':cost+=amount;expenses[e['id']]=dict(entry=e,remaining_cents=amount)
        elif kind=='credit_transfer':bump(credit,p['from_id'],-amount);bump(credit,p['to_id'],amount)
        elif kind=='cash_transfer':bump(cash,p['from_id'],-amount);bump(cash,p['to_id'],amount)
    for e in active.values():
        kind=e['kind'];p=e['payload']
        if kind in ('deposit_return','deposit_apply','merchant_refund'):
            target=(expenses if kind=='merchant_refund' else deposits).get(p['reference_id'])
            if not target or target['entry']['seq']>=e['seq']:
                raise APIError('关联的店家支出／订金已被冲销，请先更正后续关联记录',409)
            target['remaining_cents']-=p['amount_cents']
            if target['remaining_cents']<0:raise APIError('退回／抵扣金额超过关联支出的剩余金额',409)
    if any(v<0 for v in credit.values()):raise APIError('退还或更正超过该付款人的已确认净投入，请先核对关联款项',409)
    if any(v<0 for v in cash.values()):raise APIError('代收资金不足；个人先付店家的款项请记为个人垫付',409)
    open_deposits=sum(v['remaining_cents'] for v in deposits.values())
    if sum(credit.values())!=cost+open_deposits+sum(cash.values()):raise RuntimeError('Unbalanced cash journal')
    return dict(credit=credit,cash=cash,deposits=deposits,expenses=expenses,cost_cents=cost,
        deposit_cents=open_deposits,held_cents=sum(cash.values()),reversed_ids=reversed_ids)


def my_keys(db,event,viewer):
    if not viewer:return set()
    result={settlements.account_key(event['id'],viewer)}
    result.update(r[0] for r in db.execute('SELECT o.payer_id FROM attendee_payment_origins o JOIN attendees a ON a.id=o.attendee_id WHERE a.event_id=? AND a.user_id=? AND o.claimant_owns=1',(event['id'],viewer)))
    return result


def summary(db,event,viewer=None,entries=None,claims=None):
    entries=rows(db,event['id']) if entries is None else entries
    claims=reports(db,event['id']) if claims is None else claims
    state=project(entries);version,invoice=bill(db,event['id'])
    parties,owned,_=participants(db,event,viewer,entries,claims)
    dues={p['id']:p['amount_cents'] for p in invoice['payers']} if invoice else {}
    balances=[dict(parties[key],due_cents=dues.get(key,0) if invoice else None,
        contributed_cents=state['credit'].get(key,0),balance_cents=dues.get(key,0)-state['credit'].get(key,0) if invoice else None)
        for key in dict.fromkeys([*dues,*state['credit']])]
    pending=[p for p in claims if not p['decision']]
    closed=bool(entries and entries[-1]['kind']=='close' and entries[-1]['payload']['bill_version']==version and not pending)
    status='closed' if closed else 'collecting' if invoice else 'unpublished'
    mine=[b for b in balances if viewer and b['id'] in my_keys(db,event,viewer)]
    return dict(state=status,bill_version=version,detailed=bool(invoice),has_records=bool(entries or claims),
        total_due_cents=invoice['total_cents'] if invoice else None,cost_cents=state['cost_cents'],
        held_cents=state['held_cents'],deposit_cents=state['deposit_cents'],
        outstanding_cents=sum(max(0,b['balance_cents']) for b in balances) if invoice else None,
        refund_due_cents=sum(max(0,-b['balance_cents']) for b in balances) if invoice else None,
        my_balance_cents=sum(b['balance_cents'] for b in mine) if invoice and mine else None,
        my_outstanding_cents=sum(max(0,b['balance_cents']) for b in mine) if invoice and mine else None,
        my_refund_due_cents=sum(max(0,-b['balance_cents']) for b in mine) if invoice and mine else None,
        pending_count=len(pending) if viewer==event['owner_id'] else sum(p['reporter_id']==viewer for p in pending),
        can_manage=viewer==event['owner_id'],can_report=bool(owned) and event['lifecycle']!='draft',
        balances=balances,custodians=[dict(parties[k],held_cents=v) for k,v in state['cash'].items()],
        last_seq=entries[-1]['seq'] if entries else 0)


def public_entry(entry,reversed_ids):
    return dict(id=entry['id'],seq=entry['seq'],kind=entry['kind'],payload=entry['payload'],
        occurred_at=entry['occurred_at'],created_at=entry['created_at'],actor_name=entry['actor_name'],
        source_report_id=entry['source_report_id'],reversal_of=entry['reversal_of'],reversed=entry['id'] in reversed_ids)


def view(db,event,viewer,before=None,before_report=None):
    entries=rows(db,event['id']);claims=reports(db,event['id']);s=summary(db,event,viewer,entries,claims)
    parties,owned,_=participants(db,event,viewer,entries,claims);state=project(entries)
    selected=[e for e in reversed(entries) if before is None or e['seq']<before]
    visible_reports=[dict(id=r['id'],seq=r['seq'],payload=r['payload'],reporter_name=r['reporter_name'],created_at=r['created_at'],
        status=r['decision'] or 'pending',reason=r['decision_reason'],decision_by=r['decision_by'],decided_at=r['decided_at'],
        can_withdraw=not r['decision'] and r['reporter_id']==viewer,
        entry_id=next((e['id'] for e in entries if e['source_report_id']==r['id']),None),
        entry_reversed=any(e['id'] in state['reversed_ids'] for e in entries if e['source_report_id']==r['id']))
        for r in claims if viewer==event['owner_id'] or r['reporter_id']==viewer]
    pending=[r for r in visible_reports if r['status']=='pending']
    decided=[r for r in reversed(visible_reports) if r['status']!='pending' and (before_report is None or r['seq']<before_report)]
    return dict(summary=s,close_blockers=blocked(s,sum(not c['decision'] for c in claims)),parties=list(parties.values()),reportable_ids=sorted(owned),
        default_custodian_id=settlements.account_key(event['id'],event['owner_id']),
        entries=[public_entry(e,state['reversed_ids']) for e in selected[:100]],
        next_before=selected[99]['seq'] if len(selected)>100 else None,
        reports=(pending if before_report is None else [])+decided[:100],
        next_report_before=decided[99]['seq'] if len(decided)>100 else None,
        references=[dict(id=e['entry']['id'],kind=e['entry']['kind'],remaining_cents=e['remaining_cents'],
            payload=e['entry']['payload']) for e in [*state['deposits'].values(),*state['expenses'].values()] if e['remaining_cents']>0])


def positive(data):
    value=settlements.amount(data.get('amount'))
    if not value:raise APIError('款项金额必须大于零')
    return value


def identifier(data,key):
    value=data.get(key)
    if not isinstance(value,str) or not settlements.ID.fullmatch(value):raise APIError('款项记录标识不正确')
    return value


def transaction(db,event,user,data,reporting=False):
    if not isinstance(data,dict):raise APIError('款项格式不正确')
    kind=data.get('kind')
    if not isinstance(kind,str) or kind not in KINDS:raise APIError('请选择款项类型')
    if reporting and kind not in ('collection','expense','deposit'):raise APIError('只能申报转账、个人垫付或个人支付的订金／押金',403)
    parties,owned,_=participants(db,event,user['id'])
    custom=data.get('custom_parties',[])
    if not isinstance(custom,list) or len(custom)>2:raise APIError('其他款项人员过多')
    if custom and reporting:raise APIError('其他款项人员由发起者核对建立',403)
    for p in custom:
        if not isinstance(p,dict) or not isinstance(p.get('id'),str) or not re.fullmatch(r'custom:[a-f0-9]{16}',p['id']) or p['id'] in parties:
            raise APIError('其他款项人员标识不正确或重复')
        name=string(p,'name',24);parties[p['id']]=dict(id=p['id'],name=name,label=name)
    for index,p in enumerate(parties.values(),1):
        p['label']=p['name']+('（账户 '+str(index)+'）' if sum(q['name']==p['name'] for q in parties.values())>1 else '')
    used=[]
    def party(key):
        value=data.get(key)
        if not isinstance(value,str) or not PARTY.fullmatch(value) or value not in parties:raise APIError('请选择本活动有效的款项人员')
        used.append(value);return value
    stamp=date_value(data,'occurred_at')
    if datetime.fromisoformat(stamp)>datetime.now(timezone.utc):raise APIError('实际款项时间不能在未来')
    result=dict(kind=kind,amount_cents=positive(data),occurred_at=stamp,note=string(data,'note',1000,False),reason=string(data,'reason',300,False))
    if kind in ('collection','refund','reimbursement'):
        result['payer_id']=party('payer_id')
        funding=data.get('funding','pool') if kind!='collection' else 'pool'
        if funding not in ('payer','pool'):raise APIError('请选择退还款项的资金来源')
        if kind!='collection':result['funding']=funding
        if funding=='payer':
            result['funder_id']=party('funder_id')
            if result['funder_id']==result['payer_id']:raise APIError('个人垫退／偿还的出资人与款项归属人员不能相同')
        else:result['custodian_id']=party('custodian_id')
        if data.get('actual_party_id') is not None and data.get('actual_party_id')!='':
            result['actual_party_id']=party('actual_party_id')
            if result['actual_party_id']!=result['payer_id'] and not result['reason']:raise APIError('实际转款／收款人与款项归属不同，请填写代付依据')
        else:result['actual_party_id']=result['payer_id']
    elif kind in ('expense','deposit','merchant_refund','deposit_return'):
        funding=data.get('funding')
        if funding not in ('payer','pool') or (reporting and funding!='payer'):raise APIError('请选择个人垫付或活动代收资金')
        result.update(funding=funding,**({'payer_id':party('payer_id')} if funding=='payer' else {'custodian_id':party('custodian_id')}))
        if kind in ('expense','deposit'):result['merchant']=string(data,'merchant',80)
    elif kind in ('credit_transfer','cash_transfer'):
        result.update(from_id=party('from_id'),to_id=party('to_id'))
        if result['from_id']==result['to_id']:raise APIError('转出与转入人员不能相同')
        if not result['reason']:raise APIError('移交资金或更正归属需填写原因')
    if kind in ('merchant_refund','deposit_return','deposit_apply'):
        reference_id=identifier(data,'reference_id')
        reference=db.execute('SELECT * FROM finance_entries WHERE event_id=? AND id=?',(event['id'],reference_id)).fetchone()
        expected=('expense','deposit_apply') if kind=='merchant_refund' else ('deposit',)
        if not reference or reference['kind'] not in expected:raise APIError('请选择本活动对应的店家支出或订金记录')
        result.update(reference_id=reference_id,merchant=json.loads(reference['payload_json'])['merchant'])
        if kind=='deposit_apply' and not result['reason']:raise APIError('订金抵消费或押金转损失需填写依据，并核对结算费用')
    if reporting and (not owned or result.get('payer_id') not in owned):raise APIError('只能申报本人或自己管理的未绑定同行款项',403)
    if custom and any(p['id'] not in used for p in custom):raise APIError('新款项人员必须用于本次记录')
    result['parties']=[parties[k] for k in dict.fromkeys(used)]
    result['method']=data.get('method','other')
    if not isinstance(result['method'],str) or result['method'] not in METHODS:raise APIError('请选择付款方式')
    return result


def blocked(s,pending):
    result=[]
    if not s['detailed']:result.append('先发布核对后的逐人结算；旧人均账单需明确转换')
    else:
        if s['outstanding_cents']:result.append('尚有待补款 ¥'+billing.money(s['outstanding_cents']))
        if s['refund_due_cents']:result.append('尚有应退／待偿还 ¥'+billing.money(s['refund_due_cents']))
        if s['cost_cents']!=s['total_due_cents']:result.append('已付店家净消费与结算总额尚未对平')
    if s['deposit_cents']:result.append('尚有未退回或未抵扣的订金／押金')
    if s['held_cents']:result.append('仍有活动代收资金未支出或退还')
    if pending:result.append('仍有待核对的款项申报')
    return result


def prepare(db,event,user,data):
    if event['lifecycle']=='draft':raise APIError('发布活动后才能登记款项',409)
    command=data.get('command');owner=user['id']==event['owner_id']
    if not isinstance(command,str):raise APIError('款项操作不正确')
    if command not in ('report','withdraw') and not owner:raise APIError('只有发起者可以确认或更正款项',403)
    entries=rows(db,event['id']);claims=reports(db,event['id']);s=summary(db,event,user['id'],entries,claims)
    result=dict(command=command)
    if command in ('record','report'):
        result['id']=identifier(data,'id')
        if db.execute('SELECT 1 FROM finance_entries WHERE id=? UNION ALL SELECT 1 FROM finance_reports WHERE id=?',(result['id'],result['id'])).fetchone():
            raise APIError('这笔记录已存在，请载入最新版核对',409)
        result['transaction']=transaction(db,event,user,data.get('transaction'),reporting=command=='report')
        if command=='report':
            if sum(not c['decision'] and c['reporter_id']==user['id'] for c in claims)>=20 or sum(not c['decision'] for c in claims)>=500:
                raise APIError('待核对申报过多，请先处理已有申报',409)
        else:
            candidate=dict(id=result['id'],seq=s['last_seq']+1,kind=result['transaction']['kind'],payload=result['transaction'],reversal_of=None)
            project(entries+[candidate])
    elif command in ('accept','reject','withdraw'):
        report_id=identifier(data,'report_id');claim=next((c for c in claims if c['id']==report_id),None)
        if not claim or (not owner and claim['reporter_id']!=user['id']):raise APIError('申报不存在或无权处理',404)
        if claim['decision']:raise APIError('这份申报已处理，请载入最新版',409)
        if command=='withdraw' and claim['reporter_id']!=user['id']:raise APIError('只能撤回自己未确认的申报',403)
        result.update(report_id=report_id,reason=string(data,'reason',300,command=='reject'))
        if command=='accept':
            result.update(id=report_id,transaction=claim['payload'])
            project(entries+[dict(id=report_id,seq=s['last_seq']+1,kind=claim['payload']['kind'],payload=claim['payload'],reversal_of=None)])
    elif command=='reverse':
        uid=identifier(data,'entry_id');original=next((e for e in entries if e['id']==uid),None)
        if not original or original['kind'] not in KINDS:raise APIError('只能冲销本活动已确认的款项',404)
        if uid in project(entries)['reversed_ids']:raise APIError('这笔款项已经冲销',409)
        result.update(entry_id=uid,reason=string(data,'reason',300))
        project(entries+[dict(id='preview-reversal',seq=s['last_seq']+1,kind='reversal',payload={},reversal_of=uid)])
    elif command=='close':
        if s['state']=='closed':raise APIError('账务已结清，无需重复操作',409)
        problems=blocked(s,sum(not c['decision'] for c in claims))
        if problems:raise APIError('；'.join(problems),409)
        result.update(bill_version=s['bill_version'],last_seq=s['last_seq'])
    elif command=='reopen':
        if s['state']!='closed':raise APIError('当前账务未结清，无需重新打开',409)
        result['reason']=string(data,'reason',300)
    else:raise APIError('款项操作不正确')
    return result


def token(event,command):
    return hashlib.sha256(json.dumps([event['id'],event['revision'],command],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def preview(db,event,user,data):
    command=prepare(db,event,user,data)
    entries=rows(db,event['id']);next_seq=entries[-1]['seq']+1 if entries else 1
    if command['command'] in ('record','accept'):
        candidate=dict(id=command['id'],seq=next_seq,kind=command['transaction']['kind'],payload=command['transaction'],reversal_of=None)
        entries=entries+[candidate]
    elif command['command']=='reverse':entries=entries+[dict(id='preview',seq=next_seq,kind='reversal',payload={},reversal_of=command['entry_id'])]
    state=project(entries)
    return dict(command=command,preview_token=token(event,command),projection={k:state[k] for k in ('cost_cents','held_cents','deposit_cents','credit')})


def append_entry(db,event,user,uid,kind,payload,source=None,reversal=None):
    db.execute('''INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at,source_report_id,reversal_of)
        VALUES(?,?,?,?,?,?,?,?,?,?)''',(uid,event['id'],kind,json.dumps(payload,ensure_ascii=False),payload.get('occurred_at',now()),
        user['id'],user['nickname'],now(),source,reversal))


def save(db,event,user,data):
    command=prepare(db,event,user,data)
    if data.get('preview_token')!=token(event,command):raise APIError('款项内容已有变动，请重新核对预览',409)
    before=summary(db,event,user['id']);action=command['command']
    if action=='report':
        db.execute('INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES(?,?,?,?,?,?)',
            (command['id'],event['id'],user['id'],user['nickname'],json.dumps(command['transaction'],ensure_ascii=False),now()))
    elif action in ('accept','reject','withdraw'):
        decision={'accept':'accepted','reject':'rejected','withdraw':'withdrawn'}[action]
        db.execute('''INSERT INTO finance_report_actions(event_id,report_id,decision,actor_id,actor_name,reason,created_at)
            VALUES(?,?,?,?,?,?,?)''',(event['id'],command['report_id'],decision,user['id'],user['nickname'],command['reason'],now()))
        if action=='accept':append_entry(db,event,user,command['id'],command['transaction']['kind'],command['transaction'],source=command['report_id'])
    elif action=='record':append_entry(db,event,user,command['id'],command['transaction']['kind'],command['transaction'])
    else:
        import secrets
        append_entry(db,event,user,secrets.token_hex(8),{'reverse':'reversal','close':'close','reopen':'reopen'}[action],command,reversal=command.get('entry_id'))
    after=summary(db,event,user['id'])
    private=action in ('report','reject','withdraw')
    audit_command={k:v for k,v in command.items() if k not in ('transaction','reason')} if private else command
    audit.append(db,event,user,'finance_'+action,dict(state=before['state']),dict(operation=audit_command,state=after['state']),
        '' if private else command.get('reason',command.get('transaction',{}).get('reason','')))
    recipients={event['owner_id']}
    _,_,users=participants(db,event,user['id'])
    for p in command.get('transaction',{}).get('parties',[]):
        if p['id'] in users:recipients.add(users[p['id']])
        elif p['id'].startswith('person:'):
            row=db.execute('SELECT manager_id FROM attendees WHERE event_id=? AND id=?',(event['id'],p['id'][7:])).fetchone()
            if row:recipients.add(row[0])
    if 'report_id' in command:
        recipients.add(db.execute('SELECT reporter_id FROM finance_reports WHERE id=?',(command['report_id'],)).fetchone()[0])
    for uid in recipients:
        if uid!=user['id']:audit.notify(db,uid,event['id'],'finance_updated',event['title']+' 的款项记录有更新，请查看收付款账本')
