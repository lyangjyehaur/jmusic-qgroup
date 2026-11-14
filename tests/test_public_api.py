"""Partner authentication, identity joins and restricted-data boundaries."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import server
import test_rooms as room_tests
from test_roster import ModernClient

KEY = 'test_partner_key_' + 'a' * 40
AUTH = {'Authorization': 'Bearer ' + KEY}


class PartnerClient(ModernClient):
    def request(self, path, method='GET', data=None, headers=None):
        return super().request(path, method, data, {**AUTH, **(headers or {})})


class PublicAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.previous_db = server.DB
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d' % cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.thread.join()
        server.DB = cls.previous_db
        cls.tmp.cleanup()

    def setUp(self):
        configured = mock.patch.dict(os.environ, {'KANBAN_PUBLIC_API_KEYS': KEY})
        configured.start()
        self.addCleanup(configured.stop)
        server.DB = Path(self.tmp.name) / (self._testMethodName + '.sqlite3')
        server.initialize()
        room_tests.RoomTests.setUp(self)
        self.public_url = '/api/public/v1/events/' + self.event_id
        self.partner = PartnerClient(self.base)

    fresh = room_tests.RoomTests.fresh
    stamp = room_tests.RoomTests.stamp
    plan = room_tests.RoomTests.plan
    finish = room_tests.RoomTests.finish
    data = room_tests.RoomTests.data
    preview = room_tests.RoomTests.preview
    publish = room_tests.RoomTests.publish

    def fetch(self, path, method='GET', headers=None, authenticated=True):
        supplied = {**(AUTH if authenticated else {}), **(headers or {})}
        request = urllib.request.Request(self.base + path, method=method, headers=supplied)
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_account_ids_join_roster_rooms_and_admin_ids_across_events(self):
        self.assertEqual(self.plan()[0], 200)
        status, result = self.partner.request(self.public_url)
        self.assertEqual(status, 200, result)
        with server.connect() as db:
            expected = {p['id']: p['user_id'] for p in server.roster.rows(db, self.event_id)}
        people = result['participants']
        self.assertEqual({p['attendee_id']: p['user_id'] for p in people}, expected)
        self.assertEqual(result['room_assignments']['planned']['rooms'][0]['attendee_ids'], self.rooms[0]['person_ids'])
        member = result['room_assignments']['planned']['rooms'][0]['members'][0]
        self.assertEqual(member['user_id'], expected[member['attendee_id']])
        status, second = self.owner.request('/api/events', 'POST', dict(
            title='另一场', category='聚餐', location='餐厅', starts_at=self.fresh()['starts_at'],
            deadline=self.fresh()['deadline'], capacity=0, join_owner=False, description=''))
        self.assertEqual(status, 201, second)
        path = '/api/events/' + second['id']
        body = dict(people=[dict(is_self=True)], base_revision=second['revision'])
        status, preview = self.clients[0].request(path + '/roster/preview', 'POST', body)
        self.assertEqual(status, 200, preview)
        self.assertEqual(self.clients[0].request(path + '/roster/parties', 'POST', {**body, **preview, 'accept_partial':True})[0], 200)
        second_people = self.partner.request('/api/public/v1/events/' + second['id'] + '/participants')[1]['participants']
        self.assertEqual(second_people[0]['user_id'], people[0]['user_id'])
        self.assertNotEqual(second_people[0]['attendee_id'], people[0]['attendee_id'])
        self.assertEqual(result['event']['counts'], dict(confirmed=4, waiting=0, tentative=0))
        self.assertIsNone(result['event']['remaining_capacity'])

    def test_guest_is_not_identified_as_manager_and_claim_keeps_attendee_id(self):
        body = dict(people=[dict(name='同行', payer_kind='manager')], base_revision=self.fresh()['revision'])
        status, preview = self.clients[0].request(self.url + '/roster/preview', 'POST', body)
        self.assertEqual(status, 200, preview)
        status, result = self.clients[0].request(self.url + '/roster/parties', 'POST', {**body, **preview, 'accept_partial':True})
        self.assertEqual(status, 200, result)
        person = self.partner.request(self.public_url + '/participants')[1]['participants'][-1]
        self.assertIsNone(person['user_id'])
        claimant = ModernClient(self.base).identify('同行本人')
        status, invited = self.clients[0].request(self.url + '/claims', 'POST', dict(
            attendee_id=person['attendee_id'], reason='本人核对', base_revision=self.fresh()['revision']))
        self.assertEqual(status, 200, invited)
        claim = next(c for c in invited['claim_invitations'] if c['status'] == 'invited')
        claim_url = self.url + '/claims/' + claim['token']
        status, info = claimant.request(claim_url)
        self.assertEqual(status, 200, info)
        status, requested = claimant.request(claim_url + '/request', 'POST', dict(
            confirm_identity=True, keep_payment=True, base_revision=info['base_revision']))
        self.assertEqual(status, 200, requested)
        status, approved = self.clients[0].request(self.url + '/claims/' + claim['id'], 'POST', dict(
            decision='approve', confirm_person=True, reason='已当面核对', base_revision=self.fresh()['revision']))
        self.assertEqual(status, 200, approved)
        updated = self.partner.request(self.public_url + '/participants')[1]['participants'][-1]
        self.assertEqual(updated['attendee_id'], person['attendee_id'])
        self.assertIsNotNone(updated['user_id'])

    def test_nonpublic_events_hidden_on_every_endpoint_even_for_owner(self):
        for changes in (dict(visibility='invitation'), dict(lifecycle='draft'), dict(status='deleted')):
            with server.connect() as db:
                db.execute("UPDATE events SET visibility='public',lifecycle='scheduled',status='open' WHERE id=?", (self.event_id,))
                for key, value in changes.items():
                    db.execute('UPDATE events SET ' + key + '=? WHERE id=?', (value, self.event_id))
            for client in (self.partner, self.owner):
                for suffix in ('', '/participants', '/rooms'):
                    status, result = client.request(self.public_url + suffix, headers=AUTH)
                    self.assertEqual(status, 404, result)
                    self.assertEqual(result, {'error':'Public event not found'})
                self.assertEqual(client.request('/api/public/v1/events', headers=AUTH)[1]['events'], [])
        self.assertEqual(self.partner.request('/api/public/v1/events/' + 'f' * 16)[1], {'error':'Public event not found'})

    def test_pagination_filters_cancelled_and_archived_sync(self):
        with server.connect() as db:
            original = dict(db.execute('SELECT * FROM events WHERE id=?', (self.event_id,)).fetchone())
            for index, (state, status) in enumerate((('ended', 'closed'), ('cancelled', 'cancelled'))):
                row = dict(original, id=('%016x' % index), lifecycle=state, status=status, archived_at=original['created_at'])
                db.execute('INSERT INTO events (' + ','.join(row) + ') VALUES (' + ','.join('?' for _ in row) + ')', tuple(row.values()))
        status, page = self.partner.request('/api/public/v1/events?limit=1')
        self.assertEqual(status, 200)
        self.assertEqual((page['total'], page['next_offset']), (3, 1))
        seen = [page['events'][0]['id']]
        while page['next_offset'] is not None:
            page = self.partner.request('/api/public/v1/events?limit=1&offset=' + str(page['next_offset']))[1]
            seen.append(page['events'][0]['id'])
        self.assertEqual(len(set(seen)), 3)
        filtered = self.partner.request('/api/public/v1/events?lifecycle=cancelled&status=cancelled')[1]
        self.assertEqual(filtered['total'], 1)
        self.assertIsNotNone(filtered['events'][0]['archived_at'])
        self.assertFalse(filtered['events'][0]['registration_open'])

    def test_invalid_parameters_and_paths(self):
        for query in ('limit=0', 'limit=101', 'offset=-1', 'offset=100000001', 'limit=1&limit=2',
                      'status=deleted', 'lifecycle=draft', 'unknown=1', 'limit=abc', 'limit=',
                      '&'.join('a=1' for _ in range(11))):
            self.assertEqual(self.partner.request('/api/public/v1/events?' + query)[0], 400, query)
        self.assertEqual(self.partner.request(self.public_url + '?invite=secret')[0], 400)
        self.assertEqual(self.partner.request(self.public_url + '/finance')[0], 404)

    def test_private_fields_are_allowlisted_and_person_statuses_are_filtered(self):
        with server.connect() as db:
            for index,row in enumerate(db.execute('SELECT id FROM users').fetchall()):
                db.execute('INSERT INTO admin_user_metadata VALUES(?,?,?,?,?,?)',
                    (row['id'],'PRIVATE_ADMIN_NOTE',str(987654000+index),1,'now','test'))
            db.execute("UPDATE attendees SET note='PRIVATE_NOTE',attendance_note='PRIVATE_ATTENDANCE',withdrawal_reason='PRIVATE_REASON' WHERE event_id=?", (self.event_id,))
            db.execute("UPDATE attendees SET status='invited',invitation_token='PRIVATE_TOKEN' WHERE id=?", (self.people[0]['id'],))
            db.execute("UPDATE attendees SET status='withdrawn' WHERE id=?", (self.people[1]['id'],))
            db.execute("UPDATE attendees SET status='waiting' WHERE id=?", (self.people[2]['id'],))
            db.execute("UPDATE attendees SET status='tentative' WHERE id=?", (self.people[3]['id'],))
        payload = self.partner.request(self.public_url)[1]
        self.assertEqual([p['status'] for p in payload['participants']], ['waiting', 'tentative'])
        self.assertEqual(payload['event']['counts'], dict(confirmed=0, waiting=1, tentative=1))
        encoded = json.dumps(payload)
        self.assertNotIn('PRIVATE_', encoded)
        for suffix in ('','/participants','/rooms'):
            result=str(self.partner.request(self.public_url+suffix)[1])
            for private in ('PRIVATE_ADMIN_NOTE','987654','manual_qq','metadata_revision'):
                self.assertNotIn(private,result)
        for client in (ModernClient(self.base),self.owner):
            result=str(client.request(self.url)[1])
            self.assertNotIn('PRIVATE_ADMIN_NOTE',result);self.assertNotIn('987654',result)
        for person in payload['participants']:
            self.assertEqual(set(person), {'attendee_id', 'user_id', 'name', 'status', 'confirmation_state'})
        for key in ('finance', 'settlement', 'share_token', 'owner_id', 'invite_token', 'bot_delivery'):
            self.assertNotIn(key, payload['event'])

    def test_actual_rooms_use_frozen_people_and_omit_financial_information(self):
        self.assertEqual(self.plan()[0], 200)
        # Planned allocations may be partial and have an explicit unassigned list.
        partial = [dict(r, person_ids=r['person_ids'][:1]) for r in self.rooms]
        self.assertEqual(self.plan(partial)[0], 200)
        planned = self.partner.request(self.public_url + '/rooms')[1]
        self.assertEqual(len(planned['planned']['unassigned_attendee_ids']), 2)
        self.assertIsNone(planned['actual'])
        self.assertEqual(self.plan()[0], 200)
        self.finish(); self.publish(self.data(False))
        first = self.partner.request(self.public_url + '/rooms')[1]
        with server.connect() as db:
            db.execute("UPDATE users SET nickname='改名后' WHERE id=(SELECT user_id FROM attendees WHERE id=?)", (self.people[0]['id'],))
            db.execute("UPDATE attendees SET status='withdrawn' WHERE id=?", (self.people[0]['id'],))
        result = self.partner.request(self.public_url + '/rooms')[1]
        self.assertEqual(result['actual'], first['actual'])
        self.assertEqual(result['actual']['settlement_version'], 1)
        for room in result['actual']['rooms']:
            self.assertEqual(set(room), {'id', 'name', 'attendee_ids', 'members'})
        self.assertNotIn(self.people[0]['id'], result['planned']['rooms'][0]['attendee_ids'])

    def test_account_closure_drops_public_identity_link(self):
        self.assertEqual(self.plan()[0], 200)
        original = self.partner.request(self.public_url + '/participants')[1]['participants'][0]
        status, result = self.clients[0].request('/api/auth/close', 'POST', {'confirm_close':True})
        self.assertEqual(status, 200, result)
        people = self.partner.request(self.public_url + '/participants')[1]['participants']
        person = next(p for p in people if p['attendee_id'] == original['attendee_id'])
        self.assertIsNone(person['user_id'])
        member = self.partner.request(self.public_url + '/rooms')[1]['planned']['rooms'][0]['members'][0]
        self.assertIsNone(member['user_id'])

    def test_backend_only_head_options_and_write_rejection_have_no_database_effects(self):
        with server.connect() as db:
            before = list(db.iterdump())
        status, headers, body = self.fetch(self.public_url, headers={'Origin':'https://other.example'})
        self.assertEqual(status, 200)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertNotIn('Access-Control-Allow-Credentials', headers)
        self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.fetch(self.public_url, 'HEAD')[2], b'')
        self.assertEqual(self.fetch(self.public_url, 'OPTIONS')[0], 204)
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            status, headers, _ = self.fetch(self.public_url, method, {'Origin':'https://other.example'})
            self.assertEqual(status, 405)
            self.assertEqual(headers['Allow'], 'GET, HEAD, OPTIONS')
            self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertNotIn('Access-Control-Allow-Origin', self.fetch('/api/public/v1/missing')[1])
        self.assertEqual(self.fetch('/api/events')[1].get('Access-Control-Allow-Origin'), None)
        with server.connect() as db:
            self.assertEqual(list(db.iterdump()), before)

    def test_language_and_cookie_do_not_change_public_payload(self):
        authorized = self.partner.request(self.public_url)[1]
        self.assertEqual(authorized, self.owner.request(self.public_url, headers=AUTH)[1])
        self.assertEqual(authorized, self.partner.request(self.public_url, headers={'Accept-Language':'zh-TW'})[1])
        status, discovery = self.partner.request('/api/public/v1')
        self.assertEqual(status, 200)
        self.assertEqual(discovery['identity']['account'], 'user_id')

    def test_every_data_endpoint_requires_key_even_with_owner_cookie(self):
        paths = ['/api/public/v1', '/api/public/v1/events', self.public_url,
                 self.public_url + '/participants', self.public_url + '/rooms', '/api/public/v1/missing']
        with server.connect() as db:
            before = list(db.iterdump())
        for path in paths:
            for client in (ModernClient(self.base), self.owner):
                status, payload = client.request(path)
                self.assertEqual(status, 401, (path, payload))
                self.assertEqual(payload, {'error': 'Valid API key required'})
            status, headers, body = self.fetch(path, authenticated=False)
            self.assertEqual(status, 401)
            self.assertEqual(headers['WWW-Authenticate'], 'Bearer realm="qgroup-partner-api"')
            self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(self.fetch(self.public_url, 'HEAD', authenticated=False)[0], 401)
        self.assertEqual(self.fetch(self.public_url, 'HEAD', authenticated=False)[2], b'')
        self.assertEqual(self.fetch(self.public_url, 'OPTIONS', authenticated=False)[0], 204)
        self.assertEqual(self.fetch(self.public_url, 'POST', authenticated=False)[0], 401)
        with server.connect() as db:
            self.assertEqual(list(db.iterdump()), before)

    def test_invalid_and_query_keys_cannot_authenticate_and_do_not_leak(self):
        for value in ('', 'Basic ' + KEY, 'Bearer wrong', 'Bearer ' + 'b' * 56,
                      'Bearer ' + KEY + ', Bearer ' + KEY, 'Bearer ' + KEY + ' extra', 'Bearer ' + 'é' * 40):
            status, _, payload = self.fetch(self.public_url, headers={'Authorization': value})
            self.assertEqual(status, 401, payload)
            self.assertNotIn(KEY, payload.decode())
        with self.assertLogs(level='INFO') as logs:
            status, _, _ = self.fetch(self.public_url + '?api_key=' + KEY, authenticated=False)
        self.assertEqual(status, 401)
        self.assertNotIn(KEY, '\n'.join(logs.output))
        self.assertEqual(self.fetch(self.public_url, headers={'Authorization': 'bearer ' + KEY})[0], 200)
        # Multiple Authorization header lines must not allow one valid value to win.
        import http.client
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_address[1])
        try:
            connection.putrequest('GET', self.public_url)
            connection.putheader('Authorization', 'Bearer ' + KEY)
            connection.putheader('Authorization', 'Bearer ' + 'b' * 56)
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
        finally:
            connection.close()

    def test_missing_or_malformed_configuration_disables_api_before_database_access(self):
        for configuration in ('', ' ', 'short', KEY + ',', 'é' * 40, ','.join([KEY] * 21)):
            with mock.patch.dict(os.environ, {'KANBAN_PUBLIC_API_KEYS': configuration}), \
                    mock.patch.object(server, 'connect', side_effect=AssertionError('must authorize first')):
                status, _, raw = self.fetch(self.public_url)
                self.assertEqual(status, 503)
                self.assertEqual(json.loads(raw), {'error': 'Partner API is not configured'})

    def test_independent_keys_rotation_and_revocation(self):
        replacement = 'test_second_partner_' + 'b' * 40
        with mock.patch.dict(os.environ, {'KANBAN_PUBLIC_API_KEYS': KEY + ',' + replacement}):
            self.assertEqual(self.fetch(self.public_url)[0], 200)
            self.assertEqual(self.fetch(self.public_url, headers={'Authorization': 'Bearer ' + replacement})[0], 200)
        with mock.patch.dict(os.environ, {'KANBAN_PUBLIC_API_KEYS': replacement}):
            self.assertEqual(self.fetch(self.public_url)[0], 401)
            self.assertEqual(self.fetch(self.public_url, headers={'Authorization': 'Bearer ' + replacement})[0], 200)
        self.assertEqual(ModernClient(self.base).request('/api/health')[0], 200)
        self.assertEqual(ModernClient(self.base).request('/api/events')[0], 200)
