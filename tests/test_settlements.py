import base64
import concurrent.futures
import copy
import hashlib
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
from qgroup_core import settlements
from test_api import test_png
from test_roster import ModernClient


class DetailedSettlementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'detail.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear();self.owner=ModernClient(self.base).identify('发起者');self.other=ModernClient(self.base).identify('代报者')
        start=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat(timespec='seconds')
        status,self.event=self.owner.request('/api/events','POST',dict(title='逐人结算测试',category='约K',location='KTV',starts_at=start,deadline=start,capacity=0,duration_hours=3,description='',join_owner=False))
        self.assertEqual(status,201);self.url='/api/events/'+self.event['id']
        body=dict(people=[dict(name='参加者'+str(i),payer_kind='manager') for i in range(1,8)],base_revision=self.event['revision'])
        status,preview=self.other.request(self.url+'/roster/preview','POST',body);self.assertEqual(status,200)
        status,self.event=self.other.request(self.url+'/roster/parties','POST',{**body,**preview,'accept_partial':True});self.assertEqual(status,200)
        status,self.event=self.owner.request(self.url,'PATCH',dict(action='finish',base_revision=self.event['revision']));self.assertEqual(status,200)
        status,self.context=self.owner.request(self.url+'/settlement/roster');self.assertEqual(status,200)
        self.people=self.context['people'];self.ids=[p['id'] for p in self.people]

    def fresh(self):
        return self.owner.request(self.url)[1]

    def item(self,**extra):
        return dict(id=uuid.uuid4().hex[:16],name='包房',amount='600',scope='common',mode='shares',kind='expense',reason='',allocations=[],**extra)

    def data(self):
        e=self.fresh()
        return dict(base_revision=e['revision'],base_version=e['settlement']['version'] if e['settlement'] else 0,reviewed_roster=True,
            people=[dict(id=p['id'],share='1',reason='',payments=[dict(payer_id=p['payer_id'],share='1')]) for p in self.people],items=[self.item()],note='',reason='核对费用')

    def preview(self,data,client=None):
        return (client or self.owner).request(self.url+'/settlement/preview','POST',data)

    def publish(self,data,client=None,headers=None):
        client=client or self.owner;status,result=self.preview(data,client);self.assertEqual(status,200,result)
        return client.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':result['preview_token']},headers=headers)

    def test_seven_seats_one_exempt_six_shares_600_and_manager_total(self):
        data=self.data();data['people'][-1].update(share='0',reason='陪同不参加唱歌，经确认免共同费用')
        status,e=self.publish(data);self.assertEqual(status,200,e)
        detail=e['settlement']['detail'];self.assertEqual(e['settlement']['mode'],'detailed');self.assertEqual(e['confirmed_count'],7)
        self.assertEqual([p['due_cents'] for p in detail['people']],[10000]*6+[0])
        self.assertEqual([p['amount_cents'] for p in detail['payers']],[60000])
        self.assertEqual(self.other.request(self.url)[1]['my_payable_cents'],60000)
        self.assertIsNone(e.get('my_payable_cents'))

    def test_exempt_still_pays_selected_personal_consumption(self):
        data=self.data();data['people'][-1].update(share='0',reason='免共同 AA')
        item=self.item();item.update(name='个人饮料',amount='30',scope='selected',mode='equal',reason='仅最后一位点单',allocations=[dict(person_id=self.ids[-1])]);data['items'].append(item)
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertEqual(e['settlement']['detail']['people'][-1]['due_cents'],3000)
        self.assertEqual(e['settlement']['detail']['total_cents'],63000)

    def test_half_share_rounding_is_exact_stable_and_request_order_independent(self):
        data=self.data();data['items'][0]['amount']='0.05'
        data['people'][0].update(share='0.5',reason='提前离场，约定半份')
        status,a=self.preview(data);self.assertEqual(status,200,a)
        data['people'].reverse();status,b=self.preview(data);self.assertEqual(status,200,b)
        self.assertEqual(a['snapshot'],b['snapshot']);self.assertEqual(sum(p['due_cents'] for p in a['snapshot']['people']),5)
        self.assertEqual([p['due_cents'] for p in a['snapshot']['people']],[0,1,1,1,1,1,0])

    def test_all_exempt_positive_rejected_zero_invoice_with_empty_roster_allowed(self):
        data=self.data()
        for p in data['people']:p.update(share='0',reason='主办承担')
        self.assertEqual(self.preview(data)[0],400)
        data['items'][0]['amount']='0';self.assertEqual(self.publish(data)[0],200)
        # A completely empty event can publish zero, without inventing people.
        with sqlite3.connect(server.DB) as db:
            db.execute("UPDATE attendees SET status='withdrawn' WHERE event_id=?",(self.event['id'],))
        data=self.data();data['people']=[];data['items'][0]['amount']='0'
        status,e=self.publish(data);self.assertEqual(status,200,e);self.assertEqual(e['settlement']['headcount'],0)

    def test_fixed_weights_duration_and_multiple_items(self):
        data=self.data();data['items']=[]
        specifications=[('weights',[dict(person_id=self.ids[0],weight='1'),dict(person_id=self.ids[1],weight='2')],'10'),
            ('duration',[dict(person_id=self.ids[0],minutes=60),dict(person_id=self.ids[1],minutes=120)],'9'),
            ('fixed',[dict(person_id=self.ids[0],amount='1'),dict(person_id=self.ids[1],amount='2')],'3')]
        for mode,allocations,amount in specifications:
            item=self.item();item.update(mode=mode,scope='selected',amount=amount,allocations=allocations,reason='按实际消费核对');data['items'].append(item)
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertEqual([p['due_cents'] for p in e['settlement']['detail']['people'][:2]],[733,1467])
        for item in e['settlement']['detail']['items']:self.assertEqual(sum(a['amount_cents'] for a in item['breakdown']),item['amount_cents'])

    def test_refund_discount_reduce_cost_not_record_receipts_or_cash_flow(self):
        data=self.data()
        for kind,value in [('refund','100'),('discount','10')]:
            item=self.item();item.update(kind=kind,amount=value,reason='店家核对退差价');data['items'].append(item)
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertEqual(e['settlement']['detail']['total_cents'],49000)
        self.assertEqual(sum(p['due_cents'] for p in e['settlement']['detail']['people']),49000)
        data=self.data();data['items'][0].update(kind='refund',amount='1',reason='错误退款')
        self.assertEqual(self.preview(data)[0],400)

    def test_missing_people_wrong_event_duplicates_and_unreviewed_rejected(self):
        for change in ['missing','foreign','duplicate','review']:
            data=self.data()
            if change=='missing':data['people'].pop()
            if change=='foreign':data['people'][0]['id']='0'*16
            if change=='duplicate':data['people'].append(data['people'][0])
            if change=='review':data['reviewed_roster']=False
            self.assertEqual(self.preview(data)[0],400,change)
        self.assertIsNone(self.fresh()['settlement'])

    def test_absence_pending_and_withdrawn_require_explicit_reason_not_automatic_free(self):
        for state,column,value in [('absent','attendance','absent'),('pending','confirmation_state','pending'),('withdrawn','status','withdrawn')]:
            with sqlite3.connect(server.DB) as db:db.execute('UPDATE attendees SET '+column+'=? WHERE id=?',(value,self.ids[0]))
            data=self.data();self.assertEqual(self.preview(data)[0],400,state)
            data['people'][0]['reason']='已核对该参加者原约定，仍正常分担'
            status,result=self.preview(data);self.assertEqual(status,200,result)
            self.assertGreater(result['snapshot']['people'][0]['due_cents'],0)
            with sqlite3.connect(server.DB) as db:db.execute("UPDATE attendees SET attendance='unknown',confirmation_state='accepted',status='confirmed' WHERE id=?",(self.ids[0],))

    def test_split_payers_aggregate_and_fixed_assignment_validate(self):
        data=self.data();data['items'][0]['amount']='0.07'
        custom='custom:'+uuid.uuid4().hex[:16];data['custom_payers']=[dict(id=custom,name='另一位代付')]
        p=data['people'][0];original=p['payments'][0]['payer_id']
        p.update(reason='两位各承担一部分',payments=[dict(payer_id=original,share='1'),dict(payer_id=custom,share='1')])
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertEqual(e['settlement']['detail']['people'][0]['payments'][0]['amount_cents'],1)
        self.assertEqual(e['settlement']['detail']['people'][0]['payments'][1]['amount_cents'],0)
        data=self.data();data['people'][0].update(payment_mode='fixed',payments=[dict(payer_id=original,amount='2')])
        self.assertEqual(self.preview(data)[0],400)

    def test_noop_and_image_history_remain_immutable(self):
        data=self.data();encoded=base64.b64encode(test_png()).decode();item_id=data['items'][0]['id']
        data['items'][0]['receipt']=encoded;data['qr_image']=encoded
        status,e=self.publish(data);self.assertEqual(status,200,e)
        endpoint=self.url+'/settlement/history/1/receipts/'+item_id
        self.assertEqual(self.owner.opener.open(self.base+endpoint).read(),test_png())
        data['base_version']=1;data['base_revision']=e['revision'];data['items'][0]['receipt']=dict(version=1,item_id=item_id);data.pop('qr_image')
        status,same=self.publish(data);self.assertEqual(status,200,same);self.assertEqual(same['settlement']['version'],1)
        data['note']='修改备注';data['qr_image']=None;data['items'][0]['receipt']=None
        status,edited=self.publish(data);self.assertEqual(status,200,edited);self.assertEqual(edited['settlement']['version'],2)
        history=self.owner.request(self.url+'/settlement/history')[1]['revisions'];self.assertEqual(len(history),2)
        self.assertTrue(history[-1]['has_qr']);self.assertTrue(history[-1]['detail']['items'][0]['has_receipt'])
        self.assertEqual(self.owner.opener.open(self.base+endpoint).read(),test_png())
        self.assertEqual(self.owner.request(self.url+'/settlement/history/2/receipts/'+item_id)[0],404)
        with sqlite3.connect(server.DB) as db:
            for table in ['settlement_details','settlement_receipt_images']:
                with self.assertRaises(sqlite3.IntegrityError):db.execute('DELETE FROM '+table+' WHERE event_id=?',(self.event['id'],))

    def test_legacy_conversion_keeps_original_money_divisor_qr_and_blocks_old_writes(self):
        e=self.fresh();encoded=base64.b64encode(test_png()).decode()
        status,legacy=self.owner.request(self.url+'/settlement','PUT',dict(base_revision=e['revision'],base_version=0,total_amount='100',headcount=8,qr_image=encoded,note='旧账'))
        self.assertEqual(status,200)
        data=self.data();self.assertEqual(self.preview(data)[0],400)
        data['convert_legacy']=True;status,e=self.publish(data);self.assertEqual(status,200,e)
        history=self.owner.request(self.url+'/settlement/history')[1]['revisions'];old=history[-1]
        self.assertEqual((old['total_amount'],old['headcount'],old['per_person_amount'],old['note']),('100.00',8,'12.50','旧账'))
        self.assertTrue(old['has_qr']);self.assertEqual(old['mode'],'legacy');self.assertEqual(history[0]['kind'],'converted')
        self.assertEqual(self.owner.request(self.url+'/settlement','PUT',dict(base_revision=e['revision'],base_version=2,total_amount='10',headcount=1))[0],409)

    def test_preview_token_and_base_versions_prevent_changed_input_and_competing_writes(self):
        data=self.data();status,preview=self.preview(data);self.assertEqual(status,200)
        changed={**data,'preview_token':preview['preview_token'],'note':'changed'}
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',changed)[0],409)
        body={**data,'preview_token':preview['preview_token']}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.owner.request(self.url+'/settlement/detailed','PUT',body),range(2)))
        self.assertEqual(sorted(r[0] for r in results),[200,409]);self.assertEqual(self.fresh()['settlement']['version'],1)

    def test_identical_request_retry_does_not_duplicate_history_or_notices(self):
        data=self.data();preview=self.preview(data)[1];body={**data,'preview_token':preview['preview_token']};headers={'Idempotency-Key':uuid.uuid4().hex}
        a=self.owner.request(self.url+'/settlement/detailed','PUT',body,headers=headers)
        b=self.owner.request(self.url+'/settlement/detailed','PUT',body,headers=headers)
        self.assertEqual(a,b)
        with sqlite3.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM settlement_details WHERE event_id=?',(self.event['id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM notifications WHERE event_id=? AND kind=?',(self.event['id'],'settlement_updated')).fetchone()[0],1)

    def test_failed_audit_rolls_back_bill_receipt_notice_and_cache(self):
        data=self.data();data['items'][0]['receipt']=base64.b64encode(test_png()).decode();preview=self.preview(data)[1]
        with sqlite3.connect(server.DB) as db:db.execute("CREATE TRIGGER reject_invoice_audit BEFORE INSERT ON event_audit BEGIN SELECT RAISE(ABORT,'injected'); END")
        try:
            self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})[0],500)
            self.assertIsNone(self.fresh()['settlement'])
            with sqlite3.connect(server.DB) as db:
                for table in ['settlement_details','settlement_receipts','settlement_history']:
                    self.assertEqual(db.execute('SELECT count(*) FROM '+table+' WHERE event_id=?',(self.event['id'],)).fetchone()[0],0)
        finally:
            with sqlite3.connect(server.DB) as db:db.execute('DROP TRIGGER reject_invoice_audit')

    def test_private_receipts_and_roster_require_access_and_owner(self):
        with sqlite3.connect(server.DB) as db:db.execute("UPDATE events SET visibility='invitation' WHERE id=?",(self.event['id'],))
        visitor=ModernClient(self.base).identify('陌生人');data=self.data();data['items'][0]['receipt']=base64.b64encode(test_png()).decode()
        status,e=self.publish(data);self.assertEqual(status,200,e)
        receipt=self.url+'/settlement/history/1/receipts/'+data['items'][0]['id']
        self.assertEqual(visitor.request(receipt)[0],404);self.assertEqual(visitor.request(self.url+'/settlement/history')[0],404)
        self.assertEqual(self.other.request(self.url+'/settlement/roster')[0],403)
        self.assertEqual(self.preview(self.data(),self.other)[0],403)
        self.assertEqual(self.other.opener.open(self.base+receipt).read(),test_png())

    def test_numeric_bounds_and_bad_fixed_allocations(self):
        for invalid in ['-1','1.001','NaN','1e2','99999999','０１']:
            data=self.data();data['items'][0]['amount']=invalid;self.assertEqual(self.preview(data)[0],400,invalid)
        data=self.data();data['items'][0].update(mode='fixed',reason='指定金额',allocations=[dict(person_id=p['id'],amount='1') for p in data['people']])
        self.assertEqual(self.preview(data)[0],400)
        data=self.data();data['people'][0]['share']='1001';self.assertEqual(self.preview(data)[0],400)

    def test_accepted_arrangements_and_historical_names_frozen_on_new_version(self):
        data=self.data();status,e=self.publish(data);self.assertEqual(status,200)
        original=e['settlement']['detail']['people'][0]['name']
        with sqlite3.connect(server.DB) as db:db.execute('UPDATE attendees SET name=? WHERE id=?',('改后称呼',self.ids[0]))
        data=self.data();data['note']='核对称呼';status,updated=self.publish(data);self.assertEqual(status,200,updated)
        self.assertEqual(updated['settlement']['detail']['people'][0]['name'],'改后称呼')
        old=self.owner.request(self.url+'/settlement/history')[1]['revisions'][-1]
        self.assertEqual(old['detail']['people'][0]['name'],original)
        self.assertIn('accepted_arrangement',old['detail']['people'][0])

    def test_fixed_multi_payer_assignment_and_change_summary(self):
        data=self.data();data['items'][0]['amount']='7'
        custom='custom:'+uuid.uuid4().hex[:16];data['custom_payers']=[dict(id=custom,name='另一位合付人')]
        p=data['people'][0];default=p['payments'][0]['payer_id']
        p.update(reason='约定各承担一部分',payment_mode='fixed',payments=[dict(payer_id=default,amount='0.25'),dict(payer_id=custom,amount='0.75')])
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertEqual([v['amount_cents'] for v in e['settlement']['detail']['people'][0]['payments']],[25,75])
        data.update(base_revision=e['revision'],base_version=1,note='改后备注',reason='补充说明')
        status,e=self.publish(data);self.assertEqual(status,200,e)
        self.assertIn('备注：无 → 改后备注',e['settlement']['detail']['changes'])
        self.assertEqual(sum(v['amount_cents'] for v in e['settlement']['detail']['payers']),700)

    def test_bad_identifier_types_and_duplicate_payers_return_validation_errors(self):
        for target in ['person','payer','allocation','duplicate_payer']:
            data=self.data()
            if target=='person':data['people'][0]['id']=[]
            if target=='payer':data['people'][0]['payments'][0]['payer_id']={}
            if target=='allocation':data['items'][0]['allocations']=[dict(person_id=[])]
            if target=='duplicate_payer':data['people'][0]['payments']*=2
            self.assertEqual(self.preview(data)[0],400,target)

    def test_receipt_bounds_invalid_reference_and_changed_image_need_new_preview(self):
        data=self.data();data['items'][0]['receipt']='not-png';self.assertEqual(self.preview(data)[0],400)
        data=self.data();data['items'][0]['receipt']=dict(version=1,item_id='0'*16);self.assertEqual(self.preview(data)[0],400)
        encoded=base64.b64encode(test_png()).decode()
        data=self.data();data['items']=[dict(self.item(),receipt=encoded) for _ in range(4)]
        self.assertEqual(self.preview(data)[0],400)
        data=self.data();data['items'][0]['receipt']=encoded
        preview=self.preview(data)[1]
        data['items'][0]['receipt']=base64.b64encode(test_png(b'\x00\x00\x00')).decode()
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})[0],409)

    def test_cancelled_archived_bill_can_be_corrected_but_cohost_cannot_write(self):
        e=self.fresh();status,e=self.owner.request(self.url,'PATCH',dict(action='cancel',reason='取消但仍有费用',base_revision=e['revision']));self.assertEqual(status,200)
        status,e=self.owner.request(self.url,'PATCH',dict(action='archive',base_revision=e['revision']));self.assertEqual(status,200)
        self.assertEqual(self.publish(self.data())[0],200)
        self.assertEqual(self.preview(self.data(),self.other)[0],403)
        with sqlite3.connect(server.DB) as db:
            user=db.execute('SELECT id FROM users WHERE nickname=? ORDER BY created_at DESC LIMIT 1',('代报者',)).fetchone()[0]
            db.execute('INSERT INTO event_roles VALUES(?,?,?,?,?)',(uuid.uuid4().hex[:16],self.event['id'],user,json.dumps(['schedule','roster','attendance']),server.now()))
        self.assertEqual(self.preview(self.data(),self.other)[0],403)

    def test_foreign_receipt_is_not_reusable_and_duplicate_names_do_not_merge(self):
        data=self.data();data['items'][0]['receipt']=base64.b64encode(test_png()).decode();status,e=self.publish(data);self.assertEqual(status,200)
        with sqlite3.connect(server.DB) as db:
            db.execute('UPDATE attendees SET name=? WHERE id IN (?,?)',('同名',self.ids[0],self.ids[1]))
        data=self.data();status,preview=self.preview(data);self.assertEqual(status,200,preview)
        identical=[p for p in preview['snapshot']['people'] if p['name']=='同名']
        self.assertEqual(len(identical),2);self.assertNotEqual(identical[0]['id'],identical[1]['id']);self.assertNotEqual(identical[0]['label'],identical[1]['label'])
        # An arbitrary other event ID cannot read a receipt, even with a valid version and item ID.
        self.assertEqual(self.owner.request('/api/events/'+('f'*16)+'/settlement/history/1/receipts/'+data['items'][0]['id'])[0],404)

    def test_former_owner_after_transfer_cannot_save_prepared_invoice(self):
        data=self.data();preview=self.preview(data)[1]
        e=self.fresh();status,e=self.owner.request(self.url+'/management/invitations','POST',dict(base_revision=e['revision'],kind='transfer',permissions=[],target_name='代报者',reason='移交结算'))
        self.assertEqual(status,200);token=e['pending_management'][0]['token']
        info=self.other.request(self.url+'/management/invitations/'+token)[1]
        status,e=self.other.request(self.url+'/management/invitations/'+token+'/accept','POST',dict(base_revision=info['base_revision'],accept_responsibility=True));self.assertEqual(status,200)
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})[0],409)
        data['base_revision']=e['revision'];self.assertEqual(self.preview(data)[0],403)
        self.assertIsNone(self.fresh()['settlement'])


