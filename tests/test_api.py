import hashlib
import uuid
import concurrent.futures
import base64
import binascii
import http.cookiejar
import json
import sqlite3
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def test_png(rgb=b'\xff\xff\xff'):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00' + rgb)) + chunk(b'IEND', b'')


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, method='GET', data=None, headers=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type': 'application/json', 'Accept-Language':'zh-CN', **(headers or {})})
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def identify(self, name):
        status,me=self.request('/api/me');assert status==200
        if not me['authenticated']:
            # Explicit test fixture policy. Production defaults remain closed.
            with server.connect() as db:db.execute('UPDATE site_settings SET allow_name_registration=1 WHERE id=1')
            assert self.request('/api/register','POST',{'nickname':name,'confirm':True,'accept_privacy':True,'privacy_version':server.privacy.VERSION},headers={'X-Kanban-Version':'2','Idempotency-Key':uuid.uuid4().hex,'X-Kanban-Identity':me['draft_scope']})[0]==200
        else:assert self.request('/api/profile', 'POST', {'nickname': name})[0] == 200
        return self


class ActivityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB = Path(cls.tmp.name) / 'test.sqlite3'
        server.initialize()
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%s' % cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.owner = Client(self.base).identify('发起者')
        # Legacy queue/bill fixtures count invited participants only; default owner signup is covered in test_roster.
        self.data = dict(title='周末火锅', category='聚餐', location='地铁站集合', capacity=2, join_owner=False,
            starts_at=(datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            deadline=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), description='一起吃点好的')
        status, self.event = self.owner.request('/api/events', 'POST', self.data)
        self.assertEqual(status, 201)
        self.url = '/api/events/' + self.event['id']

    def test_concurrent_last_seat_and_promotion(self):
        clients = [Client(self.base).identify('朋友%d' % i) for i in range(8)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda c: c.request(self.url + '/registration', 'PUT', {'note': '一起'}), clients))
        self.assertTrue(all(status == 200 for status, _ in results))
        _, event = self.owner.request(self.url)
        self.assertEqual(event['confirmed_count'], 2)
        self.assertEqual(event['waiting_count'], 6)
        original = [p['nickname'] for p in event['participants']]
        # Cancel first confirmed person; the first waiter must be promoted.
        first_client = clients[int(original[0].replace('朋友', ''))]
        self.assertEqual(first_client.request(self.url + '/registration', 'DELETE', {})[0], 200)
        _, event = self.owner.request(self.url)
        self.assertEqual([p['nickname'] for p in event['participants'][:2]], original[1:3])
        self.assertEqual(event['confirmed_count'], 2)
        self.assertEqual(event['waiting_count'], 5)
        # Rejoining appends to the queue rather than reclaiming the original place.
        _, event = first_client.request(self.url + '/registration', 'PUT', {'note': '回来了'})
        self.assertEqual(event['participants'][-1]['nickname'], original[0])
        self.assertEqual(event['my_registration']['status'], 'waiting')

    def test_duplicate_signup_updates_note_without_changing_order(self):
        visitor = Client(self.base).identify('小明')
        _, first = visitor.request(self.url + '/registration', 'PUT', {'note': '不吃辣'})
        _, second = visitor.request(self.url + '/registration', 'PUT', {'note': '微辣'})
        self.assertEqual(second['confirmed_count'], 1)
        self.assertEqual(second['my_registration']['position'], 1)
        self.assertEqual(second['my_registration']['created_at'], first['my_registration']['created_at'])
        self.assertEqual(second['my_registration']['note'], '微辣')

    def test_owner_permissions_pause_cancel_and_archive(self):
        visitor = Client(self.base).identify('访客')
        self.assertEqual(visitor.request(self.url, 'PATCH', {'status':'cancelled'})[0], 403)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'closed'})[0], 200)
        self.assertEqual(visitor.request(self.url + '/registration', 'PUT', {})[0], 409)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'open'})[0], 200)
        self.assertEqual(visitor.request(self.url + '/registration', 'PUT', {})[0], 200)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'deleted'})[0], 409)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'cancelled','reason':'场地取消预订'})[0], 200)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'action':'archive'})[0], 200)
        self.assertEqual(visitor.request(self.url)[0], 200)
        self.assertTrue(visitor.request(self.url)[1]['archived_at'])
        with sqlite3.connect(str(server.DB)) as db:
            self.assertEqual(db.execute('SELECT status FROM events WHERE id=?',(self.event['id'],)).fetchone()[0], 'cancelled')

    def test_capacity_edit_recalculates_waitlist(self):
        for i in range(3):
            Client(self.base).identify('参与者%d' % i).request(self.url + '/registration', 'PUT', {})
        _, edited = self.owner.request(self.url, 'PATCH', {**self.data, 'capacity':3})
        self.assertEqual(edited['confirmed_count'], 3)
        self.assertEqual(edited['waiting_count'], 0)

    def test_validation_and_cross_origin(self):
        self.assertEqual(self.owner.request('/api/events', 'POST', {**self.data,'capacity':True})[0], 400)
        self.assertEqual(self.owner.request('/api/events', 'POST', {**self.data,'capacity':-1})[0], 400)
        self.assertEqual(self.owner.request('/api/events', 'POST', {**self.data,'title':' '})[0], 400)
        self.assertEqual(self.owner.request('/api/events', 'POST', self.data, {'Origin':'https://other.example'})[0], 403)
        self.assertEqual(Client(self.base).request('/api/events', 'POST', self.data)[0], 401)
        self.assertEqual(self.owner.request('/api/profile', 'POST', {'nickname':'x'*25})[0], 400)
        self.assertEqual(self.owner.request('/api/events', 'POST', {**self.data,'starts_at':'2020-01-01T10:00:00Z'})[0], 400)

    def test_deadline_blocks_new_signups_and_persists_data(self):
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        self.assertEqual(self.owner.request(self.url, 'PATCH', {**self.data,'deadline':past})[0], 200)
        visitor = Client(self.base).identify('迟到的朋友')
        self.assertEqual(visitor.request(self.url + '/registration', 'PUT', {})[0], 409)
        # Re-initialization must preserve all existing activity data.
        server.initialize()
        _, loaded = self.owner.request(self.url)
        self.assertEqual(loaded['title'], self.data['title'])
        self.assertTrue(loaded['is_owner'])
        self.assertFalse(loaded['can_join'])

    def test_ktv_duration_crosses_midnight_and_updates(self):
        data = {**self.data, 'category': '约K', 'starts_at': '2099-12-31T23:00:00+08:00',
            'deadline': '2099-12-31T23:00:00+08:00', 'duration_hours': 3}
        status, event = self.owner.request('/api/events', 'POST', data)
        self.assertEqual(status, 201)
        end = datetime.fromisoformat(event['ends_at']).astimezone(timezone(timedelta(hours=8)))
        self.assertEqual(end.isoformat(), '2100-01-01T02:00:00+08:00')
        self.assertEqual(event['category'], '约K')
        url = '/api/events/' + event['id']
        status, event = self.owner.request(url, 'PATCH', {**data, 'duration_hours': 5})
        self.assertEqual(status, 200)
        self.assertEqual((datetime.fromisoformat(event['ends_at']) - datetime.fromisoformat(event['starts_at'])).total_seconds(), 5 * 3600)
        _, persisted = self.owner.request(url)
        self.assertEqual(persisted['duration_hours'], 5)

    def test_duration_validation(self):
        for invalid in [0, 25, True, '3', 2.5]:
            status, _ = self.owner.request('/api/events', 'POST', {**self.data, 'category': '约K', 'duration_hours': invalid})
            self.assertEqual(status, 400)

    def test_unlimited_capacity_and_promoting_existing_waiters(self):
        for i in range(4):
            Client(self.base).identify('歌友%d' % i).request(self.url + '/registration', 'PUT', {})
        _, before = self.owner.request(self.url)
        self.assertEqual(before['waiting_count'], 2)
        status, unlimited = self.owner.request(self.url, 'PATCH', {**self.data, 'capacity':0})
        self.assertEqual(status, 200)
        self.assertEqual(unlimited['capacity'], 0)
        self.assertEqual(unlimited['confirmed_count'], 4)
        self.assertEqual(unlimited['waiting_count'], 0)
        self.assertTrue(all(p['status'] == 'confirmed' for p in unlimited['participants']))
        visitor = Client(self.base).identify('新歌友')
        status, after = visitor.request(self.url + '/registration', 'PUT', {})
        self.assertEqual(status, 200)
        self.assertEqual(after['confirmed_count'], 5)
        self.assertEqual(after['my_registration']['status'], 'confirmed')
        self.assertEqual(after['waiting_count'], 0)

    def finish_event(self, hours_ago=6, duration=3):
        start = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat(timespec='seconds')
        with sqlite3.connect(str(server.DB)) as db:
            db.execute('UPDATE events SET starts_at=?,deadline=?,duration_hours=?,lifecycle=?,status=?,actual_ended_at=? WHERE id=?',
                (start,start,duration,'ended' if hours_ago>=duration else 'ongoing','finished' if hours_ago>=duration else 'closed',
                 datetime.now(timezone.utc).isoformat(timespec='seconds') if hours_ago>=duration else None,self.event['id']))

    def test_settlement_defaults_to_confirmed_people_and_can_override(self):
        for i in range(3):
            Client(self.base).identify('到场%d' % i).request(self.url + '/registration', 'PUT', {})
        self.finish_event()
        _, ended = self.owner.request(self.url)
        self.assertTrue(ended['can_settle'])
        status, event = self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':'180.00'})
        self.assertEqual(status, 200)
        self.assertEqual(event['settlement']['headcount'], 2)
        self.assertEqual(event['settlement']['per_person_amount'], '90.00')
        status, event = self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':'180.00', 'headcount':3})
        self.assertEqual(status, 200)
        self.assertEqual(event['settlement']['per_person_amount'], '60.00')

    def test_settlement_money_precision_and_rounding(self):
        self.finish_event()
        for total, count, each, delta in [('100.00',3,'33.33',-1), ('0.05',2,'0.03',1), ('0.30',3,'0.10',0), ('0',2,'0.00',0)]:
            status, event = self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':total, 'headcount':count})
            self.assertEqual(status, 200)
            self.assertEqual(event['settlement']['per_person_amount'], each)
            self.assertEqual(event['settlement']['rounding_difference_cents'], delta)
        for invalid in ['-1', 'NaN', '1.001', '1e2', 0.3, True]:
            self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':invalid,'headcount':2})[0], 400)
        for invalid in [0, -1, 2.5, True, 10001]:
            self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':'100.00','headcount':invalid})[0], 400)

    def test_settlement_note_optional_update_preserve_and_clear(self):
        self.finish_event()
        data = {'total_amount':'100.00', 'headcount':2}
        status, event = self.owner.request(self.url + '/settlement', 'PUT', data)
        self.assertEqual(status, 200)
        self.assertEqual(event['settlement']['note'], '')
        note = '包厢 80 元，饮料 20 元\n<img src=x onerror=alert(1)>'
        status, event = self.owner.request(self.url + '/settlement', 'PUT', {**data, 'note':'  ' + note + '  '})
        self.assertEqual(status, 200)
        self.assertEqual(event['settlement']['note'], note)
        self.assertEqual(Client(self.base).request(self.url)[1]['settlement']['note'], note)
        _, event = self.owner.request(self.url + '/settlement', 'PUT', {**data, 'total_amount':'120.00'})
        self.assertEqual(event['settlement']['note'], note)
        for invalid in [None, 123, '字'*1001]:
            self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data, 'note':invalid})[0], 400)
        self.assertEqual(self.owner.request(self.url)[1]['settlement']['note'], note)
        _, event = self.owner.request(self.url + '/settlement', 'PUT', {**data, 'note':'修正后的说明'})
        self.assertEqual(event['settlement']['note'], '修正后的说明')
        _, event = self.owner.request(self.url + '/settlement', 'PUT', {**data, 'note':''})
        self.assertEqual(event['settlement']['note'], '')

    def test_settlement_only_owner_after_end(self):
        data = {'total_amount':'100.00','headcount':2}
        visitor = Client(self.base).identify('参加者')
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 409)
        self.finish_event(hours_ago=1, duration=3)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 409)
        self.finish_event()
        self.assertEqual(visitor.request(self.url + '/settlement', 'PUT', data)[0], 403)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        _, cancelled = self.owner.request('/api/events', 'POST', self.data)
        cancelled_url = '/api/events/' + cancelled['id']
        self.assertEqual(self.owner.request(cancelled_url, 'PATCH', {'status':'cancelled','reason':'临时停业'})[0], 200)
        self.assertEqual(self.owner.request(cancelled_url + '/settlement', 'PUT', data)[0], 200)

    def test_stale_settlement_edits_are_rejected_without_changing_history(self):
        self.finish_event()
        data = {'total_amount':'100.00','headcount':2,'note':'原说明','base_version':0}
        status, first = self.owner.request(self.url + '/settlement', 'PUT', data)
        self.assertEqual(status, 200)
        self.assertEqual(first['settlement']['version'], 1)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 409)
        status, second = self.owner.request(self.url + '/settlement', 'PUT', {**data,'total_amount':'120.00','base_version':1})
        self.assertEqual(status, 200)
        self.assertEqual(second['settlement']['version'], 2)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data,'note':'旧页面说明','base_version':1})[0], 409)
        for invalid in [True, -1, '2', None]:
            self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data,'base_version':invalid})[0], 400)
        _, current = self.owner.request(self.url)
        self.assertEqual(current['settlement'], second['settlement'])
        self.assertEqual(len(self.owner.request(self.url + '/settlement/history')[1]['revisions']), 2)

    def test_concurrent_settlement_saves_only_accept_one_matching_version(self):
        self.finish_event()
        data = {'total_amount':'100.00','headcount':2,'base_version':0}
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        def save(amount):
            return self.owner.request(self.url + '/settlement', 'PUT', {**data,'total_amount':amount,'base_version':1})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ['120.00','140.00']))
        self.assertEqual(sorted(status for status, _ in results), [200,409])
        saved = next(event for status,event in results if status==200)
        self.assertEqual(self.owner.request(self.url)[1]['settlement'], saved['settlement'])
        self.assertEqual(len(self.owner.request(self.url + '/settlement/history')[1]['revisions']), 2)

    def test_ended_schedule_and_published_settlement_cannot_be_hidden(self):
        self.finish_event()
        for patch in [self.data, {'status':'open'}, {'status':'closed'}]:
            self.assertEqual(self.owner.request(self.url, 'PATCH', patch)[0], 409)
        data = {'total_amount':'100.00','headcount':2}
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        self.assertEqual(self.owner.request(self.url,'PATCH',{'status':'cancelled','reason':'保留已发生费用'})[0],200)
        self.assertEqual(self.owner.request(self.url,'PATCH',{'status':'deleted'})[0],409)
        self.assertEqual(self.owner.request(self.url)[0], 200)
        self.assertEqual(len(self.owner.request(self.url + '/settlement/history')[1]['revisions']), 1)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data,'total_amount':'0.00','note':'本次免收'})[0], 200)

    def test_settlement_history_tracks_every_field_and_keeps_old_images(self):
        self.finish_event()
        visitor = Client(self.base).identify('参加者')
        history_url = self.url + '/settlement/history'
        self.assertEqual(visitor.request(history_url)[1]['revisions'], [])
        first_image, second_image = test_png(), test_png(b'\x00\x00\x00')
        data = {'total_amount':'100.00', 'headcount':2, 'note':'最初说明',
            'qr_image':base64.b64encode(first_image).decode()}
        self.assertEqual(visitor.request(self.url + '/settlement', 'PUT', data)[0], 403)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        self.owner.request('/api/profile', 'POST', {'nickname':'新称呼'})
        edits = [('total_amount','120.00'), ('headcount',3), ('note','第二版说明'),
            ('qr_image',base64.b64encode(second_image).decode()), ('qr_image',None), ('note','')]
        for field, value in edits:
            data[field] = value
            self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        _, result = visitor.request(history_url)
        revisions = list(reversed(result['revisions']))
        self.assertEqual([r['version'] for r in revisions], list(range(1,8)))
        self.assertEqual(revisions[0]['kind'], 'published')
        self.assertEqual(revisions[0]['actor_name'], '发起者')
        self.assertEqual(revisions[0]['total_amount'], '100.00')
        self.assertEqual(revisions[0]['note'], '最初说明')
        self.assertEqual([r['changed_fields'] for r in revisions[1:]], [[field] for field, _ in edits])
        self.assertTrue(all(r['actor_name'] == '新称呼' and r['kind'] == 'edited' for r in revisions[1:]))
        self.assertFalse(revisions[-1]['has_qr'])
        self.assertEqual(revisions[-1]['note'], '')
        self.assertNotIn('actor_id', revisions[0])
        for version, image in [(1,first_image),(4,first_image),(5,second_image)]:
            with urllib.request.urlopen(self.base + history_url + '/%s/payment-code' % version) as response:
                self.assertEqual(response.read(), image)
        self.assertEqual(visitor.request(history_url + '/6/payment-code')[0], 404)
        # Identical saves and rejected edits must not create versions.
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', data)[0], 200)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data,'note':None})[0], 400)
        self.assertEqual(len(visitor.request(history_url)[1]['revisions']), 7)
        with sqlite3.connect(str(server.DB)) as db, sqlite3.connect(':memory:') as backup:
            db.backup(backup)
            self.assertIsNone(backup.execute('SELECT qr_image FROM settlement_history WHERE event_id=? AND version=1', (self.event['id'],)).fetchone()[0])
            digest=backup.execute('SELECT digest FROM settlement_code_images WHERE event_id=? AND version=1',(self.event['id'],)).fetchone()[0]
            self.assertEqual(digest,hashlib.sha256(first_image).hexdigest())
            for statement in ['UPDATE settlement_history SET note=\'overwritten\' WHERE event_id=?',
                              'DELETE FROM settlement_history WHERE event_id=?']:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(statement, (self.event['id'],))
        # Legacy removed activities still must not expose their history or QR codes.
        with sqlite3.connect(str(server.DB)) as db:
            db.execute("UPDATE events SET status='deleted' WHERE id=?", (self.event['id'],))
        self.assertEqual(visitor.request(history_url)[0], 404)
        self.assertEqual(visitor.request(history_url + '/1/payment-code')[0], 404)

    def test_failed_history_write_cannot_change_current_settlement(self):
        self.finish_event()
        data = {'total_amount':'100.00','headcount':2}
        self.owner.request(self.url + '/settlement', 'PUT', data)
        with sqlite3.connect(str(server.DB)) as db:
            db.execute('''CREATE TRIGGER reject_history BEFORE INSERT ON settlement_history
                BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END''')
        try:
            with self.assertLogs(level='ERROR'):
                self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data,'total_amount':'200.00'})[0], 500)
            self.assertEqual(self.owner.request(self.url)[1]['settlement']['total_amount'], '100.00')
            self.assertEqual(len(self.owner.request(self.url + '/settlement/history')[1]['revisions']), 1)
        finally:
            with sqlite3.connect(str(server.DB)) as db:
                db.execute('DROP TRIGGER reject_history')

    def test_owner_can_finish_early_and_settle_without_changing_schedule(self):
        visitor = Client(self.base).identify('参加者')
        visitor.request(self.url + '/registration', 'PUT', {})
        _, before = self.owner.request(self.url)
        self.assertTrue(before['can_finish'])
        self.assertFalse(before['can_settle'])
        self.assertEqual(visitor.request(self.url, 'PATCH', {'status':'finished'})[0], 403)
        status, finished = self.owner.request(self.url, 'PATCH', {'status':'finished'})
        self.assertEqual(status, 200)
        self.assertTrue(finished['has_ended'])
        self.assertTrue(finished['can_settle'])
        self.assertFalse(finished['can_join'])
        self.assertFalse(finished['can_finish'])
        self.assertEqual(finished['starts_at'], before['starts_at'])
        self.assertEqual(finished['ends_at'], before['ends_at'])
        stable = lambda people: [{k:v for k,v in person.items() if k not in ('can_change','can_withdraw')} for person in people]
        self.assertEqual(stable(finished['participants']), stable(before['participants']))
        self.assertEqual(visitor.request(self.url + '/registration', 'PUT', {})[0], 409)
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':'100.00'})[0], 200)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'open'})[0], 409)
        self.assertEqual(self.owner.request(self.url, 'PATCH', self.data)[0], 409)
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'finished'})[0], 200)
        _, persisted = self.owner.request(self.url)
        self.assertEqual(persisted['status'], 'finished')
        self.assertTrue(persisted['can_settle'])

    def test_paused_event_can_finish_but_cancelled_event_cannot(self):
        self.owner.request(self.url, 'PATCH', {'status':'closed'})
        _, paused = self.owner.request(self.url)
        self.assertTrue(paused['can_finish'])
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'finished'})[0], 200)
        self.owner.request(self.url, 'PATCH', {'status':'cancelled','reason':'后续场次取消'})
        self.assertEqual(self.owner.request(self.url, 'PATCH', {'status':'finished'})[0], 409)

    def test_payment_code_upload_preserve_remove_and_backup(self):
        self.finish_event()
        image = test_png()
        data = {'total_amount':'200.50', 'headcount':2, 'qr_image':base64.b64encode(image).decode()}
        status, event = self.owner.request(self.url + '/settlement', 'PUT', data)
        self.assertEqual(status, 200)
        self.assertTrue(event['settlement']['has_qr'])
        with urllib.request.urlopen(self.base + self.url + '/payment-code') as response:
            self.assertEqual(response.headers['Content-Type'], 'image/png')
            self.assertEqual(response.read(), image)
        # Amount changes must preserve the image unless explicitly removed.
        status, event = self.owner.request(self.url + '/settlement', 'PUT', {'total_amount':'210.50','headcount':3})
        self.assertEqual(status, 200)
        self.assertTrue(event['settlement']['has_qr'])
        with sqlite3.connect(str(server.DB)) as src, sqlite3.connect(':memory:') as backup:
            src.backup(backup)
            self.assertIsNone(backup.execute('SELECT qr_image FROM settlements WHERE event_id=?',(self.event['id'],)).fetchone()[0])
            digest=backup.execute('SELECT digest FROM settlement_code_images WHERE event_id=? ORDER BY version DESC LIMIT 1',(self.event['id'],)).fetchone()[0]
            self.assertEqual(digest,hashlib.sha256(image).hexdigest())
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data, 'qr_image':base64.b64encode(b'<svg onload="alert(1)"></svg>').decode()})[0], 400)
        broken = bytearray(image); broken[20] ^= 1
        self.assertEqual(self.owner.request(self.url + '/settlement', 'PUT', {**data, 'qr_image':base64.b64encode(broken).decode()})[0], 400)
        status, event = self.owner.request(self.url + '/settlement', 'PUT', {**data, 'qr_image':None})
        self.assertEqual(status, 200)
        self.assertFalse(event['settlement']['has_qr'])
        self.assertEqual(self.owner.request(self.url + '/payment-code')[0], 404)


