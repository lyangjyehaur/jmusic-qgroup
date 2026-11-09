import concurrent.futures
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest import mock

import server
from qgroup_core import finance,storage
from test_roster import ModernClient


class FinanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'finance.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear();self.owner=ModernClient(self.base).identify('发起者')
        self.alice=ModernClient(self.base).identify('小林');self.bob=ModernClient(self.base).identify('小周')
        self.stranger=ModernClient(self.base).identify('路人')
        start=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
        status,self.event=self.owner.request('/api/events','POST',dict(title='收付款测试',category='约K',location='KTV',
            starts_at=start,deadline=start,duration_hours=3,capacity=0,description='',join_owner=False))
        self.assertEqual(status,201);self.url='/api/events/'+self.event['id']
        for client in (self.alice,self.bob):
            data=dict(people=[dict(is_self=True)],base_revision=self.fresh()['revision'])
            status,p=client.request(self.url+'/roster/preview','POST',data);self.assertEqual(status,200)
            self.assertEqual(client.request(self.url+'/roster/parties','POST',{**data,**p,'accept_partial':True})[0],200)
        self.context=self.owner.request(self.url+'/settlement/roster')[1]
        self.a,self.b=[p['payer_id'] for p in self.context['people']]
        self.c=self.view()['default_custodian_id']

    def fresh(self):return self.owner.request(self.url)[1]
    def view(self,client=None):return (client or self.owner).request(self.url+'/finance')[1]
    def stamp(self):return (datetime.now(timezone.utc)-timedelta(minutes=2)).isoformat()
    def tx(self,kind='collection',amount='100',**extra):
        return dict(kind=kind,amount=amount,payer_id=self.a,custodian_id=self.c,occurred_at=self.stamp(),method='wechat',note='',**extra)
    def body(self,command='record',**extra):return dict(command=command,base_revision=self.fresh()['revision'],**extra)
    def prepare(self,data,client=None):return (client or self.owner).request(self.url+'/finance/preview','POST',data)
    def commit(self,data,client=None,headers=None):
        status,p=self.prepare(data,client);self.assertEqual(status,200,p)
        return (client or self.owner).request(self.url+'/finance','POST',{**data,'preview_token':p['preview_token']},headers=headers)
    def post(self,transaction,client=None,command='record'):
        uid=uuid.uuid4().hex[:16];data=self.body(command,id=uid,transaction=transaction)
        status,e=self.commit(data,client);self.assertEqual(status,200,e)
        return uid
    def act(self,command,**extra):
        status,e=self.commit(self.body(command,**extra));self.assertEqual(status,200,e);return e
    def invoice(self,total='200'):
        e=self.fresh()
        if e['lifecycle']=='scheduled':
            status,e=self.owner.request(self.url,'PATCH',dict(action='finish',base_revision=e['revision']));self.assertEqual(status,200)
        ctx=self.owner.request(self.url+'/settlement/roster')[1]
        data=dict(base_revision=e['revision'],base_version=e['settlement']['version'] if e['settlement'] else 0,
            reviewed_roster=True,people=[dict(id=p['id'],share='1',reason='原约定确认',payments=[dict(payer_id=p['payer_id'],share='1')]) for p in ctx['people']],
            items=[dict(id=uuid.uuid4().hex[:16],name='包房',amount=total,mode='shares',scope='common',kind='expense',allocations=[],reason='')],
            reason='费用核对',note='')
        status,p=self.owner.request(self.url+'/settlement/preview','POST',data);self.assertEqual(status,200,p)
        status,e=self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':p['preview_token']});self.assertEqual(status,200,e)
        return e
    def balance(self,key):return next(p for p in self.view()['summary']['balances'] if p['id']==key)
    def expense(self,amount='200',funding='pool',**extra):
        return self.post(self.tx('expense',amount,funding=funding,merchant='星光KTV',**extra))

    def test_report_is_pending_until_owner_confirms_once(self):
        self.invoice();uid=self.post(self.tx(),self.alice,'report')
        self.assertEqual(self.view()['summary']['outstanding_cents'],20000)
        self.assertEqual(self.view()['summary']['pending_count'],1)
        self.assertEqual(self.view(self.bob)['reports'],[])
        self.assertEqual(self.view(self.alice)['reports'][0]['status'],'pending')
        self.act('accept',report_id=uid)
        self.assertEqual(self.balance(self.a)['balance_cents'],0)
        self.assertEqual(self.view()['summary']['held_cents'],10000)
        self.assertEqual(self.prepare(self.body('accept',report_id=uid))[0],409)
        self.assertEqual(len(self.view()['entries']),1)

    def test_partial_duplicate_actual_payment_overpay_and_refund(self):
        self.invoice();self.post(self.tx(amount='40'));self.assertEqual(self.balance(self.a)['balance_cents'],6000)
        self.post(self.tx(amount='70'));self.assertEqual(self.balance(self.a)['balance_cents'],-1000)
        self.post(self.tx('refund','10'));self.assertEqual(self.balance(self.a)['balance_cents'],0)
        self.assertEqual(self.view()['summary']['held_cents'],10000)

    def test_prepaid_changes_to_supplement_then_refund_without_rewriting_cash(self):
        self.post(self.tx());self.assertIsNone(self.balance(self.a)['due_cents'])
        self.invoice('240');self.assertEqual(self.balance(self.a)['balance_cents'],2000)
        self.invoice('160');self.assertEqual(self.balance(self.a)['balance_cents'],-2000)
        self.assertEqual(self.balance(self.a)['contributed_cents'],10000)
        self.post(self.tx('refund','20'));self.assertEqual(self.balance(self.a)['balance_cents'],0)

    def test_payer_advance_reimbursement_and_netting(self):
        self.invoice();self.expense(funding='payer')
        self.assertEqual(self.balance(self.a)['balance_cents'],-10000)
        tx=self.tx();tx['payer_id']=self.b;self.post(tx)
        self.post(self.tx('reimbursement','100'))
        s=self.view()['summary'];self.assertEqual((s['outstanding_cents'],s['refund_due_cents'],s['held_cents'],s['cost_cents']),(0,0,0,20000))
        self.act('close');self.assertEqual(self.view()['summary']['state'],'closed')

    def test_deposit_applied_to_final_invoice_once(self):
        deposit=self.post(self.tx('deposit','50',funding='payer',merchant='KTV'))
        self.assertEqual(self.view()['summary']['deposit_cents'],5000)
        self.assertEqual(self.view()['summary']['cost_cents'],0)
        self.post(self.tx('deposit_apply','50',reference_id=deposit,reason='订金已包含于最终200元账单'))
        self.expense('150',funding='payer')
        self.invoice();self.assertEqual(self.view()['summary']['cost_cents'],20000)
        self.assertEqual(self.balance(self.a)['contributed_cents'],20000)
        self.assertEqual(self.view()['summary']['deposit_cents'],0)

    def test_deposit_return_and_partial_cancellation_loss(self):
        deposit=self.post(self.tx('deposit','100',funding='payer',merchant='KTV'))
        self.post(self.tx('deposit_return','80',reference_id=deposit,funding='payer'))
        self.post(self.tx('deposit_apply','20',reference_id=deposit,reason='取消扣20元'))
        e=self.fresh();self.owner.request(self.url,'PATCH',dict(action='cancel',reason='临时取消',base_revision=e['revision']))
        self.invoice('20');self.assertEqual(self.balance(self.a)['balance_cents'],-1000)
        self.assertEqual(self.view()['summary']['cost_cents'],2000)
        self.assertEqual(self.view()['summary']['deposit_cents'],0)

    def test_merchant_refund_changes_funding_but_not_invoice(self):
        expense=self.expense(funding='payer');self.invoice()
        self.post(self.tx('merchant_refund','20',reference_id=expense,funding='payer'))
        self.assertEqual(self.view()['summary']['cost_cents'],18000)
        self.assertEqual(self.view()['summary']['total_due_cents'],20000)
        self.invoice('180');self.assertEqual(self.balance(self.a)['contributed_cents'],18000)

    def test_pool_deposit_return_and_cash_funding_conservation(self):
        self.post(self.tx());dep=self.post(self.tx('deposit','80',funding='pool',merchant='KTV'))
        self.assertEqual(self.view()['summary']['held_cents'],2000)
        self.post(self.tx('deposit_return','30',funding='pool',reference_id=dep))
        self.post(self.tx('deposit_apply','50',reference_id=dep,reason='抵付包房'))
        self.assertEqual((self.view()['summary']['held_cents'],self.view()['summary']['cost_cents']),(5000,5000))

    def test_cash_shortage_and_negative_payer_credit_rejected(self):
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=self.tx('refund','1')))[0],409)
        tx=self.tx('expense','1',funding='pool',merchant='KTV')
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],409)
        self.post(self.tx(amount='10'))
        tx=self.tx('refund','11');self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],409)

    def test_report_reject_withdraw_and_cannot_confirm_someone_else(self):
        uid=self.post(self.tx(),self.alice,'report')
        self.assertEqual(self.prepare(self.body('accept',report_id=uid),self.bob)[0],403)
        self.assertEqual(self.prepare(self.body('withdraw',report_id=uid),self.bob)[0],404)
        self.assertEqual(self.commit(self.body('withdraw',report_id=uid,reason='金额有误'),self.alice)[0],200)
        self.assertEqual(self.view(self.alice)['reports'][0]['status'],'withdrawn')
        uid=self.post(self.tx(),self.alice,'report')
        self.assertEqual(self.prepare(self.body('reject',report_id=uid,reason=''))[0],400)
        self.act('reject',report_id=uid,reason='尚未收到，请核对')
        self.assertEqual(self.view()['summary']['held_cents'],0)
        self.assertEqual(self.view(self.alice)['reports'][0]['status'],'rejected')

    def test_report_only_authorized_party_and_unbound_managed_person(self):
        self.assertEqual(self.prepare(self.body('report',id=uuid.uuid4().hex[:16],transaction=self.tx()),self.bob)[0],403)
        self.assertEqual(self.prepare(self.body('report',id=uuid.uuid4().hex[:16],transaction=self.tx()),self.stranger)[0],403)
        data=dict(people=[dict(name='同行',payer_kind='self')],base_revision=self.fresh()['revision'])
        p=self.alice.request(self.url+'/roster/preview','POST',data)[1]
        self.assertEqual(self.alice.request(self.url+'/roster/parties','POST',{**data,**p,'accept_partial':True})[0],200)
        owned=self.view(self.alice)['reportable_ids'];person=next(k for k in owned if k.startswith('person:'))
        tx=self.tx();tx['payer_id']=person;uid=self.post(tx,self.alice,'report');self.act('accept',report_id=uid)
        self.assertEqual(self.balance(person)['contributed_cents'],10000)

    def test_advance_claim_is_not_confirmed_spending(self):
        uid=self.post(self.tx('expense','200',funding='payer',merchant='KTV'),self.alice,'report')
        self.assertEqual(self.view()['summary']['cost_cents'],0)
        self.act('accept',report_id=uid);self.assertEqual(self.view()['summary']['cost_cents'],20000)

    def test_reversal_keeps_original_and_dependency_order(self):
        receipt=self.post(self.tx());spend=self.expense('100')
        self.assertEqual(self.prepare(self.body('reverse',entry_id=receipt,reason='错记'))[0],409)
        self.act('reverse',entry_id=spend,reason='金额录错，重新登记')
        self.act('reverse',entry_id=receipt,reason='收款归属错误')
        v=self.view();self.assertEqual(len(v['entries']),4)
        self.assertTrue(next(e for e in v['entries'] if e['id']==receipt)['reversed'])
        self.assertEqual(v['summary']['held_cents'],0)
        self.assertEqual(self.prepare(self.body('reverse',entry_id=receipt,reason='重复'))[0],409)

    def test_deposit_and_expense_reference_dependencies_cannot_be_erased(self):
        dep=self.post(self.tx('deposit','50',funding='payer',merchant='KTV'))
        apply=self.post(self.tx('deposit_apply','50',reference_id=dep,reason='抵扣消费'))
        refund=self.post(self.tx('merchant_refund','10',reference_id=apply,funding='payer'))
        self.assertEqual(self.prepare(self.body('reverse',entry_id=dep,reason='错记'))[0],409)
        self.assertEqual(self.prepare(self.body('reverse',entry_id=apply,reason='错记'))[0],409)
        self.act('reverse',entry_id=refund,reason='退差价错误')
        self.act('reverse',entry_id=apply,reason='抵扣错误')
        self.assertEqual(self.view()['summary']['deposit_cents'],5000)

    def test_reference_cannot_over_return_or_cross_events(self):
        dep=self.post(self.tx('deposit','50',funding='payer',merchant='KTV'))
        tx=self.tx('deposit_return','51',reference_id=dep,funding='payer')
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],409)
        tx['reference_id']='0'*16;self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],400)

    def test_payer_change_preserves_credit_and_requires_explicit_allocation(self):
        self.invoice();self.post(self.tx());self.expense('100')
        self.post(self.tx('credit_transfer','100',from_id=self.a,to_id=self.b,reason='核对后实际替小周支付'))
        self.assertEqual(self.balance(self.a)['balance_cents'],10000);self.assertEqual(self.balance(self.b)['balance_cents'],0)
        self.assertEqual(self.view()['summary']['cost_cents'],10000)

    def test_cash_transfer_does_not_change_payer_credit(self):
        self.post(self.tx())
        tx=self.tx('cash_transfer','100',from_id=self.c,to_id=self.b,reason='移交现场代收资金');self.post(tx)
        s=self.view()['summary'];self.assertEqual(self.balance(self.a)['contributed_cents'],10000)
        self.assertEqual({p['id']:p['held_cents'] for p in s['custodians']},{self.c:0,self.b:10000})

    def test_close_requires_invoice_all_cash_and_deposits_reconciled(self):
        self.assertEqual(self.prepare(self.body('close'))[0],409)
        self.invoice();self.post(self.tx());tx=self.tx();tx['payer_id']=self.b;self.post(tx)
        self.assertEqual(self.prepare(self.body('close'))[0],409)
        self.expense();self.act('close');self.assertEqual(self.view()['summary']['state'],'closed')
        self.assertEqual(self.prepare(self.body('close'))[0],409)

    def test_close_blocked_by_pending_claim_and_change_reopens(self):
        self.invoice();self.post(self.tx());tx=self.tx();tx['payer_id']=self.b;self.post(tx);self.expense()
        uid=self.post(self.tx(amount='1'),self.alice,'report')
        self.assertEqual(self.prepare(self.body('close'))[0],409)
        self.act('reject',report_id=uid,reason='重复申报，无实际第二笔付款');self.act('close')
        self.invoice('240');self.assertEqual(self.view()['summary']['state'],'collecting')
        self.assertEqual(self.balance(self.a)['balance_cents'],2000)
        self.assertEqual(self.view()['summary']['outstanding_cents'],4000)

    def test_explicit_reopen_requires_reason_and_retains_checkpoint(self):
        self.invoice('0');self.act('close')
        self.assertEqual(self.prepare(self.body('reopen',reason=''))[0],400)
        self.act('reopen',reason='核对遗漏饮料');self.assertEqual(self.view()['summary']['state'],'collecting')
        self.assertEqual([e['kind'] for e in self.view()['entries']],['reopen','close'])

    def test_stale_and_changed_preview_rejected_and_retry_atomic(self):
        data=self.body(id=uuid.uuid4().hex[:16],transaction=self.tx());status,p=self.prepare(data);self.assertEqual(status,200)
        changed=copy.deepcopy(data);changed['transaction']['amount']='101'
        self.assertEqual(self.owner.request(self.url+'/finance','POST',{**changed,'preview_token':p['preview_token']})[0],409)
        key=uuid.uuid4().hex;body={**data,'preview_token':p['preview_token']};headers={'Idempotency-Key':key}
        self.assertEqual(self.owner.request(self.url+'/finance','POST',body,headers)[0],200)
        self.assertEqual(self.owner.request(self.url+'/finance','POST',body,headers)[0],200)
        self.assertEqual(len(self.view()['entries']),1)
        self.assertEqual(self.owner.request(self.url+'/finance','POST',body)[0],409)

    def test_concurrent_report_confirmation_only_once(self):
        uid=self.post(self.tx(),self.alice,'report');data=self.body('accept',report_id=uid)
        p=self.prepare(data)[1];body={**data,'preview_token':p['preview_token']}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.owner.request(self.url+'/finance','POST',body),range(2)))
        self.assertEqual(sorted(s for s,_ in results),[200,409]);self.assertEqual(len(self.view()['entries']),1)

    def test_failed_audit_rolls_back_confirmation_and_money(self):
        uid=self.post(self.tx(),self.alice,'report');data=self.body('accept',report_id=uid);p=self.prepare(data)[1]
        with mock.patch.object(server.audit,'append',side_effect=sqlite3.IntegrityError('injected')):
            with self.assertLogs(level='ERROR'):
                self.assertEqual(self.owner.request(self.url+'/finance','POST',{**data,'preview_token':p['preview_token']})[0],500)
        self.assertEqual(self.view()['entries'],[]);self.assertEqual(self.view()['reports'][0]['status'],'pending')
        self.act('accept',report_id=uid);self.assertEqual(len(self.view()['entries']),1)

    def test_append_only_reports_decisions_and_cash_even_in_backup(self):
        uid=self.post(self.tx(),self.alice,'report');self.act('accept',report_id=uid)
        with sqlite3.connect(server.DB) as db,sqlite3.connect(':memory:') as backup:
            db.backup(backup)
            for table in ('finance_entries','finance_reports','finance_report_actions'):
                self.assertEqual(backup.execute('SELECT COUNT(*) FROM '+table+' WHERE event_id=?',(self.event['id'],)).fetchone()[0],1)
                for sql in ('DELETE FROM '+table+' WHERE event_id=?','UPDATE '+table+' SET event_id=event_id WHERE event_id=?'):
                    with self.assertRaises(sqlite3.IntegrityError):db.execute(sql,(self.event['id'],))

    def test_invalid_money_types_dates_methods_and_missing_protocol(self):
        for value in ('-1','0','1.001','1e2',True,1,[],None):
            tx=self.tx();tx['amount']=value
            self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],400)
        for field,value in [('kind',[]),('method',{}),('payer_id',True),('custodian_id','account:'+'0'*16),('occurred_at','2099-01-01T00:00:00Z')]:
            tx=self.tx();tx[field]=value
            self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],400)
        data=self.body(id=uuid.uuid4().hex[:16],transaction=self.tx())
        self.assertEqual(self.owner.request(self.url+'/finance/preview','POST',data,{'Idempotency-Key':''})[0],400)
        self.assertEqual(self.owner.request(self.url+'/finance/preview','POST',data,{'X-Kanban-Version':''})[0],409)

    def test_custom_parties_same_names_not_merged_and_frozen(self):
        key='custom:'+uuid.uuid4().hex[:16];tx=self.tx();tx.update(payer_id=key,custom_parties=[dict(id=key,name='小林')])
        uid=self.post(tx);v=self.view();self.assertEqual(len([p for p in v['parties'] if p['name']=='小林']),2)
        self.assertEqual(self.balance(key)['contributed_cents'],10000)
        self.alice.request('/api/profile','POST',dict(nickname='新名字'))
        payload=next(e for e in self.view()['entries'] if e['id']==uid)['payload']
        self.assertEqual(next(p for p in payload['parties'] if p['id']==key)['name'],'小林')

    def test_actual_remitter_independent_of_credited_payer(self):
        self.invoice();tx=self.tx();tx['actual_party_id']=self.b
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=tx))[0],400)
        tx['reason']='小周实际代小林转账';uid=self.post(tx)
        self.assertEqual(self.balance(self.a)['balance_cents'],0)
        self.assertEqual(self.balance(self.b)['balance_cents'],10000)
        p=next(e['payload'] for e in self.view()['entries'] if e['id']==uid)
        self.assertEqual((p['payer_id'],p['actual_party_id']),(self.a,self.b))

    def test_personal_funds_can_advance_refund_without_pool_cash(self):
        self.expense('200',funding='payer');self.invoice('200')
        tx=self.tx('reimbursement','100',funding='payer',funder_id=self.b)
        self.post(tx)
        self.assertEqual(self.balance(self.a)['balance_cents'],0)
        self.assertEqual(self.balance(self.b)['balance_cents'],0)
        self.assertEqual(self.view()['summary']['held_cents'],0)
        self.act('close')

    def test_own_summary_excludes_managed_unbound_payer(self):
        data=dict(people=[dict(name='同行',payer_kind='self')],base_revision=self.fresh()['revision'])
        p=self.alice.request(self.url+'/roster/preview','POST',data)[1]
        self.alice.request(self.url+'/roster/parties','POST',{**data,**p,'accept_partial':True})
        self.invoice('300');s=self.view(self.alice)['summary']
        self.assertEqual(s['my_outstanding_cents'],10000)
        self.assertEqual(len(self.view(self.alice)['reportable_ids']),2)

    def test_removed_invoice_payer_keeps_confirmed_credit(self):
        self.invoice();self.post(self.tx())
        e=self.fresh();input=copy.deepcopy(e['settlement']['detail']['input'])
        for p in input['people']:p.update(payments=[dict(payer_id=self.b,share='1')],reason='改由小周统一付款，原款项另行处理')
        data=dict(input,base_revision=e['revision'],base_version=e['settlement']['version'],reviewed_roster=True,reason='重新核对付款归属')
        status,p=self.owner.request(self.url+'/settlement/preview','POST',data);self.assertEqual(status,200,p)
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',dict(data,preview_token=p['preview_token']))[0],200)
        self.assertEqual(self.balance(self.a)['balance_cents'],-10000)
        self.assertEqual(self.balance(self.b)['balance_cents'],20000)

    def test_unregistered_prepayer_can_use_same_id_in_final_liability(self):
        key='custom:'+uuid.uuid4().hex[:16];tx=self.tx(amount='200')
        tx.update(payer_id=key,custom_parties=[dict(id=key,name='赞助朋友')]);self.post(tx)
        e=self.invoice();input=copy.deepcopy(e['settlement']['detail']['input'])
        input['custom_payers']=[dict(id=key,name='赞助朋友')]
        for person in input['people']:person.update(payments=[dict(payer_id=key,share='1')],reason='核对由同一位朋友承担')
        data=dict(input,base_revision=e['revision'],base_version=e['settlement']['version'],reviewed_roster=True,reason='核对预收款归属')
        status,p=self.owner.request(self.url+'/settlement/preview','POST',data);self.assertEqual(status,200,p)
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',dict(data,preview_token=p['preview_token']))[0],200)
        self.assertEqual(self.balance(key)['balance_cents'],0)

    def test_reversed_accepted_claim_displays_its_reversal(self):
        uid=self.post(self.tx(),self.alice,'report');self.act('accept',report_id=uid)
        self.act('reverse',entry_id=uid,reason='重复收款记录，实际只有另一笔')
        report=self.view(self.alice)['reports'][0]
        self.assertEqual(report['status'],'accepted');self.assertTrue(report['entry_reversed'])
        self.assertEqual(self.view()['summary']['held_cents'],0)

    def test_foreign_event_reference_cannot_be_used(self):
        dep=self.post(self.tx('deposit','50',funding='payer',merchant='KTV'))
        _,e=self.owner.request('/api/events','POST',{**self.fresh(),'join_owner':False})
        other_url='/api/events/'+e['id']
        c=self.owner.request(other_url+'/finance')[1]['default_custodian_id']
        tx=self.tx('deposit_return','10',reference_id=dep,funding='pool');tx['custodian_id']=c
        data=dict(command='record',id=uuid.uuid4().hex[:16],base_revision=e['revision'],transaction=tx)
        self.assertEqual(self.owner.request(other_url+'/finance/preview','POST',data)[0],400)

    def test_public_pending_report_notes_not_leaked_via_activity_history(self):
        tx=self.tx();tx['note']='待确认申报的专用备注';tx['reason']='申报的私有依据';uid=self.post(tx,self.alice,'report')
        self.assertNotIn(tx['note'],json.dumps(self.view(self.stranger),ensure_ascii=False))
        history=self.stranger.request(self.url+'/history')[1]
        self.assertNotIn(tx['note'],json.dumps(history,ensure_ascii=False))
        self.assertNotIn(tx['reason'],json.dumps(history,ensure_ascii=False))
        self.act('reject',report_id=uid,reason='仅申报者与发起者查看的核对说明')
        self.assertNotIn('仅申报者与发起者查看的核对说明',json.dumps(self.stranger.request(self.url+'/history')[1],ensure_ascii=False))

    def test_invitation_permissions_finance_and_after_archive(self):
        with sqlite3.connect(server.DB) as db:db.execute("UPDATE events SET visibility='invitation' WHERE id=?",(self.event['id'],))
        self.assertEqual(self.stranger.request(self.url+'/finance')[0],404)
        self.invoice('0');self.owner.request(self.url,'PATCH',dict(action='archive',base_revision=self.fresh()['revision']))
        self.act('close');self.act('reopen',reason='归档后核对')

    def test_cohost_cannot_confirm_and_transfer_does_not_move_cash(self):
        self.post(self.tx())
        with server.connect() as db:
            owner=db.execute('SELECT user_id FROM attendees WHERE event_id=? AND id=?',(self.event['id'],self.context['people'][1]['id'])).fetchone()[0]
            db.execute('INSERT INTO event_roles VALUES(?,?,?,?,?)',(uuid.uuid4().hex[:16],self.event['id'],owner,'["schedule","roster","attendance"]',self.stamp()))
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=self.tx()),self.bob)[0],403)
        with server.connect() as db:db.execute('UPDATE events SET owner_id=? WHERE id=?',(owner,self.event['id']))
        self.assertEqual(self.prepare(self.body(id=uuid.uuid4().hex[:16],transaction=self.tx()))[0],403)
        v=self.view(self.bob);self.assertEqual(v['default_custodian_id'],self.b)
        self.assertEqual({p['id']:p['held_cents'] for p in v['summary']['custodians']},{self.c:10000})

    def test_pagination_and_no_internal_account_ids(self):
        self.post(self.tx());v=self.view(self.stranger)
        self.assertNotIn('reporter_id',json.dumps(v));self.assertNotIn('actor_id',json.dumps(v))
        self.assertEqual(self.owner.request(self.url+'/finance?before=0')[0],400)
        first=v['entries'][0]['seq'];self.assertEqual(self.owner.request(self.url+'/finance?before='+str(first))[1]['entries'],[])

    def test_complete_report_and_entry_history_paginates_without_losing_rows(self):
        with server.connect() as db:
            e=db.execute('SELECT * FROM events WHERE id=?',(self.event['id'],)).fetchone()
            owner=db.execute('SELECT * FROM users WHERE id=?',(e['owner_id'],)).fetchone()
            alice_id=db.execute('SELECT user_id FROM attendees WHERE id=?',(self.context['people'][0]['id'],)).fetchone()[0]
            alice=db.execute('SELECT * FROM users WHERE id=?',(alice_id,)).fetchone()
            payload=finance.transaction(db,e,alice,self.tx(amount='1'),reporting=True)
            for index in range(105):
                uid=uuid.uuid4().hex[:16]
                db.execute('INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES(?,?,?,?,?,?)',
                    (uid,e['id'],alice_id,alice['nickname'],json.dumps(payload),self.stamp()))
                db.execute('INSERT INTO finance_report_actions(event_id,report_id,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,?,?,?,?)',
                    (e['id'],uid,'rejected',owner['id'],owner['nickname'],'测试核对说明',self.stamp()))
                finance.append_entry(db,e,owner,uuid.uuid4().hex[:16],'collection',payload)
        first=self.view(self.alice)
        second=self.alice.request(self.url+'/finance?before='+str(first['next_before'])+'&before_report='+str(first['next_report_before']))[1]
        self.assertEqual((len(first['reports']),len(second['reports'])),(100,5))
        self.assertEqual((len(first['entries']),len(second['entries'])),(100,5))
        self.assertEqual(len({r['id'] for r in first['reports']+second['reports']}),105)
        self.assertEqual(len({r['id'] for r in first['entries']+second['entries']}),105)
        self.assertEqual(self.view(self.stranger)['reports'],[])

    def test_refund_retry_cannot_double_return_confirmed_credit(self):
        self.post(self.tx())
        data=self.body(id=uuid.uuid4().hex[:16],transaction=self.tx('refund','30'))
        p=self.prepare(data)[1];data['preview_token']=p['preview_token'];headers={'Idempotency-Key':uuid.uuid4().hex}
        self.assertEqual(self.owner.request(self.url+'/finance','POST',data,headers)[0],200)
        self.assertEqual(self.owner.request(self.url+'/finance','POST',data,headers)[0],200)
        self.assertEqual(self.balance(self.a)['contributed_cents'],7000)
        self.assertEqual(len(self.view()['entries']),2)


    def test_cancel_with_prepay_deposit_loss_and_return_closes_balanced(self):
        self.post(self.tx(amount='100'));self.post({**self.tx(amount='100'),'payer_id':self.b})
        deposit=self.post(self.tx('deposit','100',funding='pool',merchant='KTV'))
        self.post(self.tx('deposit_return','80',reference_id=deposit,funding='pool'))
        self.post(self.tx('deposit_apply','20',reference_id=deposit,reason='临时取消的已约定损失'))
        status,e=self.owner.request(self.url,'PATCH',dict(action='cancel',reason='临时停业',base_revision=self.fresh()['revision']));self.assertEqual(status,200,e)
        self.invoice('20');self.post(self.tx('refund','90'));self.post({**self.tx('refund','90'),'payer_id':self.b})
        self.act('close');summary=self.view()['summary']
        self.assertEqual(summary['state'],'closed');self.assertEqual(summary['cost_cents'],2000)
        for field in ('held_cents','deposit_cents','outstanding_cents','refund_due_cents'):self.assertEqual(summary[field],0)

    def test_archived_closed_invoice_correction_retains_history_and_reconciles(self):
        self.invoice('200');self.post(self.tx());self.post({**self.tx(),'payer_id':self.b});self.expense();self.act('close')
        self.assertEqual(self.owner.request(self.url,'PATCH',dict(action='archive',base_revision=self.fresh()['revision']))[0],200)
        with sqlite3.connect(server.DB) as db:
            frozen=[tuple(r) for r in db.execute('SELECT * FROM settlement_history WHERE event_id=?',(self.event['id'],))]
        self.invoice('240');self.assertEqual(self.view()['summary']['state'],'collecting')
        self.assertEqual(self.view()['summary']['outstanding_cents'],4000)
        self.post(self.tx(amount='20'));self.post({**self.tx(amount='20'),'payer_id':self.b});self.expense('40');self.act('close')
        self.assertEqual(self.view()['summary']['state'],'closed');self.assertTrue(self.fresh()['archived_at'])
        with sqlite3.connect(server.DB) as db:
            all_versions=[tuple(r) for r in db.execute('SELECT * FROM settlement_history WHERE event_id=? ORDER BY version',(self.event['id'],))]
        self.assertEqual(all_versions[:len(frozen)],frozen);self.assertEqual(len(all_versions),2)


class FinanceMigrationTests(unittest.TestCase):
    def test_p3_preserved_repeated_v4_and_failure_rollback(self):
        from deploy.verify_migration import verify
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'p3.sqlite3'
            with mock.patch.object(storage,'migrate_finance',lambda db:None):storage.initialize(path)
            with sqlite3.connect(path) as db:before=db.execute('SELECT * FROM schema_migrations').fetchall()
            original=storage.migrate_finance
            def fail(db):original(db);raise RuntimeError('injected')
            with mock.patch.object(storage,'migrate_finance',fail):
                with self.assertRaises(RuntimeError):storage.initialize(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT * FROM schema_migrations').fetchall(),before)
                self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='finance_entries'").fetchone())
            verify(path,Path(folder)/'upgraded.sqlite3')
            storage.initialize(path);storage.initialize(path)
            with sqlite3.connect(path) as db:self.assertEqual(db.execute('SELECT version FROM schema_migrations').fetchall(),[(1,),(2,),(3,),(4,),(5,),(6,),(7,),(8,),(9,)])

