"""Named admins can assist published arrangements without acquiring owner/cohost rights."""
import hashlib
import json
import os
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import server
from test_api import Client
from test_roster import ModernClient


class AdminEventTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join()

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        server.DB=Path(self.tmp.name)/'admin-events.sqlite3';server.initialize();server.LIMITS.clear()
        key='admin-event-test-key-'+'x'*32
        env=mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':hashlib.sha256(key.encode()).hexdigest()})
        env.start();self.addCleanup(env.stop)
        self.owner=ModernClient(self.base).identify('活动发起者')
        self.admin=ModernClient(self.base).identify('协助管理员')
        self.member=ModernClient(self.base).identify('普通成员')
        self.bootstrap=ModernClient(self.base)
        self.assertEqual(self.bootstrap.request('/api/admin/login','POST',dict(key=key))[0],200)
        self.csrf=self.bootstrap.request('/api/admin/session')[1]['csrf']
        with server.connect() as db:
            self.admin_id=db.execute("SELECT id FROM users WHERE nickname='协助管理员'").fetchone()[0]
            self.owner_id=db.execute("SELECT id FROM users WHERE nickname='活动发起者'").fetchone()[0]
        self.assertEqual(self.role(True)[0],200)
        start=datetime.now(timezone.utc)+timedelta(days=3)
        self.data=dict(title='原活动',category='约K',location='原门店',starts_at=start.isoformat(timespec='seconds'),
            deadline=start.isoformat(timespec='seconds'),duration_hours=6,capacity=8,description='原说明',fee_policy='按原约定 AA')
        status,self.event=self.owner.request('/api/events','POST',self.data);self.assertEqual(status,201,self.event)
        self.url='/api/events/'+self.event['id']

    def role(self,value,revision=0):
        return self.bootstrap.request('/api/admin/users','POST',dict(user_id=self.admin_id,is_admin=value,base_revision=revision),headers={'X-Kanban-Admin':self.csrf})

    def fresh(self,client=None):
        status,e=(client or self.admin).request(self.url);self.assertEqual(status,200,e);return e

    def body(self,**changes):
        e=self.fresh()
        fields=('title','category','location','starts_at','deadline','duration_hours','capacity','description',
                'withdrawal_deadline','timezone','minimum_participants','fee_policy','visibility','bot_enabled')
        return dict({key:e[key] for key in fields},base_revision=e['revision'],**changes)

    def edit(self,client=None,**changes):
        return (client or self.admin).request(self.url,'PATCH',self.body(**changes))

    def test_admin_edit_capability_is_separate_from_every_other_scope(self):
        e=self.fresh()
        self.assertTrue(e['can_assist_schedule']);self.assertTrue(e['can_edit_schedule'])
        for name in ('is_owner','is_cohost','can_finish','can_settle','can_manage_roster','can_attendance','can_onsite'):
            self.assertFalse(e[name],name)
        self.assertEqual(e['management_scopes'],[])
        ordinary=self.fresh(self.member)
        self.assertFalse(ordinary['can_assist_schedule']);self.assertFalse(ordinary['can_edit_schedule'])
        listed=self.admin.request('/api/events')[1]['events']
        self.assertTrue(next(row for row in listed if row['id']==e['id'])['can_edit_schedule'])

    def test_admin_schedule_change_keeps_owner_and_agreements_and_audits_real_actor(self):
        before=self.fresh();start=(datetime.fromisoformat(before['starts_at'])+timedelta(days=1)).isoformat(timespec='seconds')
        status,after=self.edit(title='更正后的通宵活动',location='新门店',description='核对后的说明',
            starts_at=start,deadline=start,withdrawal_deadline=start,reason='与发起者核对，原凌晨日期选错')
        self.assertEqual(status,200,after);self.assertEqual(after['title'],'更正后的通宵活动')
        self.assertEqual(after['location'],'新门店');self.assertEqual(after['starts_at'],start)
        self.assertEqual(after['conditions_version'],before['conditions_version']+1)
        self.assertEqual(after['confirmed_count'],1);self.assertFalse(after['is_owner']);self.assertEqual(after['my_attendees'],[])
        self.assertEqual(after['participants'][0]['confirmation_state'],'pending')
        self.assertEqual(after['participants'][0]['accepted_conditions_version'],before['conditions_version'])
        with server.connect() as db:
            e=db.execute('SELECT * FROM events WHERE id=?',(after['id'],)).fetchone();self.assertEqual(e['owner_id'],self.owner_id)
            row=db.execute('SELECT * FROM event_audit WHERE event_id=? ORDER BY version DESC LIMIT 1',(after['id'],)).fetchone()
            self.assertEqual(row['action'],'event_admin_updated');self.assertEqual(row['actor_id'],self.admin_id)
            self.assertEqual(row['actor_name'],'协助管理员');self.assertIn('原凌晨日期选错',row['reason'])
            self.assertEqual(json.loads(row['before_json'])['event']['location'],'原门店')
            self.assertEqual(json.loads(row['after_json'])['event']['location'],'新门店')
            self.assertEqual(db.execute('SELECT count(*) FROM event_roles WHERE event_id=?',(after['id'],)).fetchone()[0],0)
            self.assertEqual(db.execute("SELECT count(*) FROM notifications WHERE event_id=? AND user_id=? AND kind='admin_event_updated'",(after['id'],self.owner_id)).fetchone()[0],1)
        self.assertTrue(any(n['kind']=='conditions_changed' for n in self.owner.request('/api/notifications')[1]['notifications']))
        history=self.owner.request(self.url+'/history')[1]
        self.assertIn('event_admin_updated',str(history));self.assertNotIn(self.admin_id,str(history))

    def test_title_only_change_requires_reason_but_does_not_change_participant_agreement(self):
        self.assertEqual(self.edit(title='仅改标题')[0],400)
        before=self.fresh()
        status,after=self.edit(title='仅改标题',reason='更正活动名称');self.assertEqual(status,200,after)
        self.assertEqual(after['conditions_version'],before['conditions_version'])
        self.assertEqual(after['participants'][0]['confirmation_state'],'accepted')
        with server.connect() as db:
            count=db.execute("SELECT count(*) FROM notifications WHERE event_id=? AND kind='admin_event_updated'",(after['id'],)).fetchone()[0]
        status,unchanged=self.edit(reason='核对，无需变更');self.assertEqual(status,200,unchanged)
        self.assertEqual(unchanged['revision'],after['revision'])
        with server.connect() as db:self.assertEqual(db.execute("SELECT count(*) FROM notifications WHERE event_id=? AND kind='admin_event_updated'",(after['id'],)).fetchone()[0],count)

    def test_unprivileged_or_credential_only_clients_cannot_edit(self):
        body=self.body(title='越权修改',reason='无权限')
        self.assertEqual(self.member.request(self.url,'PATCH',{**body,'is_admin':True,'can_assist_schedule':True})[0],403)
        self.assertEqual(ModernClient(self.base).request(self.url,'PATCH',body)[0],401)
        self.assertEqual(self.bootstrap.request(self.url,'PATCH',body)[0],401)
        self.assertEqual(self.fresh()['title'],'原活动')

    def test_revocation_rechecks_current_role_and_cached_response(self):
        body=self.body(title='第一次协助',reason='核对名称');key=uuid.uuid4().hex
        status,after=self.admin.request(self.url,'PATCH',body,headers={'Idempotency-Key':key});self.assertEqual(status,200,after)
        self.assertEqual(self.role(False,1)[0],200)
        self.assertFalse(self.fresh()['can_edit_schedule'])
        status,replay=self.admin.request(self.url,'PATCH',body,headers={'Idempotency-Key':key})
        self.assertEqual(status,200);self.assertFalse(replay['can_assist_schedule']);self.assertEqual(replay['revision'],after['revision'])
        self.assertEqual(self.edit(title='撤销后修改',reason='不应生效')[0],403)

    def test_other_actions_and_owner_fields_remain_protected(self):
        for action in ('pause','resume','start','finish','cancel','archive','unarchive','publish','formation','bot_sync','bot_retry'):
            with self.subTest(action=action):
                self.assertEqual(self.admin.request(self.url,'PATCH',dict(action=action,base_revision=self.fresh()['revision'],reason='越权操作',bot_enabled=True,outbox_id=1))[0],403)
        for changes in (dict(fee_policy='改费用'),dict(visibility='invitation'),dict(bot_enabled=True),
                        dict(withdrawal_deadline=(datetime.fromisoformat(self.event['starts_at'])-timedelta(hours=1)).isoformat(timespec='seconds'))):
            with self.subTest(changes=changes):self.assertEqual(self.edit(reason='不能越权',**changes)[0],403)
        self.assertEqual(self.admin.request(self.url+'/management/invitations','POST',dict(base_revision=self.fresh()['revision'],kind='transfer',target_name='接任人',reason='越权'))[0],403)

    def test_existing_custom_withdrawal_deadline_is_preserved(self):
        custom=(datetime.fromisoformat(self.event['starts_at'])-timedelta(hours=2)).isoformat(timespec='seconds')
        status,e=self.owner.request(self.url,'PATCH',self.body(withdrawal_deadline=custom,reason='设定单独退出期限'));self.assertEqual(status,200,e)
        start=(datetime.fromisoformat(e['starts_at'])+timedelta(days=1)).isoformat(timespec='seconds')
        status,after=self.edit(starts_at=start,deadline=start,reason='协助更正开始日期');self.assertEqual(status,200,after)
        self.assertEqual(after['withdrawal_deadline'],custom)
        self.assertEqual(self.edit(withdrawal_deadline=start,reason='不能替换自定义约定')[0],403)

    def test_drafts_private_and_terminal_events_keep_existing_access_boundaries(self):
        for mode in ('draft','invitation'):
            status,e=self.owner.request('/api/events','POST',{**self.data,**({'lifecycle':'draft'} if mode=='draft' else {'visibility':'invitation'})})
            self.assertEqual(status,201,e);path='/api/events/'+e['id']
            self.assertEqual(self.admin.request(path)[0],404)
            self.assertEqual(self.admin.request(path,'PATCH',dict(self.data,base_revision=e['revision'],reason='不可越权查看'))[0],404)
        e=self.fresh();status,ended=self.owner.request(self.url,'PATCH',dict(action='finish',base_revision=e['revision']));self.assertEqual(status,200,ended)
        self.assertFalse(self.fresh()['can_assist_schedule']);self.assertFalse(self.fresh()['can_edit_schedule'])
        self.assertEqual(self.edit(title='结束后不能重写',reason='锁定')[0],403)

    def test_revision_and_modern_protocol_are_required(self):
        body=self.body(title='改名称',reason='核对');body['base_revision']-=1
        self.assertEqual(self.admin.request(self.url,'PATCH',body)[0],409)
        body=self.body(title='改名称',reason='核对')
        self.assertEqual(self.admin.request(self.url,'PATCH',body,headers={'X-Kanban-Version':'1'})[0],409)
        self.assertEqual(self.admin.request(self.url,'PATCH',body,headers={'Idempotency-Key':''})[0],400)
        self.assertEqual(Client.request(self.admin,self.url,'PATCH',body,headers={'X-Kanban-Version':'2'})[0],409)

    def test_audit_failure_rolls_back_the_edit_agreements_and_notifications(self):
        before=self.fresh()
        with server.connect() as db:
            count=db.execute('SELECT count(*) FROM notifications').fetchone()[0]
            db.execute("CREATE TRIGGER fail_admin_edit BEFORE INSERT ON event_audit WHEN NEW.action='event_admin_updated' BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertLogs(level='ERROR'):self.assertEqual(self.edit(location='不应保存',reason='测试回滚')[0],500)
        after=self.fresh();self.assertEqual(after['location'],before['location']);self.assertEqual(after['revision'],before['revision'])
        self.assertEqual(after['conditions_version'],before['conditions_version']);self.assertEqual(after['participants'][0]['confirmation_state'],'accepted')
        with server.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM notifications').fetchone()[0],count)


if __name__=='__main__':unittest.main()
