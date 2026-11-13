import base64
import concurrent.futures
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
from test_api import test_png
from test_roster import ModernClient


class ActivityFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        server.DB=Path(cls.tmp.name)/'activity.sqlite3'
        server.initialize()
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
        self.other=ModernClient(self.base).identify('另一位')
        start=datetime.now(timezone.utc)+timedelta(days=2)
        self.data=dict(title='活动流程',category='约K',location='旧门店',starts_at=start.isoformat(timespec='seconds'),
            deadline=(start-timedelta(hours=1)).isoformat(timespec='seconds'),duration_hours=3,capacity=3,description='',join_owner=False)
        status,self.event=self.owner.request('/api/events','POST',self.data);self.assertEqual(status,201)
        self.url='/api/events/'+self.event['id']

    def fresh(self,client=None):
        status,e=(client or self.owner).request(self.url);self.assertEqual(status,200);return e

    def action(self,action,client=None,**extra):
        e=self.fresh(client)
        return (client or self.owner).request(self.url,'PATCH',dict(action=action,base_revision=e['revision'],**extra))

    def edit(self,client=None,**extra):
        e=self.fresh(client)
        fields=['title','category','location','starts_at','deadline','duration_hours','capacity','description','withdrawal_deadline','timezone','minimum_participants','fee_policy','visibility']
        data={key:e[key] for key in fields}
        data.update(base_revision=e['revision'],**extra)
        return (client or self.owner).request(self.url,'PATCH',data)

    def signup(self,client,people):
        e=self.fresh(client)
        body=dict(people=people,base_revision=e['revision'])
        status,preview=client.request(self.url+'/roster/preview','POST',body);self.assertEqual(status,200,preview)
        status,e=client.request(self.url+'/roster/parties','POST',{**body,**preview,'accept_partial':True});self.assertEqual(status,200,e)
        return e

    def invite(self,kind='cohost',permissions=None,attendee_id=None):
        body=dict(kind=kind,permissions=permissions or ['attendance'],target_name='接任者',reason='分担现场管理',base_revision=self.fresh()['revision'])
        if attendee_id:body['attendee_id']=attendee_id
        status,e=self.owner.request(self.url+'/management/invitations','POST',body);self.assertEqual(status,200,e)
        return e,e['pending_management'][-1]['token']

    def accept_role(self,client,token,**extra):
        status,info=client.request(self.url+'/management/invitations/'+token);self.assertEqual(status,200,info)
        return client.request(self.url+'/management/invitations/'+token+'/accept','POST',dict(base_revision=info['base_revision'],accept_responsibility=True,**extra))

    def consent(self,client,person,decision='accepted',**extra):
        e=self.fresh(client)
        return client.request(self.url+'/attendees/'+person['id']+'/conditions','PATCH',dict(base_revision=e['revision'],conditions_version=e['conditions_version'],decision=decision,**extra))

    def test_p1_cached_response_replay_refreshes_schema_without_reexecuting(self):
        request_key=uuid.uuid4().hex
        status,event=self.owner.request('/api/events','POST',self.data,headers={'Idempotency-Key':request_key})
        self.assertEqual(status,201)
        with sqlite3.connect(server.DB) as db:
            row=db.execute('SELECT user_id,response_json FROM request_results WHERE request_key=?',(request_key,)).fetchone()
            old=json.loads(row[1]);old.pop('lifecycle')
            db.execute('UPDATE request_results SET response_json=? WHERE request_key=?',(json.dumps(old),request_key))
            count=db.execute('SELECT count(*) FROM events').fetchone()[0]
        status,replayed=self.owner.request('/api/events','POST',self.data,headers={'Idempotency-Key':request_key})
        self.assertEqual(status,201);self.assertEqual(replayed['id'],event['id'])
        self.assertEqual(replayed['lifecycle'],'scheduled')
        with sqlite3.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],count)

    def test_rehearsal_compares_all_rows_with_consistent_sqlite_row_types(self):
        from deploy.verify_migration import verify
        self.signup(self.manager,[dict(is_self=True)])
        with tempfile.TemporaryDirectory() as folder:
            counts=verify(server.DB,Path(folder)/'rehearsal.sqlite3')
        self.assertGreater(counts['attendees'],0)
        self.assertIn('request_results',counts)
        self.assertIn('event_conditions',counts)

    def test_private_cohost_acceptance_grants_access_without_general_share_link(self):
        self.assertEqual(self.edit(visibility='invitation')[0],200)
        self.assertEqual(self.other.request(self.url)[0],404)
        _,token=self.invite(permissions=['attendance'])
        status,e=self.accept_role(self.other,token)
        self.assertEqual(status,200);self.assertTrue(e['is_cohost'])
        self.assertEqual(self.other.request(self.url)[0],200)
        self.assertIsNone(e.get('share_token'))
        self.assertEqual(e['pending_management'],[])

    def test_repeated_cancel_and_formation_do_not_duplicate_notifications(self):
        self.signup(self.manager,[dict(is_self=True)])
        self.assertEqual(self.action('formation')[0],200)
        with sqlite3.connect(server.DB) as db:
            first=db.execute('SELECT count(*) FROM notifications WHERE event_id=?',(self.event['id'],)).fetchone()[0]
        self.assertEqual(self.action('formation')[0],200)
        with sqlite3.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM notifications WHERE event_id=?',(self.event['id'],)).fetchone()[0],first)
        self.assertEqual(self.action('cancel',reason='门店停业')[0],200)
        with sqlite3.connect(server.DB) as db:
            first=db.execute('SELECT count(*) FROM notifications WHERE event_id=?',(self.event['id'],)).fetchone()[0]
        self.assertEqual(self.action('cancel',reason='门店停业')[0],200)
        with sqlite3.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM notifications WHERE event_id=?',(self.event['id'],)).fetchone()[0],first)

    def test_draft_only_visible_to_managers_and_publish_uses_latest_arrangement(self):
        status,draft=self.owner.request('/api/events','POST',{**self.data,'lifecycle':'draft','join_owner':True})
        self.assertEqual(status,201);self.url='/api/events/'+draft['id']
        self.assertEqual(draft['confirmed_count'],0);self.assertFalse(draft['can_join'])
        self.assertEqual(self.other.request(self.url)[0],404)
        self.assertNotIn(draft['id'],[e['id'] for e in self.other.request('/api/events')[1]['events']])
        status,edited=self.edit(location='草稿新门店',fee_policy='明确 AA 规则')
        self.assertEqual(status,200);self.assertEqual(edited['conditions']['arrangement']['location'],'草稿新门店')
        status,published=self.action('publish');self.assertEqual(status,200)
        self.assertEqual(published['confirmed_count'],1)
        self.assertEqual(published['conditions']['arrangement']['fee_policy'],'明确 AA 规则')
        self.assertEqual(self.other.request(self.url)[0],200)
        self.assertEqual(len(self.owner.request(self.url+'/conditions')[1]['versions']),1)

    def test_legacy_draft_registers_owner_on_publish_and_edit_does_not_rejoin(self):
        status,draft=self.owner.request('/api/events','POST',{**self.data,'lifecycle':'draft','join_owner':False})
        self.assertEqual(status,201)
        self.assertEqual(draft['confirmed_count'],0)
        self.url='/api/events/'+draft['id']
        status,published=self.action('publish')
        self.assertEqual(status,200)
        self.assertEqual(published['confirmed_count'],1)
        self.assertTrue(published['my_registration']['is_me'])
        self.assertEqual(self.action('publish')[0],409)
        e=self.fresh()
        self.assertEqual(len(e['participants']),1)
        person=e['my_registration']
        status,withdrawn=self.owner.request(self.url+'/attendees/'+person['id'],'DELETE',{'base_revision':e['revision']})
        self.assertEqual(status,200)
        self.assertEqual(withdrawn['confirmed_count'],0)
        status,edited=self.edit(title='更新標題')
        self.assertEqual(status,200)
        self.assertEqual(edited['confirmed_count'],0)
        self.assertIsNone(edited['my_registration'])

    def test_legacy_draft_past_deadline_cannot_publish_without_owner_registration(self):
        status,draft=self.owner.request('/api/events','POST',{**self.data,'lifecycle':'draft','join_owner':False})
        self.assertEqual(status,201)
        self.url='/api/events/'+draft['id']
        with sqlite3.connect(server.DB) as db:
            db.execute('UPDATE events SET deadline=? WHERE id=?',((datetime.now(timezone.utc)-timedelta(hours=1)).isoformat(),draft['id']))
        status,result=self.action('publish')
        self.assertEqual(status,409)
        unchanged=self.fresh()
        self.assertEqual(unchanged['lifecycle'],'draft')
        self.assertEqual(unchanged['confirmed_count'],0)

    def test_elapsed_planned_end_does_not_end_activity_or_allow_bill_and_can_extend(self):
        start=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat(timespec='seconds')
        with sqlite3.connect(server.DB) as db:db.execute('UPDATE events SET starts_at=?,deadline=?,duration_hours=1 WHERE id=?',(start,start,self.event['id']))
        e=self.fresh();self.assertTrue(e['estimated_over']);self.assertFalse(e['has_ended']);self.assertFalse(e['can_settle'])
        self.assertEqual(e['phase'],'ongoing');self.assertTrue(e['can_finish'])
        self.assertEqual(self.owner.request(self.url+'/settlement','PUT',dict(base_revision=e['revision'],base_version=0,total_amount='10',headcount=1))[0],409)
        status,extended=self.edit(duration_hours=4,reason='现场续唱两小时')
        self.assertEqual(status,200);self.assertFalse(extended['estimated_over']);self.assertFalse(extended['has_ended'])
        self.assertIsNone(extended['actual_ended_at'])

    def test_actual_start_end_preserve_planned_schedule_and_lock_later_edits(self):
        status,started=self.action('start');self.assertEqual(status,200)
        self.assertTrue(started['actual_started_at']);self.assertFalse(started['can_join'])
        status,ended=self.action('finish');self.assertEqual(status,200)
        self.assertTrue(ended['actual_ended_at']);self.assertTrue(ended['can_settle'])
        self.assertEqual(ended['starts_at'],self.event['starts_at']);self.assertEqual(ended['ends_at'],self.event['ends_at'])
        self.assertEqual(self.edit(location='不能再改')[0],409)
        self.assertEqual(self.action('resume')[0],409)
        revision=ended['revision'];self.assertEqual(self.action('finish')[1]['revision'],revision)

    def test_timezone_validation_and_minimum_do_not_auto_cancel(self):
        self.assertEqual(self.edit(timezone='Mars/Crater')[0],400)
        self.assertEqual(self.edit(minimum_participants=4)[0],400)
        status,e=self.edit(timezone='Asia/Tokyo',minimum_participants=2)
        self.assertEqual(status,200);self.assertFalse(e['minimum_met']);self.assertEqual(e['lifecycle'],'scheduled')
        self.assertEqual(self.action('formation')[0],400)
        status,e=self.action('formation',reason='人数不足也照常唱');self.assertEqual(status,200)
        self.assertEqual(e['formation_state'],'confirmed');self.assertTrue(e['can_join'])
        self.assertEqual(self.action('formation',client=self.manager,reason='不能代为决定')[0],403)

    def test_single_notes_merge_preserves_legacy_fee_agreement(self):
        notes='集合原文 后台後臺';fee='原费用约定：每人 100'
        self.assertEqual(self.edit(description=notes,fee_policy=fee)[0],200)
        accepted=self.signup(self.manager,[{'is_self':True}])
        status,changed=self.edit(description=notes+'\n\n'+fee,fee_policy='',reason='合并至注意事项统一编辑')
        self.assertEqual(status,200,changed)
        self.assertEqual(changed['fee_policy'],'')
        self.assertEqual(changed['description'],notes+'\n\n'+fee)
        self.assertEqual(changed['conditions_version'],accepted['conditions_version']+1)
        self.assertEqual(changed['pending_confirmation_count'],1)
        status,history=self.manager.request(self.url+'/conditions')
        self.assertEqual(status,200)
        self.assertEqual(history['versions'][1]['arrangement']['fee_policy'],fee)
        self.assertEqual(history['versions'][1]['arrangement']['description'],notes)
        self.assertEqual(changed['participants'][0]['accepted_conditions_version'],accepted['conditions_version'])

    def test_important_changes_preserve_original_agreements_and_require_individual_responses(self):
        first=self.signup(self.manager,[{'is_self':True},{'name':'同行'}]);people=first['my_attendees']
        self.assertEqual(self.edit(fee_policy='新费用规则')[0],400)
        status,changed=self.edit(location='新门店',fee_policy='另加饮料费',reason='原门店停业，重新确认')
        self.assertEqual(status,200);self.assertEqual(changed['conditions_version'],2)
        self.assertEqual(changed['confirmed_count'],2);self.assertEqual(changed['pending_confirmation_count'],2)
        self.assertTrue(all(p['accepted_conditions_version']==1 for p in changed['participants']))
        self.assertEqual(self.consent(self.owner,people[0])[0],403)
        self.assertEqual(self.consent(self.manager,people[0],'declined')[0],400)
        status,declined=self.consent(self.manager,people[0],'declined',reason='不接受新增饮料费')
        self.assertEqual(status,200);self.assertEqual(declined['confirmed_count'],2)
        rejected=next(p for p in declined['participants'] if p['id']==people[0]['id'])
        self.assertEqual(rejected['accepted_conditions_version'],1)
        self.assertEqual(self.consent(self.manager,people[1])[0],200)
        versions=self.manager.request(self.url+'/conditions')[1]['versions']
        self.assertEqual(versions[1]['arrangement']['location'],'旧门店');self.assertEqual(versions[1]['arrangement']['fee_policy'],'')
        status,_=self.edit(fee_policy='再次调价',reason='再次征询同意');self.assertEqual(status,200)
        self.assertEqual(self.fresh()['pending_confirmation_count'],2)
        with server.connect() as db:
            consents=db.execute('SELECT version,decision FROM attendee_consents WHERE event_id=? ORDER BY id',(self.event['id'],)).fetchall()
            self.assertEqual([tuple(c) for c in consents],[(1,'accepted'),(1,'accepted'),(2,'declined'),(2,'accepted')])

    def test_conditions_response_is_versioned_idempotent_and_cannot_rewrite_history(self):
        p=self.signup(self.manager,[{'is_self':True}])['my_registration']
        self.edit(location='新地址',reason='换场地')
        e=self.fresh();path=self.url+'/attendees/'+p['id']+'/conditions'
        body=dict(base_revision=e['revision'],conditions_version=e['conditions_version'],decision='accepted')
        key=uuid.uuid4().hex
        first=self.manager.request(path,'PATCH',body,{'Idempotency-Key':key});self.assertEqual(first[0],200)
        self.assertEqual(first,self.manager.request(path,'PATCH',body,{'Idempotency-Key':key}))
        self.assertEqual(self.manager.request(path,'PATCH',body)[0],409)
        with server.connect() as db:
            for table in ('event_conditions','attendee_consents'):
                for verb in ('UPDATE','DELETE'):
                    sql=('UPDATE '+table+" SET created_at='tamper'" if verb=='UPDATE' else 'DELETE FROM '+table)+' WHERE event_id=?'
                    with self.assertRaises(sqlite3.IntegrityError):db.execute(sql,(self.event['id'],))

    def test_legacy_and_stale_pages_cannot_accept_unseen_new_fees(self):
        self.edit(fee_policy='每人另付饮料费')
        e=self.fresh()
        self.assertEqual(self.manager.request(self.url+'/registration','PUT',{}, {'X-Kanban-Version':'1'})[0],409)
        self.assertEqual(self.manager.request(self.url+'/registration','PUT',dict(base_revision=e['revision']))[0],409)
        self.assertEqual(self.manager.request(self.url+'/roster/preview','POST',dict(people=[{'is_self':True}]))[0],409)
        status,joined=self.manager.request(self.url+'/registration','PUT',dict(base_revision=e['revision'],conditions_version=e['conditions_version']))
        self.assertEqual(status,200);self.assertEqual(joined['my_registration']['accepted_conditions_version'],e['conditions_version'])

    def test_attendance_cohost_can_only_use_granted_scope_and_owner_can_revoke(self):
        self.signup(self.manager,[{'is_self':True}])
        _,token=self.invite(permissions=['attendance'])
        status,e=self.accept_role(self.manager,token);self.assertEqual(status,200);self.assertTrue(e['is_cohost']);self.assertFalse(e['is_owner'])
        self.assertEqual(self.edit(client=self.manager,location='越权')[0],403)
        self.assertEqual(self.action('finish',client=self.manager)[0],403)
        self.assertEqual(self.manager.request(self.url+'/management/invitations','POST',dict(base_revision=e['revision'],kind='transfer',target_name='别人',reason='越权'))[0],403)
        self.action('start');e=self.fresh(self.manager);p=e['participants'][0]
        status,_=self.manager.request(self.url+'/attendance/'+p['id'],'PATCH',dict(base_revision=e['revision'],attendance='present'))
        self.assertEqual(status,200)
        self.action('finish');e=self.fresh(self.manager)
        self.assertEqual(self.manager.request(self.url+'/settlement','PUT',dict(base_revision=e['revision'],base_version=0,total_amount='10',headcount=1))[0],403)
        role=e['cohosts'][0]
        status,_=self.owner.request(self.url+'/management/roles/'+role['id'],'DELETE',dict(base_revision=e['revision'],reason='现场工作已结束'))
        self.assertEqual(status,200);self.assertFalse(self.fresh(self.manager)['is_cohost'])

    def test_schedule_cohost_cannot_change_fee_privacy_or_cancel(self):
        self.signup(self.other,[{'is_self':True}])
        _,token=self.invite(permissions=['schedule'])
        self.assertEqual(self.accept_role(self.manager,token)[0],200)
        for extra in [dict(fee_policy='新价'),dict(visibility='invitation'),dict(withdrawal_deadline=(datetime.now(timezone.utc)+timedelta(hours=3)).isoformat())]:
            self.assertEqual(self.edit(client=self.manager,reason='尝试修改',**extra)[0],403)
        self.assertEqual(self.action('cancel',client=self.manager,reason='没有取消权限')[0],403)
        self.assertEqual(self.edit(client=self.manager,location='协办确认的新店',reason='现场调整')[0],200)
        self.assertEqual(self.fresh()['pending_confirmation_count'],1)

    def test_transfer_requires_recipient_acceptance_and_revokes_old_owner_grants(self):
        person=self.signup(self.manager,[{'is_self':True}])['my_registration']
        _,old_invite=self.invite(permissions=['schedule'])
        invited,token=self.invite(kind='transfer',attendee_id=person['id'])
        self.assertTrue(self.fresh()['is_owner']);self.assertFalse(self.fresh(self.manager)['is_owner'])
        self.assertEqual(self.other.request(self.url+'/management/invitations/'+token)[0],403)
        info=self.manager.request(self.url+'/management/invitations/'+token)[1]
        path=self.url+'/management/invitations/'+token+'/accept'
        self.assertEqual(self.manager.request(path,'POST',dict(base_revision=info['base_revision']))[0],400)
        key=uuid.uuid4().hex;body=dict(base_revision=info['base_revision'],accept_responsibility=True)
        status,transferred=self.manager.request(path,'POST',body,{'Idempotency-Key':key})
        self.assertEqual(status,200);self.assertTrue(transferred['is_owner'])
        self.assertEqual(transferred['owner_name'],'代报者');self.assertFalse(self.fresh()['is_owner']);self.assertFalse(self.fresh()['is_cohost'])
        self.assertEqual(self.action('cancel',reason='原发起者不能再管理')[0],403)
        self.assertEqual(self.other.request(self.url+'/management/invitations/'+old_invite)[0],404)
        self.assertEqual(self.manager.request(path,'POST',body,{'Idempotency-Key':key})[0],200)
        history=json.dumps(self.manager.request(self.url+'/history')[1])
        self.assertNotIn(token,history);self.assertNotIn(old_invite,history)

    def test_unbound_cohost_need_not_attend_and_expired_or_revoked_links_fail(self):
        _,token=self.invite(permissions=['roster'])
        self.assertEqual(self.accept_role(self.manager,token)[0],200)
        self.assertEqual(self.fresh()['confirmed_count'],0)
        invited,expired=self.invite()
        with sqlite3.connect(server.DB) as db:db.execute('UPDATE management_invitations SET expires_at=? WHERE token=?',('2000-01-01',expired))
        self.assertEqual(self.other.request(self.url+'/management/invitations/'+expired)[0],404)
        invited,revoked=self.invite()
        pending=next(i for i in invited['pending_management'] if i['token']==revoked)
        self.assertEqual(self.owner.request(self.url+'/management/invitations/'+pending['id'],'DELETE',dict(base_revision=invited['revision'],reason='改由别人协助'))[0],200)
        self.assertEqual(self.other.request(self.url+'/management/invitations/'+revoked)[0],404)

    def test_attendance_is_separate_from_headcount_and_post_end_corrections_need_reason(self):
        p=self.signup(self.manager,[{'is_self':True},{'name':'同行'}])['my_registration']
        e=self.fresh();path=self.url+'/attendance/'+p['id']
        self.assertEqual(self.owner.request(path,'PATCH',dict(base_revision=e['revision'],attendance='absent'))[0],409)
        self.action('start');e=self.fresh()
        status,marked=self.owner.request(path,'PATCH',dict(base_revision=e['revision'],attendance='absent',attendance_note='临时未到'))
        self.assertEqual(status,200);self.assertEqual(marked['confirmed_count'],2)
        self.action('finish');e=self.fresh()
        self.assertEqual(self.owner.request(path,'PATCH',dict(base_revision=e['revision'],attendance='late'))[0],400)
        status,corrected=self.owner.request(path,'PATCH',dict(base_revision=e['revision'],attendance='late',reason='已与本人核对，实际迟到'))
        self.assertEqual(status,200)
        status,bill=self.owner.request(self.url+'/settlement','PUT',dict(base_revision=corrected['revision'],base_version=0,total_amount='100'))
        self.assertEqual(status,200);self.assertEqual(bill['settlement']['headcount'],2)
        status,changed=self.owner.request(path,'PATCH',dict(base_revision=bill['revision'],attendance='left',reason='补记早退'))
        self.assertEqual(status,200);self.assertEqual(changed['settlement'],bill['settlement'])
        future=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
        self.assertEqual(self.owner.request(path,'PATCH',dict(base_revision=changed['revision'],attendance='present',arrived_at=future,reason='无效未来时间'))[0],400)

    def test_onsite_addition_requires_explicit_capacity_queue_and_fee_acknowledgements(self):
        self.signup(self.manager,[{'name':'甲'},{'name':'乙'},{'name':'丙'},{'name':'候补'}])
        self.action('start');e=self.fresh()
        body=dict(base_revision=e['revision'],conditions_version=e['conditions_version'],people=[{'name':'现场朋友'}],reason='现场核对后临时加入')
        path=self.url+'/onsite'
        self.assertEqual(self.owner.request(path,'POST',body)[0],400)
        body['accept_terms']=True;self.assertEqual(self.owner.request(path,'POST',body)[0],409)
        body['allow_over_capacity']=True;self.assertEqual(self.owner.request(path,'POST',body)[0],409)
        body['override_waitlist']=True
        status,added=self.owner.request(path,'POST',body);self.assertEqual(status,200)
        self.assertEqual(added['confirmed_count'],4);self.assertEqual(added['waiting_count'],1)
        p=next(p for p in added['participants'] if p['nickname']=='现场朋友')
        self.assertEqual(p['attendance'],'present');self.assertEqual(p['accepted_conditions_version'],e['conditions_version'])
        self.action('finish');ended=self.fresh()
        status,bill=self.owner.request(self.url+'/settlement','PUT',dict(base_revision=ended['revision'],base_version=0,total_amount='40'))
        self.assertEqual(status,200);self.assertEqual(bill['settlement']['headcount'],4)
        self.assertEqual(self.owner.request(path,'POST',{**body,'base_revision':bill['revision']})[0],409)

    def test_cancelled_event_can_settle_archive_and_correct_without_losing_history_or_images(self):
        self.signup(self.manager,[{'is_self':True}])
        self.assertEqual(self.action('cancel')[0],400)
        status,e=self.action('cancel',reason='活动取消，订金不退');self.assertEqual(status,200);self.assertTrue(e['can_settle'])
        status,bill=self.owner.request(self.url+'/settlement','PUT',dict(base_revision=e['revision'],base_version=0,total_amount='10',qr_image=base64.b64encode(test_png()).decode()))
        self.assertEqual(status,200)
        status,archived=self.action('archive');self.assertEqual(status,200);self.assertTrue(archived['archived_at'])
        self.assertEqual(self.other.request(self.url)[0],200)
        self.assertEqual(self.other.request(self.url+'/settlement/history')[1]['revisions'][0]['total_amount'],'10.00')
        with self.other.opener.open(self.base+self.url+'/settlement/history/1/payment-code') as response:self.assertEqual(response.read(),test_png())
        status,corrected=self.owner.request(self.url+'/settlement','PUT',dict(base_revision=archived['revision'],base_version=1,total_amount='8',note='店家退回部分订金'))
        self.assertEqual(status,200);self.assertEqual(corrected['settlement']['version'],2)
        self.assertEqual(self.action('unarchive')[0],200);self.assertEqual(self.action('resume')[0],409)
        self.assertEqual(self.owner.request(self.url,'PATCH',dict(base_revision=self.fresh()['revision'],status='deleted'))[0],409)

    def test_history_failure_rolls_back_changed_conditions_and_pending_confirmations(self):
        self.signup(self.manager,[{'is_self':True}]);before=self.fresh()
        with sqlite3.connect(server.DB) as db:db.execute("CREATE TRIGGER reject_flow_audit BEFORE INSERT ON event_audit BEGIN SELECT RAISE(ABORT,'injected'); END")
        try:
            with self.assertLogs(level='ERROR'):self.assertEqual(self.edit(location='不应保存',reason='模拟存储失败')[0],500)
            after=self.fresh();self.assertEqual(after['conditions_version'],before['conditions_version']);self.assertEqual(after['location'],before['location'])
            self.assertEqual(after['pending_confirmation_count'],0)
            self.assertEqual(len(self.owner.request(self.url+'/conditions')[1]['versions']),1)
        finally:
            with sqlite3.connect(server.DB) as db:db.execute('DROP TRIGGER reject_flow_audit')


