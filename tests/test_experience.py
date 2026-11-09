import sqlite3
import unittest
import test_api as fixtures
from test_api import Client


class ExperienceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.ActivityTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixtures.ActivityTests.tearDownClass.__func__(cls)

    def setUp(self):
        fixtures.ActivityTests.setUp(self)

    def headers(self, key='p5-operation-key-0001'):
        return {'X-Kanban-Version':'2','Idempotency-Key':key,
                'X-Kanban-Identity':self.owner.request('/api/me')[1]['draft_scope']}

    def test_draft_scope_is_stable_through_rename_and_distinct_per_browser(self):
        scope=self.owner.request('/api/me')[1]['draft_scope']
        status,result=self.owner.request('/api/profile','POST',{'nickname':'新称呼'},self.headers())
        self.assertEqual(status,200)
        self.assertEqual(result['draft_scope'],scope)
        self.assertEqual(self.owner.request('/api/me')[1]['draft_scope'],scope)
        other=Client(self.base).identify('新称呼')
        self.assertNotEqual(other.request('/api/me')[1]['draft_scope'],scope)

    def test_identity_change_cannot_submit_old_form(self):
        other=Client(self.base).identify('另一个浏览器')
        self.assertEqual(other.request('/api/profile','POST',{'nickname':'不应写入'},self.headers())[0],409)
        self.assertEqual(other.request('/api/me')[1]['nickname'],'另一个浏览器')
        self.assertEqual(other.request('/api/requests/p5-operation-key-0001',headers=self.headers())[0],409)

    def test_query_then_retry_creation_has_one_business_result(self):
        key='p5-create-lost-response'
        query='/api/requests/'+key
        self.assertEqual(self.owner.request(query,headers=self.headers(key))[1],{'committed':False})
        status,created=self.owner.request('/api/events','POST',self.data,self.headers(key))
        self.assertEqual(status,201)
        status,found=self.owner.request(query,headers=self.headers(key))
        self.assertTrue(found['committed'])
        self.assertEqual(found['result']['id'],created['id'])
        self.assertEqual(self.owner.request('/api/events','POST',self.data,self.headers(key))[1]['id'],created['id'])
        with sqlite3.connect(server_db()) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events WHERE id=?',(created['id'],)).fetchone()[0],1)
        other=Client(self.base).identify('旁观者')
        self.assertEqual(other.request(query)[1],{'committed':False})
        self.assertEqual(Client(self.base).request(query)[0],401)

    def test_query_returns_current_roles_after_handover(self):
        key='p5-handover-query-key'
        _,created=self.owner.request('/api/events','POST',self.data,self.headers(key))
        other=Client(self.base).identify('接任者')
        with sqlite3.connect(server_db()) as db:
            new_id=db.execute('SELECT id FROM users WHERE nickname=?',('接任者',)).fetchone()[0]
            db.execute('UPDATE events SET owner_id=? WHERE id=?',(new_id,created['id']))
        status,found=self.owner.request('/api/requests/'+key)
        self.assertEqual(status,200)
        self.assertFalse(found['result']['is_owner'])
        self.assertFalse(found['result']['can_settle'])
        self.assertEqual(found['result']['owner_name'],'接任者')
        self.assertFalse(self.owner.request('/api/events','POST',self.data,self.headers(key))[1]['is_owner'])

    def test_query_rechecks_invitation_visibility(self):
        key='p5-private-query-key'
        _,created=self.owner.request('/api/events','POST',{**self.data,'visibility':'invitation'},self.headers(key))
        other=Client(self.base).identify('私有接任者')
        with sqlite3.connect(server_db()) as db:
            new_id=db.execute('SELECT id FROM users WHERE nickname=?',('私有接任者',)).fetchone()[0]
            db.execute('UPDATE events SET owner_id=? WHERE id=?',(new_id,created['id']))
            db.execute('DELETE FROM event_access WHERE event_id=?',(created['id'],))
        self.assertEqual(self.owner.request('/api/requests/'+key)[0],404)

    def test_invalid_keys_and_failed_commands_do_not_become_committed(self):
        self.assertEqual(self.owner.request('/api/requests/x')[0],400)
        key='p5-rejected-operation'
        self.assertEqual(self.owner.request('/api/events','POST',{**self.data,'capacity':-1},self.headers(key))[0],400)
        self.assertEqual(self.owner.request('/api/requests/'+key)[1],{'committed':False})


def server_db():
    import server
    return str(server.DB)
