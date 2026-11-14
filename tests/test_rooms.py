"""Room plans, exact AA, atomic advances and independent cash reconciliation."""
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import server
from qgroup_core import bot_outbox, storage
from test_roster import ModernClient


class RoomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'rooms.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear();self.owner=ModernClient(self.base).identify('发起者')
        self.clients=[ModernClient(self.base).identify(n) for n in ('甲','乙','丙','丁')]
        stamp=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
        status,e=self.owner.request('/api/events','POST',dict(title='分包测试',category='约K',location='KTV',starts_at=stamp,deadline=stamp,capacity=0,duration_hours=3,description='',join_owner=False))
        self.assertEqual(status,201,e);self.url='/api/events/'+e['id'];self.event_id=e['id']
        for client in self.clients:
            body=dict(people=[dict(is_self=True)],base_revision=self.fresh()['revision'])
            status,p=client.request(self.url+'/roster/preview','POST',body);self.assertEqual(status,200,p)
            status,p=client.request(self.url+'/roster/parties','POST',{**body,**p,'accept_partial':True});self.assertEqual(status,200,p)
        self.ctx=self.owner.request(self.url+'/settlement/roster')[1];self.people=self.ctx['people']
        self.keys=[p['payer_id'] for p in self.people]
        self.rooms=[dict(id=uuid.uuid4().hex[:16],name=name,payer_id=self.keys[i*2],person_ids=[p['id'] for p in self.people[i*2:i*2+2]]) for i,name in enumerate(('牡丹厅','兰花厅'))]

    def fresh(self,client=None):return (client or self.owner).request(self.url)[1]
    def stamp(self):return (datetime.now(timezone.utc)-timedelta(minutes=2)).isoformat()
    def plan(self,rooms=None,client=None,headers=None,revision=None):
        return (client or self.owner).request(self.url+'/rooms','PUT',dict(rooms=self.rooms if rooms is None else rooms,base_revision=self.fresh()['revision'] if revision is None else revision),headers=headers)
    def finish(self):
        status,e=self.owner.request(self.url,'PATCH',dict(action='finish',base_revision=self.fresh()['revision']));self.assertEqual(status,200,e)
    def data(self,paid=True,single=False):
        e=self.fresh()
        return dict(base_revision=e['revision'],base_version=e['settlement']['version'] if e['settlement'] else 0,reviewed_roster=True,
            rooms=[dict(r,amount=value,merchant_mode='paid' if paid else 'unpaid',payer_id=self.keys[0] if single else r['payer_id']) for r,value in zip(self.rooms,('120','200'))],
            room_payment_details=dict(occurred_at=self.stamp(),method='wechat'),
            people=[dict(id=p['id'],share='1',reason='',payments=[dict(payer_id=p['payer_id'],share='1')]) for p in self.people],items=[],reason='按实际包间核对',note='')
    def preview(self,data):return self.owner.request(self.url+'/settlement/preview','POST',data)
    def publish(self,data,headers=None):
        status,p=self.preview(data);self.assertEqual(status,200,p)
        status,e=self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':p['preview_token']},headers=headers);self.assertEqual(status,200,e);return e
    def record(self,room,**tx):
        body=dict(command='record',id=uuid.uuid4().hex[:16],base_revision=self.fresh()['revision'],transaction=dict(room_id=room,occurred_at=self.stamp(),method='wechat',**tx))
        status,p=self.owner.request(self.url+'/finance/preview','POST',body);self.assertEqual(status,200,p)
        status,e=self.owner.request(self.url+'/finance','POST',{**body,'preview_token':p['preview_token']});self.assertEqual(status,200,e);return e
    def view(self,client=None):return (client or self.owner).request(self.url+'/finance')[1]

    def test_plan_partial_assignments_names_and_idempotency(self):
        partial=copy.deepcopy(self.rooms);partial[1]['person_ids']=[];headers={'Idempotency-Key':uuid.uuid4().hex}
        status,e=self.plan(partial,headers=headers);self.assertEqual(status,200,e)
        status,replay=self.plan(partial,headers=headers,revision=e['revision']-1);self.assertEqual(status,200,replay)
        self.assertEqual(e['revision'],replay['revision']);self.assertEqual(len(e['room_plan'][1]['person_ids']),0)
        self.assertFalse(e['finance']['has_records'])
        self.assertEqual(self.fresh(self.clients[0])['room_plan'][0]['name'],'牡丹厅')

    def test_owner_only_and_revision_conflict(self):
        self.assertEqual(self.plan(client=self.clients[0])[0],403)
        rev=self.fresh()['revision'];self.assertEqual(self.plan()[0],200)
        self.assertEqual(self.plan(revision=rev)[0],409)
        self.assertFalse(self.fresh(self.clients[0])['can_manage_rooms'])

    def test_duplicate_foreign_and_unassigned_members_rejected(self):
        data=copy.deepcopy(self.rooms);data[1]['person_ids'].append(data[0]['person_ids'][0]);self.assertEqual(self.plan(data)[0],400)
        data=copy.deepcopy(self.rooms);data[0]['person_ids']=['f'*16];self.assertEqual(self.plan(data)[0],400)
        data=copy.deepcopy(self.rooms);data[1]['name']=data[0]['name'];self.assertEqual(self.plan(data)[0],400)
        self.finish();data=self.data(False);data['rooms'][1]['person_ids'].pop();self.assertEqual(self.preview(data)[0],400)

    def test_single_payer_keeps_room_prices_and_everyones_own_liability(self):
        self.assertEqual(self.plan()[0],200);self.finish();e=self.publish(self.data(single=True));d=e['settlement']['detail']
        self.assertEqual([p['due_cents'] for p in d['people']],[6000,6000,10000,10000])
        self.assertEqual([sum(t['amount_cents'] for t in r['transfers']) for r in d['room_balances']],[6000,20000])
        self.assertTrue(all(t['to_id']==self.keys[0] for r in d['room_balances'] for t in r['transfers']))
        self.assertEqual(self.view(self.clients[0])['summary']['my_refund_due_cents'],26000)
        self.assertEqual([p['amount_cents'] for p in d['payers']],[6000,6000,10000,10000])
        self.assertNotIn('collector',d)

    def test_separate_payers_receive_only_their_room_and_can_close(self):
        self.finish();e=self.publish(self.data());d=e['settlement']['detail']
        self.assertEqual([r['transfers'][0]['to_id'] for r in d['room_balances']],[self.keys[0],self.keys[2]])
        for r,debtor,creditor,amount in zip(self.rooms,(self.keys[1],self.keys[3]),(self.keys[0],self.keys[2]),('60','100')):
            self.record(r['id'],kind='collection',amount=amount,payer_id=debtor,custodian_id=creditor)
            self.record(r['id'],kind='reimbursement',amount=amount,payer_id=creditor,custodian_id=creditor,funding='pool')
        view=self.view();self.assertEqual(view['close_blockers'],[])
        self.assertTrue(all(not r['transfers'] for r in view['summary']['room_balances']))
        body=dict(command='close',base_revision=self.fresh()['revision'])
        status,p=self.owner.request(self.url+'/finance/preview','POST',body);self.assertEqual(status,200,p)
        status,e=self.owner.request(self.url+'/finance','POST',{**body,'preview_token':p['preview_token']});self.assertEqual(status,200,e)
        self.assertEqual(e['finance']['state'],'closed')

    def test_designation_does_not_create_a_payment(self):
        self.plan();self.finish();e=self.publish(self.data(False))
        self.assertFalse(e['finance']['has_records']);self.assertEqual(e['finance']['cost_cents'],0)
        self.assertEqual(self.view()['summary']['refund_due_cents'],0)

    def test_managing_guests_does_not_make_their_dues_my_own(self):
        body=dict(people=[dict(name='同行',payer_kind='self')],base_revision=self.fresh()['revision'])
        status,p=self.clients[0].request(self.url+'/roster/preview','POST',body);self.assertEqual(status,200,p)
        status,e=self.clients[0].request(self.url+'/roster/parties','POST',{**body,**p,'accept_partial':True});self.assertEqual(status,200,e)
        self.ctx=self.owner.request(self.url+'/settlement/roster')[1];self.people=self.ctx['people']
        self.rooms[0]['person_ids'].append(self.people[-1]['id'])
        self.finish();self.publish(self.data())
        summary=self.view(self.clients[0])['summary']
        self.assertEqual(summary['my_outstanding_cents'],0)
        self.assertEqual(summary['my_refund_due_cents'],8000)

    def test_failure_on_second_advance_rolls_back_bill_and_first_advance(self):
        self.finish();data=self.data();status,p=self.preview(data);self.assertEqual(status,200,p)
        with storage.connect(server.DB) as db:
            db.execute("CREATE TRIGGER reject_room_advance BEFORE INSERT ON finance_entries WHEN NEW.event_id='"+self.event_id+"' AND json_extract(NEW.payload_json,'$.room_id')='"+self.rooms[1]['id']+"' BEGIN SELECT RAISE(ABORT,'injected room failure'); END")
        try:
            status,e=self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':p['preview_token']})
            self.assertEqual(status,500,e)
            self.assertIsNone(self.fresh()['settlement']);self.assertFalse(self.fresh()['finance']['has_records'])
            with storage.connect(server.DB) as db:
                for table in ('settlement_history','settlement_details','finance_entries'):
                    self.assertEqual(db.execute('SELECT count(*) FROM '+table+' WHERE event_id=?',(self.event_id,)).fetchone()[0],0)
        finally:
            with storage.connect(server.DB) as db:db.execute('DROP TRIGGER reject_room_advance')

    def test_concurrent_money_change_invalidates_preview(self):
        self.plan();self.finish();data=self.data(False);status,p=self.preview(data);self.assertEqual(status,200,p)
        self.record(self.rooms[0]['id'],kind='expense',amount='10',funding='payer',payer_id=self.keys[0],merchant='KTV')
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':p['preview_token']})[0],409)

    def test_old_unscoped_cash_cannot_silently_disappear_from_room_reconciliation(self):
        self.record(None,kind='expense',amount='10',funding='payer',payer_id=self.keys[0],merchant='KTV')
        self.plan();self.finish();self.assertEqual(self.preview(self.data(False))[0],409)

    def test_old_unscoped_claim_cannot_be_confirmed_into_a_room_bill(self):
        client=self.clients[1];uid=uuid.uuid4().hex[:16]
        body=dict(command='report',id=uid,base_revision=self.fresh()['revision'],transaction=dict(kind='collection',amount='10',
            payer_id=self.keys[1],custodian_id=self.keys[0],occurred_at=self.stamp(),method='wechat'))
        status,p=client.request(self.url+'/finance/preview','POST',body);self.assertEqual(status,200,p)
        status,e=client.request(self.url+'/finance','POST',{**body,'preview_token':p['preview_token']});self.assertEqual(status,200,e)
        self.plan();self.finish();self.publish(self.data())
        status,p=self.owner.request(self.url+'/finance/preview','POST',dict(command='accept',report_id=uid,base_revision=self.fresh()['revision']))
        self.assertEqual(status,409,p)

    def test_half_aa_exemption_and_designated_payer_has_no_management_rights(self):
        self.finish();data=self.data();data['people'][0].update(share='0.5',reason='原约定半 A')
        e=self.publish(data);self.assertEqual([p['due_cents'] for p in e['settlement']['detail']['people'][:2]],[4000,8000])
        payer_view=self.fresh(self.clients[0]);self.assertFalse(payer_view['can_settle']);self.assertFalse(payer_view['finance']['can_manage'])

    def test_advance_publish_is_atomic_idempotent_and_preview_is_read_only(self):
        self.finish();data=self.data();status,p=self.preview(data);self.assertEqual(status,200,p)
        self.assertFalse(self.fresh()['finance']['has_records']);headers={'Idempotency-Key':uuid.uuid4().hex};body={**data,'preview_token':p['preview_token']}
        status,e=self.owner.request(self.url+'/settlement/detailed','PUT',body,headers=headers);self.assertEqual(status,200,e)
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',body,headers=headers)[0],200)
        with storage.connect(server.DB) as db:self.assertEqual(db.execute('SELECT count(*) FROM finance_entries WHERE event_id=?',(self.event_id,)).fetchone()[0],2)
        data=self.data();data['rooms'][1]['paid_amount']='0';status,p=self.preview(data);self.assertNotEqual(status,200)

    def test_rooms_do_not_net_an_accounts_debt_against_another_rooms_credit(self):
        self.finish();data=self.data();data['people'][2].update(payments=[dict(payer_id=self.keys[0],share='1')],reason='甲代付丙的费用')
        self.publish(data);s=self.view(self.clients[0])['summary']
        self.assertEqual(s['my_outstanding_cents'],10000);self.assertEqual(s['my_refund_due_cents'],6000)
        self.assertEqual(s['my_balance_cents'],4000)

    def test_cannot_spend_another_rooms_cash_or_reference_its_expense(self):
        self.plan();self.record(self.rooms[0]['id'],kind='collection',amount='20',payer_id=self.keys[1],custodian_id=self.keys[0])
        tx=dict(kind='expense',amount='20',funding='pool',custodian_id=self.keys[0],room_id=self.rooms[1]['id'],merchant='KTV',occurred_at=self.stamp())
        body=dict(command='record',id=uuid.uuid4().hex[:16],base_revision=self.fresh()['revision'],transaction=tx)
        self.assertEqual(self.owner.request(self.url+'/finance/preview','POST',body)[0],409)
        self.finish();self.publish(self.data())
        entry=next(e for e in self.view()['entries'] if e['kind']=='expense' and e['payload']['room_id']==self.rooms[0]['id'])
        tx.update(kind='merchant_refund',reference_id=entry['id'],funding='payer',payer_id=self.keys[0])
        body.update(base_revision=self.fresh()['revision'],transaction=tx)
        self.assertEqual(self.owner.request(self.url+'/finance/preview','POST',body)[0],400)

    def test_cash_writes_require_room_and_plan_cannot_drop_funded_room(self):
        self.plan();self.record(self.rooms[0]['id'],kind='expense',funding='payer',amount='10',payer_id=self.keys[0],merchant='KTV')
        self.assertEqual(self.plan(self.rooms[1:])[0],409)
        tx=dict(kind='expense',amount='10',funding='payer',payer_id=self.keys[0],merchant='KTV',occurred_at=self.stamp())
        body=dict(command='record',id=uuid.uuid4().hex[:16],base_revision=self.fresh()['revision'],transaction=tx)
        self.assertEqual(self.owner.request(self.url+'/finance/preview','POST',body)[0],400)

    def test_old_client_cannot_overwrite_room_plan_or_room_bill(self):
        self.plan();self.finish();data=self.data(False);data.pop('rooms');self.assertEqual(self.preview(data)[0],409)
        body=dict(total_amount='320',headcount=4,base_revision=self.fresh()['revision'],base_version=0)
        self.assertEqual(self.owner.request(self.url+'/settlement','PUT',body)[0],409)
        self.publish(self.data(False));self.assertEqual(self.preview(data)[0],409)

    def test_history_freezes_actual_names_and_changes_preserve_cash(self):
        self.plan();self.finish();e=self.publish(self.data());old=copy.deepcopy(e['settlement']['detail'])
        data=self.data(False)
        for r in data['rooms']:r['merchant_mode']='recorded'
        data['rooms'][0].update(name='改名包间',amount='100')
        e=self.publish(data);self.assertEqual(e['settlement']['version'],2)
        self.assertEqual(self.view()['summary']['cost_cents'],32000)
        history=self.owner.request(self.url+'/settlement/history')[1]['revisions'];self.assertEqual(history[-1]['detail'],old)
        self.assertFalse(e['can_manage_rooms']);self.assertEqual(self.plan()[0],409)

    def test_room_rounding_is_exact_and_not_changed_by_request_order(self):
        self.finish();data=self.data(False)
        for r in data['rooms']:r['amount']='0.01'
        status,p=self.preview(data);self.assertEqual(status,200,p);dues=[p['due_cents'] for p in p['snapshot']['people']]
        data['people'].reverse();[r['person_ids'].reverse() for r in data['rooms']]
        status,q=self.preview(data);self.assertEqual(status,200,q)
        self.assertEqual(dues,[1,0,1,0]);self.assertEqual(dues,[p['due_cents'] for p in q['snapshot']['people']])

    def test_notice_names_each_room_collector_and_transfer(self):
        self.finish();status,p=self.preview(self.data());self.assertEqual(status,200,p)
        text='\n'.join(bot_outbox.settlement_notice(p['snapshot']))
        self.assertIn('牡丹厅',text);self.assertIn('兰花厅',text);self.assertIn('乙 → 甲',text);self.assertIn('丁 → 丙',text)

    def test_same_named_collectors_keep_distinct_account_labels(self):
        status,e=self.clients[2].request('/api/profile','POST',dict(nickname='甲'));self.assertEqual(status,200,e)
        self.finish();status,p=self.preview(self.data());self.assertEqual(status,200,p)
        a,b=p['snapshot']['room_balances']
        self.assertEqual(a['payer_name'],b['payer_name']);self.assertNotEqual(a['payer_label'],b['payer_label'])
        self.assertNotEqual(a['transfers'][0]['to_name'],b['transfers'][0]['to_name'])

    def test_migration_repeat_preserves_plan_and_append_only_history(self):
        self.plan()
        with storage.connect(server.DB) as db:before=[tuple(r) for r in db.execute('SELECT * FROM event_room_plans')]
        storage.initialize(server.DB);storage.initialize(server.DB)
        with storage.connect(server.DB) as db:
            self.assertEqual(before,[tuple(r) for r in db.execute('SELECT * FROM event_room_plans')])
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            with self.assertRaises(sqlite3.IntegrityError):db.execute('DELETE FROM event_room_plans WHERE event_id=?',(self.event_id,))