class MigrationTests(unittest.TestCase):
    def test_existing_settlement_gets_empty_note_without_losing_data(self):
        previous_db = server.DB
        with tempfile.TemporaryDirectory() as folder:
            server.DB = Path(folder) / 'legacy.sqlite3'
            try:
                with sqlite3.connect(str(server.DB)) as db:
                    db.execute('''CREATE TABLE events (
                        id TEXT PRIMARY KEY, owner_id TEXT, title TEXT, category TEXT,
                        location TEXT, starts_at TEXT, deadline TEXT, capacity INTEGER,
                        description TEXT, status TEXT DEFAULT 'open', created_at TEXT)''')
                    db.execute('''INSERT INTO events VALUES
                        ('old','owner','旧活动','约K','原地点','2026-01-01T00:00:00+00:00',
                        '2026-01-01T00:00:00+00:00',0,'','finished','2026-01-01')''')
                    db.execute('''CREATE TABLE settlements (event_id TEXT PRIMARY KEY,
                        total_cents INTEGER NOT NULL, headcount INTEGER NOT NULL,
                        qr_image BLOB, updated_at TEXT NOT NULL)''')
                    db.execute('INSERT INTO settlements VALUES(?,?,?,?,?)', ('old', 12345, 3, test_png(), '2026-01-01'))
                server.initialize()
                server.initialize()
                with sqlite3.connect(str(server.DB)) as db:
                    row = db.execute('SELECT total_cents,headcount,qr_image,updated_at,note FROM settlements').fetchone()
                    self.assertEqual(row, (12345, 3, test_png(), '2026-01-01', ''))
                    rows = db.execute('SELECT version,total_cents,headcount,qr_image,updated_at,note,kind FROM settlement_history').fetchall()
                    self.assertEqual(rows, [(1, 12345, 3, test_png(), '2026-01-01', '', 'baseline')])
            finally:
                server.DB = previous_db

    def test_existing_database_keeps_events_and_unknown_duration(self):
        previous_db = server.DB
        with tempfile.TemporaryDirectory() as folder:
            server.DB = Path(folder) / 'legacy.sqlite3'
            try:
                with sqlite3.connect(str(server.DB)) as db:
                    db.execute('''CREATE TABLE events (
                        id TEXT PRIMARY KEY, owner_id TEXT, title TEXT, category TEXT,
                        location TEXT, starts_at TEXT, deadline TEXT, capacity INTEGER,
                        description TEXT, status TEXT DEFAULT 'open', created_at TEXT)''')
                    db.execute('''INSERT INTO events VALUES
                        ('old','owner','旧活动','聚餐','原地点','2099-01-01T00:00:00+00:00',
                        '2099-01-01T00:00:00+00:00',8,'原说明','open','2026-01-01')''')
                server.initialize()
                server.initialize()
                with sqlite3.connect(str(server.DB)) as db:
                    row = db.execute('SELECT title,description,duration_hours FROM events').fetchone()
                    self.assertEqual(row, ('旧活动', '原说明', None))
            finally:
                server.DB = previous_db


if __name__ == '__main__':
    unittest.main(verbosity=2)
