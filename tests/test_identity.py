"""Identity transfer tests exercise HTTP permissions without touching production data."""
import base64
import concurrent.futures
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from datetime import datetime,timedelta,timezone
from pathlib import Path

import server
import test_finance as finance_tests
from test_api import test_png
from test_roster import ModernClient
from qgroup_core import identity,storage
from deploy.verify_migration import verify,snapshot,preserved


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'identity.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.owner=ModernClient(self.base).identify('发起者')
        self.manager=ModernClient(self.base).identify('代报者')
        self.other=ModernClient(self.base).identify('本人甲')
        self.stranger=ModernClient(self.base).identify('本人甲')
        start=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        status,self.event=self.owner.request('/api/events','POST',dict(title='认领验收',category='约K',location='测试KTV',starts_at=start,deadline=start,duration_hours=3,capacity=3,description='',join_owner=False))
        self.assertEqual(status,201);self.url='/api/events/'+self.event['id']
        self.signup(self.manager,[dict(name='被代报甲',payer_kind='self'),dict(name='被代报乙',payer_kind='manager')])
        self.person,self.second=self.fresh()['participants']
        self.a,self.b=[p['payer_id'] for p in self.owner.request(self.url+'/settlement/roster')[1]['people']]
        self.c=self.view()['default_custodian_id']

    fresh=finance_tests.FinanceTests.fresh
    view=finance_tests.FinanceTests.view
    stamp=finance_tests.FinanceTests.stamp
    tx=finance_tests.FinanceTests.tx
    body=finance_tests.FinanceTests.body
    prepare=finance_tests.FinanceTests.prepare
    commit=finance_tests.FinanceTests.commit
    post=finance_tests.FinanceTests.post
    act=finance_tests.FinanceTests.act
    balance=finance_tests.FinanceTests.balance

    def signup(self,client,people,**extra):
        data=dict(people=people,base_revision=self.fresh()['revision'],**extra)
        status,p=client.request(self.url+'/roster/preview','POST',data);self.assertEqual(status,200,p)
        status,e=client.request(self.url+'/roster/parties','POST',{**data,**p,'accept_partial':True});self.assertEqual(status,200,e)
        return e

    def issue(self,person=None,client=None):
        status,e=(client or self.manager).request(self.url+'/claims','POST',dict(attendee_id=(person or self.person)['id'],reason='本人核对',base_revision=self.fresh()['revision']))
        self.assertEqual(status,200,e)
        return next(c for c in e['claim_invitations'] if c['status']=='invited' and c['attendee_id']==(person or self.person)['id'])

    def request_claim(self,c,client=None,**extra):
        client=client or self.other
        status,info=client.request(self.url+'/claims/'+c['token']);self.assertEqual(status,200,info)
        return client.request(self.url+'/claims/'+c['token']+'/request','POST',dict({'base_revision':info['base_revision'],'confirm_identity':True,'keep_payment':True},**extra))

    def decide(self,c,client=None,**extra):
        return (client or self.manager).request(self.url+'/claims/'+c['id'],'POST',dict({'base_revision':self.fresh()['revision'],'decision':'approve','confirm_person':True,'reason':'已当面核对'},**extra))

    def invoice(self):
        self.assertEqual(self.owner.request(self.url,'PATCH',dict(action='finish',base_revision=self.fresh()['revision']))[0],200)
        ctx=self.owner.request(self.url+'/settlement/roster')[1]
        self.item=uuid.uuid4().hex[:16];image=base64.b64encode(test_png()).decode()
        data=dict(base_revision=self.fresh()['revision'],base_version=0,reviewed_roster=True,people=[dict(id=p['id'],share='1',reason='原约定',payments=[dict(payer_id=p['payer_id'],share='1')]) for p in ctx['people']],items=[dict(id=self.item,name='包房',amount='200',mode='shares',scope='common',kind='expense',allocations=[],reason='',receipt=image)],reason='核对',note='保留备注',qr_image=image)
        p=self.owner.request(self.url+'/settlement/preview','POST',data)[1]
        status,e=self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':p['preview_token']});self.assertEqual(status,200,e)

    def money_snapshot(self):
        with storage.connect(server.DB) as db:
            return {t:[tuple(r) for r in db.execute('SELECT * FROM '+t+' WHERE event_id=?',(self.event['id'],))] for t in ['settlements','settlement_history','settlement_details','settlement_receipts','finance_entries','finance_reports']}

    def test_only_manager_invites_and_explicit_double_confirmation_preserves_place(self):
        self.assertEqual(self.stranger.request(self.url+'/claims','POST',dict(attendee_id=self.person['id'],base_revision=self.fresh()['revision'],reason='冒领'))[0],403)
        before=self.fresh()
        with storage.connect(server.DB) as db:original=dict(db.execute('SELECT * FROM attendees WHERE id=?',(self.person['id'],)).fetchone())
        c=self.issue()
        self.assertEqual(self.request_claim(c,confirm_identity=False)[0],400)
        self.assertEqual(self.request_claim(c,keep_payment=False)[0],400)
        self.assertEqual(self.request_claim(c)[0],200)
        self.assertEqual(self.decide(c,self.stranger)[0],403)
        self.assertEqual(self.decide(c,confirm_person=False)[0],400)
        self.assertEqual(self.decide(c)[0],200)
        after=self.fresh();claimed=next(p for p in after['participants'] if p['id']==self.person['id'])
        self.assertEqual(after['confirmed_count'],before['confirmed_count']);self.assertEqual(after['confirmed_count'],2)
        with storage.connect(server.DB) as db:
            after_row=dict(db.execute('SELECT * FROM attendees WHERE id=?',(self.person['id'],)).fetchone())
        for field in original:
            if field not in ('user_id','manager_id','updated_at'):self.assertEqual(after_row[field],original[field],field)
        for field in ('id','party_id','status','accepted_conditions_version','queue_mode'):
            self.assertEqual(claimed.get(field),self.person.get(field),field)
        mine=self.other.request(self.url)[1]['my_registration'];self.assertEqual(mine['id'],self.person['id'])
        self.assertIsNone(self.stranger.request(self.url)[1]['my_registration'])
        self.assertFalse(next(p for p in self.manager.request(self.url)[1]['participants'] if p['id']==self.person['id'])['can_manage'])
        self.assertEqual(self.decide(c)[0],403)
        self.assertTrue(self.other.request(self.url+'/claims/'+c['token'])[1]['claimed'])
        self.assertEqual(self.stranger.request(self.url+'/claims/'+c['token'])[0],404)

    def test_private_link_preview_and_request_do_not_grant_event_or_images(self):
        with storage.connect(server.DB) as db:db.execute("UPDATE events SET visibility='invitation' WHERE id=?",(self.event['id'],))
        self.invoice();c=self.issue()
        status,preview=self.other.request(self.url+'/claims/'+c['token']);self.assertEqual(status,200)
        for key in ('participants','description','location','settlement','share_token'):self.assertNotIn(key,preview)
        self.assertEqual(self.request_claim(c)[0],200)
        for path in ('','/history','/finance','/settlement/history','/payment-code','/settlement/history/1/receipts/'+self.item):
            self.assertEqual(self.other.request(self.url+path)[0],404,path)
        self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.other.request(self.url)[0],200)
        image=self.other.opener.open(self.base+self.url+'/settlement/history/1/receipts/'+self.item).read();self.assertEqual(image,test_png())

    def test_claim_after_invoicing_keeps_every_money_row_and_person_payer(self):
        self.invoice();self.post(self.tx(amount='40'));before=self.money_snapshot();c=self.issue()
        self.assertEqual(self.request_claim(c)[0],200);self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.money_snapshot(),before)
        ctx=self.owner.request(self.url+'/settlement/roster')[1]
        self.assertEqual(next(p for p in ctx['people'] if p['id']==self.person['id'])['payer_id'],self.a)
        self.assertIn(self.a,self.view(self.other)['reportable_ids']);self.assertNotIn(self.a,self.view(self.manager)['reportable_ids'])
        self.assertEqual(self.view(self.other)['summary']['my_outstanding_cents'],6000)
        uid=self.post(self.tx(amount='60'),self.other,'report');self.act('accept',report_id=uid)
        self.assertEqual(self.balance(self.a)['balance_cents'],0)
        self.assertEqual(self.view(self.other)['summary']['my_outstanding_cents'],0)

    def test_manager_payment_stays_with_original_manager(self):
        self.invoice();before=self.money_snapshot();c=self.issue(self.second)
        self.assertEqual(self.request_claim(c)[0],200);self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.money_snapshot(),before)
        self.assertIn(self.b,self.view(self.manager)['reportable_ids']);self.assertNotIn(self.b,self.view(self.other)['reportable_ids'])
        self.assertIsNone(self.view(self.other)['summary']['my_outstanding_cents'])
        self.post({**self.tx(),'payer_id':self.b},self.manager,'report')

    def test_duplicate_signup_requires_explicit_withdrawal_then_reuses_original_place(self):
        e=self.signup(self.other,[dict(is_self=True)]);duplicate=e['my_registration'];c=self.issue()
        self.assertTrue(self.other.request(self.url+'/claims/'+c['token'])[1]['duplicate'])
        self.assertEqual(self.request_claim(c)[0],409)
        status,e=self.other.request(self.url+'/attendees/'+duplicate['id'],'DELETE',dict(base_revision=self.fresh()['revision'],reason='核对本人重复报名'))
        self.assertEqual(status,200,e)
        self.assertEqual(self.request_claim(c)[0],200);self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.fresh()['confirmed_count'],2)
        self.assertEqual(self.other.request(self.url)[1]['my_registration']['id'],self.person['id'])
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT status FROM attendees WHERE id=?',(duplicate['id'],)).fetchone()[0],'withdrawn')

    def test_parallel_claim_requests_have_only_one_winner(self):
        c=self.issue();revision=self.fresh()['revision']
        def request(client):return client.request(self.url+'/claims/'+c['token']+'/request','POST',dict(base_revision=revision,confirm_identity=True,keep_payment=True))[0]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:statuses=list(pool.map(request,[self.other,self.stranger]))
        self.assertEqual(sorted(statuses),[200,409]);self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.fresh()['confirmed_count'],2)

    def test_duplicate_created_after_request_blocks_approval(self):
        c=self.issue();self.assertEqual(self.request_claim(c)[0],200);self.signup(self.other,[dict(is_self=True)])
        self.assertEqual(self.decide(c)[0],409)
        self.assertEqual(self.fresh()['confirmed_count'],3)

    def test_expired_revoked_and_superseded_invites_fail(self):
        c=self.issue();new=self.issue();self.assertEqual(self.other.request(self.url+'/claims/'+c['token'])[0],404)
        self.assertEqual(self.decide(new,decision='revoke')[0],200);self.assertEqual(self.other.request(self.url+'/claims/'+new['token'])[0],404)
        c=self.issue()
        with storage.connect(server.DB) as db:db.execute("UPDATE attendee_claims SET expires_at='2000-01-01' WHERE id=?",(c['id'],))
        self.assertEqual(self.other.request(self.url+'/claims/'+c['token'])[0],404)

    def test_issuer_lost_management_invite_cannot_be_requested(self):
        c=self.issue()
        with storage.connect(server.DB) as db:
            owner=db.execute('SELECT owner_id FROM events WHERE id=?',(self.event['id'],)).fetchone()[0]
            db.execute('UPDATE attendees SET manager_id=? WHERE id=?',(owner,self.person['id']))
        self.assertEqual(self.other.request(self.url+'/claims/'+c['token'])[0],409)

    def link(self,client=None):
        status,result=(client or self.owner).request('/api/account/link','POST',dict(authorize_device=True));self.assertEqual(status,200,result);return result['link_token']

    def accept(self,token,client=None,**extra):return (client or self.other).request('/api/account/accept','POST',dict({'token':token,'accept_access':True},**extra))
    def switch(self,scope,client=None,**extra):return (client or self.other).request('/api/account/switch','POST',dict(scope=scope),headers=extra.get('headers'))

    def test_device_grant_switch_and_revoke_preserve_both_accounts_and_data(self):
        original=self.other.request('/api/me')[1];owner=self.owner.request('/api/me')[1];before=self.fresh()
        self.assertEqual(self.accept(self.link())[0],200)
        self.assertEqual(self.other.request('/api/me')[1],original)
        info=self.other.request('/api/account')[1];self.assertEqual(len(info['accounts']),2)
        self.assertEqual(self.switch(owner['draft_scope'])[0],200)
        self.assertEqual(self.other.request('/api/me')[1],owner)
        status,_=self.other.request('/api/profile','POST',dict(nickname='过期分页面'),headers={'X-Kanban-Identity':original['draft_scope']});self.assertEqual(status,409)
        self.assertEqual(self.switch(original['draft_scope'])[0],200)
        self.assertEqual(self.other.request('/api/me')[1],original)
        self.assertEqual(self.switch(owner['draft_scope'])[0],200)
        devices=self.owner.request('/api/account')[1]['devices'];self.assertEqual(len(devices),2)
        remote=next(d for d in devices if not d['current'])
        self.assertEqual(self.owner.request('/api/account/revoke','POST',dict(device_id=remote['id']))[0],200)
        self.assertEqual(self.other.request('/api/me')[1],original)
        self.assertEqual(self.switch(owner['draft_scope'])[0],403)
        self.assertEqual(self.fresh(),before)
        self.assertEqual(len(self.other.request('/api/account')[1]['accounts']),1)
        # Reinitializing/restoring a legitimately switched session must preserve every value.
        with tempfile.TemporaryDirectory() as directory:
            counts=verify(server.DB,Path(directory)/'restored.sqlite3');self.assertGreater(counts['account_audit'],0)

    def test_link_expiry_explicit_consent_replay_and_scope_forgery(self):
        self.assertEqual(self.owner.request('/api/account/link','POST',{})[0],400)
        token=self.link();self.assertEqual(self.accept(token,accept_access=False)[0],400)
        self.assertEqual(self.accept(token)[0],200);self.assertEqual(self.accept(token)[0],404)
        self.assertEqual(self.switch('a'*64)[0],403)
        old=self.link();new=self.link();self.assertEqual(self.accept(old)[0],404)
        with storage.connect(server.DB) as db:db.execute("UPDATE device_links SET expires_at='2000-01-01' WHERE token=?",(new,))
        self.assertEqual(self.accept(new)[0],404)
        me=next(d for d in self.owner.request('/api/account')[1]['devices'] if d['current'])
        self.assertEqual(self.owner.request('/api/account/revoke','POST',dict(device_id=me['id']))[0],400)

    def test_account_and_payment_origin_audit_are_append_only(self):
        self.link();c=self.issue();self.request_claim(c);self.decide(c)
        with storage.connect(server.DB) as db:
            for table in ('account_audit','attendee_payment_origins'):
                for statement in ('UPDATE '+table+' SET '+('action=action' if table=='account_audit' else 'payer_id=payer_id'),'DELETE FROM '+table):
                    with self.assertRaises(sqlite3.IntegrityError):db.execute(statement)

    def test_backup_restore_preserves_all_versions_images_cash_and_refunds(self):
        self.invoice();self.post(self.tx(amount='120'));self.post(self.tx('refund','20'))
        c=self.issue();self.request_claim(c);self.decide(c)
        with storage.connect(server.DB) as db:before=snapshot(db)
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'restored.sqlite3';verify(server.DB,target)
            with storage.connect(target) as db:preserved(db,before)
            old=server.DB
            try:
                server.DB=target
                self.assertEqual(self.balance(self.a)['balance_cents'],0)
                image=self.owner.opener.open(self.base+self.url+'/payment-code').read();self.assertEqual(image,test_png())
                image=self.owner.opener.open(self.base+self.url+'/settlement/history/1/receipts/'+self.item).read();self.assertEqual(image,test_png())
                self.assertEqual(self.view()['summary']['held_cents'],10000)
            finally:server.DB=old

    def test_waiting_claim_preserves_queue_and_together_waitlist_requires_coordination(self):
        self.signup(self.owner,[dict(is_self=True)])
        e=self.signup(self.manager,[dict(name='候补甲',payer_kind='self')])
        waiting=next(p for p in e['participants'] if p['status']=='waiting');c=self.issue(waiting)
        self.assertEqual(self.request_claim(c)[0],200);self.assertEqual(self.decide(c)[0],200)
        claimed=self.other.request(self.url)[1]['my_registration'];self.assertEqual(claimed['waiting_position'],waiting['waiting_position'])
        e=self.signup(self.manager,[dict(name='整组一',payer_kind='self'),dict(name='整组二',payer_kind='self')],queue_mode='together')
        grouped=next(p for p in e['participants'] if p['queue_mode']=='together')
        self.assertFalse(grouped['can_claim'])
        self.assertEqual(self.manager.request(self.url+'/claims','POST',dict(attendee_id=grouped['id'],base_revision=e['revision'],reason='需先拆组'))[0],409)

    def test_duplicate_with_prepayment_keeps_credit_in_original_account(self):
        e=self.signup(self.other,[dict(is_self=True)]);p=e['my_registration']
        ctx=self.owner.request(self.url+'/settlement/roster')[1]
        original=next(q['payer_id'] for q in ctx['people'] if q['id']==p['id'])
        self.post({**self.tx(amount='30'),'payer_id':original});before=self.money_snapshot();c=self.issue()
        self.assertEqual(self.request_claim(c)[0],409)
        self.assertEqual(self.other.request(self.url+'/attendees/'+p['id'],'DELETE',dict(base_revision=self.fresh()['revision'],reason='本人重复报名；预付款保留原账号待核对'))[0],200)
        self.assertEqual(self.request_claim(c)[0],200);self.assertEqual(self.decide(c)[0],200)
        self.assertEqual(self.money_snapshot(),before)
        self.assertEqual(self.balance(original)['contributed_cents'],3000)
        self.assertFalse(any(b['id']==self.a and b['contributed_cents'] for b in self.view()['summary']['balances']))

    def test_failed_claim_audit_rolls_back_binding_payment_origin_and_status(self):
        from unittest import mock
        c=self.issue();self.assertEqual(self.request_claim(c)[0],200)
        with storage.connect(server.DB) as db:before=dict(db.execute('SELECT * FROM attendees WHERE id=?',(self.person['id'],)).fetchone())
        with mock.patch('qgroup_core.audit.append',side_effect=sqlite3.IntegrityError('injected claim audit')):
            self.assertEqual(self.decide(c)[0],500)
        with storage.connect(server.DB) as db:
            self.assertEqual(dict(db.execute('SELECT * FROM attendees WHERE id=?',(self.person['id'],)).fetchone()),before)
            self.assertFalse(db.execute('SELECT 1 FROM attendee_payment_origins WHERE attendee_id=?',(self.person['id'],)).fetchone())
            self.assertEqual(db.execute('SELECT status FROM attendee_claims WHERE id=?',(c['id'],)).fetchone()[0],'requested')
        self.assertEqual(self.decide(c)[0],200)


    def test_original_payer_remains_notifiable_after_all_guests_claim(self):
        c=self.issue(self.person);self.request_claim(c);self.decide(c)
        c=self.issue(self.second);self.request_claim(c,self.stranger);self.decide(c)
        self.invoice()
        self.assertIn(self.b,self.view(self.manager)['reportable_ids'])
        with storage.connect(server.DB) as db:
            uid=db.execute('SELECT payer_user_id FROM attendee_payment_origins WHERE attendee_id=?',(self.second['id'],)).fetchone()[0]
            before=db.execute('SELECT COUNT(*) FROM notifications WHERE user_id=?',(uid,)).fetchone()[0]
        self.post({**self.tx(),'payer_id':self.b})
        with storage.connect(server.DB) as db:self.assertGreater(db.execute('SELECT COUNT(*) FROM notifications WHERE user_id=?',(uid,)).fetchone()[0],before)