class ActivityMigrationTests(unittest.TestCase):
    def test_version_one_migration_is_transactional_and_preserves_unknown_times(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'v1.sqlite3'
            original=server.storage.migrate_activity
            with mock.patch.object(server.storage,'migrate_activity',lambda db:None):server.storage.initialize(path)
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO users VALUES('owner','oldhash','旧发起者','2026-01-01')")
                db.execute("INSERT INTO browser_sessions VALUES('oldhash','owner','2026-01-01')")
                db.execute("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,duration_hours) VALUES('old','owner','旧活动','约K','旧店','2020-01-01T00:00:00+00:00','2020-01-01T00:00:00+00:00',0,'','open','2020-01-01',3)")
                columns=[r[1] for r in db.execute('PRAGMA table_info(events)')];before=db.execute('SELECT * FROM events').fetchone()
            def fail(db):original(db);raise RuntimeError('migration failure')
            with mock.patch.object(server.storage,'migrate_activity',fail):
                with self.assertRaises(RuntimeError):server.storage.initialize(path)
            with sqlite3.connect(path) as db:
                self.assertNotIn('lifecycle',[r[1] for r in db.execute('PRAGMA table_info(events)')])
                self.assertEqual(db.execute('SELECT version FROM schema_migrations').fetchall(),[(1,)])
            server.storage.initialize(path);server.storage.initialize(path)
            with server.storage.connect(path) as db:
                e=db.execute('SELECT * FROM events').fetchone();self.assertEqual(tuple(e[c] for c in columns),before)
                self.assertEqual(e['lifecycle'],'scheduled');self.assertIsNone(e['timezone']);self.assertIsNone(e['actual_ended_at'])
                self.assertEqual(db.execute('SELECT count(*) FROM event_conditions').fetchone()[0],1)
                self.assertEqual(db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0],17)