class AllocationAndMigrationTests(unittest.TestCase):
    def test_largest_remainders_signed_and_many_small_amounts(self):
        from fractions import Fraction
        for cents in range(-100,101):
            values=settlements.split(cents,[Fraction(1),Fraction(2),Fraction(3)])
            self.assertEqual(sum(values),cents)
            self.assertEqual(values,[-v for v in settlements.split(-cents,[Fraction(1),Fraction(2),Fraction(3)])])

    def test_p2_upgrade_preserves_all_values_and_failed_v3_is_transactional(self):
        from deploy.verify_migration import verify
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'p2.sqlite3'
            with mock.patch.object(server.storage,'migrate_settlements',lambda db:None):server.storage.initialize(path)
            with sqlite3.connect(path) as db:before=db.execute('SELECT * FROM schema_migrations').fetchall()
            original=server.storage.migrate_settlements
            def fail(db):original(db);raise RuntimeError('injected')
            with mock.patch.object(server.storage,'migrate_settlements',fail):
                with self.assertRaises(RuntimeError):server.storage.initialize(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT * FROM schema_migrations').fetchall(),before)
                self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='settlement_details'").fetchone())
            verify(path,Path(folder)/'upgraded.sqlite3')
            server.storage.initialize(path);server.storage.initialize(path)
            with sqlite3.connect(path) as db:self.assertTrue(set(range(1,11))|{12} <= {r[0] for r in db.execute('SELECT version FROM schema_migrations')})
