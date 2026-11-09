import base64
import copy
import hashlib
import json
import sqlite3
import tarfile
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

import server
from qgroup_core import media,storage,payment_codes
from deploy.backup import backup
from deploy.verify_migration import snapshot,preserved
from test_api import test_png
from test_roster import ModernClient
from datetime import datetime,timedelta,timezone


class PaymentCodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'board.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear();self.owner=ModernClient(self.base).identify('发起者後臺');self.other=ModernClient(self.base).identify('另一人'+uuid.uuid4().hex[:8])
        self.event=self.new_event();self.url='/api/events/'+self.event['id']

    def new_event(self):
        start=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        status,event=self.owner.request('/api/events','POST',dict(title='图片与收款码',category='约K',location='KTV',starts_at=start,deadline=start,capacity=0,duration_hours=3))
        self.assertEqual(status,201,event)
        status,event=self.owner.request('/api/events/'+event['id'],'PATCH',dict(action='finish',base_revision=event['revision']))
        self.assertEqual(status,200,event);return event

    def upload(self,kind='wechat',client=None,image=None,name='我的后台原文'):
        raw=image or test_png()
        status,code=(client or self.owner).request('/api/payment-codes','POST',dict(kind=kind,name=name,image=base64.b64encode(raw).decode()))
        self.assertEqual(status,201,code);return code

    def data(self,codes=None,url=None):
        url=url or self.url;event=self.owner.request(url)[1];people=self.owner.request(url+'/settlement/roster')[1]['people']
        return dict(base_revision=event['revision'],base_version=event['settlement']['version'] if event['settlement'] else 0,reviewed_roster=True,
            people=[dict(id=p['id'],share='1',reason='',payments=[dict(payer_id=p['payer_id'],share='1')]) for p in people],
            items=[dict(id=uuid.uuid4().hex[:16],name='包房',amount='100',scope='common',mode='shares',kind='expense',allocations=[],reason='')],
            note='',reason='核对收款方式',payment_codes=codes or [])

    def publish(self,data,url=None):
        url=url or self.url;status,preview=self.owner.request(url+'/settlement/preview','POST',data);self.assertEqual(status,200,preview)
        return self.owner.request(url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})

    def test_private_library_deduplicates_bytes_without_merging_accounts_or_types(self):
        wechat=self.upload();same=self.upload();alipay=self.upload('alipay');other=self.upload(client=self.other)
        self.assertEqual(wechat['id'],same['id']);self.assertNotEqual(wechat['id'],alipay['id']);self.assertNotEqual(wechat['id'],other['id'])
        self.assertEqual(len(self.owner.request('/api/payment-codes')[1]['codes']),2)
        self.assertEqual(len(self.other.request('/api/payment-codes')[1]['codes']),1)
        self.assertEqual(self.other.request(wechat['url'])[0],404)
        self.assertEqual(self.owner.opener.open(self.base+wechat['url']).read(),test_png())
        digest=hashlib.sha256(test_png()).hexdigest()
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM image_assets WHERE digest=?',(digest,)).fetchone()[0],1)
            self.assertEqual(media.asset_path(media.root(db),digest).read_bytes(),test_png())
        self.assertEqual(self.owner.request('/images/'+digest[:2]+'/'+digest+'.png')[0],404)

    def test_three_categories_reuse_across_events_without_blob_copies(self):
        codes=[self.upload(kind) for kind in payment_codes.KINDS]
        choices=[dict(kind=c['kind'],code_id=c['id']) for c in codes]
        data=self.data(choices);data['items'][0]['receipt']=base64.b64encode(test_png()).decode()
        status,event=self.publish(data);self.assertEqual(status,200,event)
        self.assertEqual([c['kind'] for c in event['settlement']['payment_codes']],list(payment_codes.KINDS))
        for code in event['settlement']['payment_codes']:self.assertEqual(self.other.opener.open(self.base+code['url']).read(),test_png())
        second=self.new_event();url='/api/events/'+second['id'];self.assertEqual(self.publish(self.data(choices,url),url)[0],200)
        with storage.connect(server.DB) as db:
            self.assertIsNone(db.execute('SELECT qr_image FROM settlements WHERE event_id=?',(event['id'],)).fetchone()[0])
            self.assertIsNone(db.execute('SELECT qr_image FROM settlement_history WHERE event_id=?',(event['id'],)).fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM settlement_receipts WHERE event_id=?',(event['id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM settlement_receipt_images WHERE event_id=?',(event['id'],)).fetchone()[0],1)

    def test_any_account_can_presave_codes_without_organizing_an_event(self):
        code=self.upload('alipay',client=self.other,name='提前存好的码')
        self.assertEqual(self.other.request('/api/payment-codes')[1]['codes'],[code])
        self.assertEqual(self.owner.request('/api/payment-codes')[1]['codes'],[])
        self.assertEqual(self.owner.request(code['url'])[0],404)
        self.assertEqual(self.other.request('/api/payment-codes/'+code['id'],'DELETE',{})[0],200)
        self.assertEqual(self.other.request('/api/payment-codes')[1]['codes'],[])

    def test_bill_only_named_upload_stays_out_of_profile_until_explicitly_saved(self):
        raw=test_png();image=base64.b64encode(raw).decode();name='本次后台後臺 <test>'
        data=self.data([dict(kind='wechat',name=name,image=image)])
        status,event=self.publish(data);self.assertEqual(status,200,event)
        bill=event['settlement'];self.assertEqual(bill['payment_codes'][0]['name'],name)
        self.assertEqual(self.owner.request('/api/payment-codes')[1]['codes'],[])
        self.assertEqual(self.other.opener.open(self.base+bill['payment_codes'][0]['url']).read(),raw)
        # Optional profile persistence is separate from the immutable bill.
        code=self.upload('wechat',image=raw,name=name)
        data.update(base_revision=event['revision'],base_version=1,payment_codes=[dict(kind='wechat',code_id=code['id'])])
        status,event=self.publish(data);self.assertEqual(status,200,event)
        self.assertEqual(event['settlement']['version'],1)
        self.assertEqual(self.owner.request('/api/payment-codes/'+code['id'],'DELETE',{})[0],200)
        self.assertEqual(self.other.opener.open(self.base+bill['payment_codes'][0]['url']).read(),raw)

    def test_bill_only_name_limits_do_not_write_partial_bill_or_profile(self):
        data=self.data([dict(kind='other',name='x'*41,image=base64.b64encode(test_png()).decode())])
        self.assertEqual(self.owner.request(self.url+'/settlement/preview','POST',data)[0],400)
        self.assertIsNone(self.owner.request(self.url)[1]['settlement'])
        self.assertEqual(self.owner.request('/api/payment-codes')[1]['codes'],[])

    def test_cannot_select_foreign_code_wrong_type_duplicate_or_untrusted_reference(self):
        owned=self.upload();foreign=self.upload(client=self.other)
        invalids=[[dict(kind='wechat',code_id=foreign['id'])],[dict(kind='alipay',code_id=owned['id'])],
                  [dict(kind='wechat',code_id=owned['id'])]*2,[dict(kind='wechat',code_id=['invalid'])],
                  [dict(kind='other',version=99)],[dict(kind='other',digest='0'*64)],
                  [dict(kind='crypto',code_id=owned['id'])]]
        for choices in invalids:
            status,_=self.owner.request(self.url+'/settlement/preview','POST',self.data(choices))
            self.assertIn(status,(400,404))
        self.assertEqual(self.owner.request('/api/payment-codes','POST',dict(kind='wechat',image='bad'))[0],400)
        self.assertEqual(self.owner.request('/api/payment-codes','POST',dict(kind='unknown',image='bad'))[0],400)
        data=self.data([dict(kind='wechat',code_id=owned['id'])]);data.update(total_amount='100',headcount=1)
        self.assertEqual(self.owner.request(self.url+'/settlement','PUT',data)[0],409)

    def test_preview_is_read_only_and_removal_between_preview_and_publish_is_safe(self):
        code=self.upload();data=self.data([dict(kind='wechat',code_id=code['id'])])
        with storage.connect(server.DB) as db:before=snapshot(db)
        status,preview=self.owner.request(self.url+'/settlement/preview','POST',data);self.assertEqual(status,200,preview)
        with storage.connect(server.DB) as db:preserved(db,before)
        self.assertEqual(self.owner.request('/api/payment-codes/'+code['id'],'DELETE',{})[0],200)
        self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})[0],404)
        self.assertIsNone(self.owner.request(self.url)[1]['settlement'])

    def test_archive_and_replacement_keep_published_history_images_and_labels(self):
        first=self.upload(name='微信后台原文');data=self.data([dict(kind='wechat',code_id=first['id'])]);status,event=self.publish(data);self.assertEqual(status,200,event)
        first_url=event['settlement']['payment_codes'][0]['url']
        self.assertEqual(self.other.request('/api/payment-codes/'+first['id'],'DELETE',{})[0],404)
        self.assertEqual(self.owner.request('/api/payment-codes/'+first['id'],'DELETE',{})[0],200)
        self.assertEqual(self.owner.request(first['url'])[0],404)
        self.assertEqual(self.other.opener.open(self.base+first_url).read(),test_png())
        second_raw=test_png(b'\x00\x00\x00');second=self.upload('alipay',image=second_raw,name='支付宝新码')
        data.update(base_revision=event['revision'],base_version=1,payment_codes=[dict(kind='alipay',code_id=second['id'])])
        status,event=self.publish(data);self.assertEqual(status,200,event)
        self.assertEqual(event['settlement']['version'],2)
        revisions=self.owner.request(self.url+'/settlement/history')[1]['revisions']
        self.assertEqual(revisions[-1]['payment_codes'][0]['name'],'微信后台原文')
        self.assertTrue(any('收款' in item for item in revisions[0]['detail']['changes']))
        self.assertEqual(self.owner.opener.open(self.base+first_url).read(),test_png())
        self.assertEqual(self.owner.opener.open(self.base+event['settlement']['payment_codes'][0]['url']).read(),second_raw)
        with storage.connect(server.DB) as db:
            for table in ('settlement_code_images','image_assets'):
                with self.assertRaises(sqlite3.IntegrityError):db.execute('DELETE FROM '+table)

    def test_handover_keeps_frozen_code_but_does_not_grant_previous_owners_library(self):
        code=self.upload();data=self.data([dict(kind='wechat',code_id=code['id'])]);status,event=self.publish(data);self.assertEqual(status,200)
        with storage.connect(server.DB) as db:
            other_name=self.other.request('/api/me')[1]['nickname']
            other=db.execute('SELECT id FROM users WHERE nickname=?',(other_name,)).fetchone()[0]
            db.execute('UPDATE events SET owner_id=? WHERE id=?',(other,event['id']))
        self.assertEqual(self.other.request(code['url'])[0],404)
        data.update(base_revision=event['revision'],base_version=1)
        self.assertEqual(self.other.request(self.url+'/settlement/preview','POST',data)[0],404)
        data['payment_codes']=[dict(kind='wechat',version=1)]
        self.assertEqual(self.other.request(self.url+'/settlement/preview','POST',data)[0],200)

    def test_same_selection_is_noop_but_type_or_label_change_requires_reason_and_new_version(self):
        code=self.upload(name='原称呼');data=self.data([dict(kind='wechat',code_id=code['id'])]);status,event=self.publish(data);self.assertEqual(status,200)
        data.update(base_revision=event['revision'],base_version=1,payment_codes=[dict(kind='wechat',version=1)])
        self.assertEqual(self.publish(data)[1]['settlement']['version'],1)
        renamed=self.upload(name='新称呼後臺');data['payment_codes']=[dict(kind='wechat',code_id=renamed['id'])];data['reason']=''
        self.assertEqual(self.owner.request(self.url+'/settlement/preview','POST',data)[0],400)
        data['reason']='改收款说明';status,event=self.publish(data);self.assertEqual(status,200);self.assertEqual(event['settlement']['version'],2)
        self.assertIn('payment_codes',self.owner.request(self.url+'/settlement/history')[1]['revisions'][0]['changed_fields'])
        alipay=self.upload('alipay',name='新称呼後臺');data.update(base_revision=event['revision'],base_version=2,payment_codes=[dict(kind='alipay',code_id=alipay['id'])])
        self.assertEqual(self.publish(data)[1]['settlement']['version'],3)

    def test_private_event_images_follow_access_and_library_stays_private(self):
        code=self.upload();status,event=self.publish(self.data([dict(kind='wechat',code_id=code['id'])]));self.assertEqual(status,200)
        with storage.connect(server.DB) as db:db.execute("UPDATE events SET visibility='invitation' WHERE id=?",(event['id'],))
        self.assertEqual(self.other.request(event['settlement']['payment_codes'][0]['url'])[0],404)
        self.assertEqual(self.other.request(code['url'])[0],404)

    def test_legacy_blob_remains_original_and_can_be_saved_to_library(self):
        raw=test_png();eid=self.event['id']
        with storage.connect(server.DB) as db:
            db.execute('INSERT INTO settlements(event_id,total_cents,headcount,qr_image,note,updated_at) VALUES(?,100,1,?,\'旧备注\',\'2026-11-01\')',(eid,raw))
            db.execute("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) SELECT ?,1,100,1,'旧备注',?,'2026-11-01',owner_id,'旧称呼','published','[]' FROM events WHERE id=?",(eid,raw,eid))
            before=snapshot(db)
        event=self.owner.request(self.url)[1];self.assertEqual(event['settlement']['payment_codes'][0]['kind'],'other')
        self.assertEqual(self.owner.opener.open(self.base+event['settlement']['payment_codes'][0]['url']).read(),raw)
        source=dict(event_id=eid,version=1,kind='other')
        self.assertEqual(self.other.request('/api/payment-codes','POST',dict(kind='wechat',source=source))[0],403)
        status,code=self.owner.request('/api/payment-codes','POST',dict(kind='wechat',source=source));self.assertEqual(status,201,code)
        with storage.connect(server.DB) as db:
            # Only the new library/asset/request rows grow; the original bill is exact.
            for table in ('settlements','settlement_history'):
                preserved(db,{table:before[table]})

    def test_failed_audit_rolls_back_references_and_orphan_file_is_unreachable(self):
        raw=test_png(b'\x00\xff\x01');data=self.data();data['items'][0]['receipt']=base64.b64encode(raw).decode()
        preview=self.owner.request(self.url+'/settlement/preview','POST',data)[1]
        with mock.patch('qgroup_core.audit.append',side_effect=sqlite3.IntegrityError('injected')):
            self.assertEqual(self.owner.request(self.url+'/settlement/detailed','PUT',{**data,'preview_token':preview['preview_token']})[0],500)
        with storage.connect(server.DB) as db:
            for table in ('settlement_history','settlement_details','settlement_code_images','settlement_receipt_images'):
                self.assertEqual(db.execute('SELECT count(*) FROM '+table+' WHERE event_id=?',(self.event['id'],)).fetchone()[0],0)
            self.assertIsNone(db.execute('SELECT 1 FROM image_assets WHERE digest=?',(hashlib.sha256(raw).hexdigest(),)).fetchone())
        self.assertEqual(self.owner.request(self.url+'/settlement/history/1/receipts/'+data['items'][0]['id'])[0],404)

    def test_backup_restores_database_and_all_referenced_files_and_rejects_missing_file(self):
        code=self.upload();self.assertEqual(self.publish(self.data([dict(kind='wechat',code_id=code['id'])]))[0],200)
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);dbfile,archive,count=backup(server.DB,folder/'backups');self.assertGreater(count,0)
            restored=folder/'restored';restored.mkdir();(restored/'kanban.sqlite3').write_bytes(dbfile.read_bytes())
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    self.assertRegex(member.name,r'^images/[a-f0-9]{2}/[a-f0-9]{64}\.png$')
                    target=restored/member.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.extractfile(member).read())
            with storage.connect(restored/'kanban.sqlite3') as db:
                for digest,size in db.execute('SELECT digest,size FROM image_assets'):
                    self.assertEqual(len(media.read(db,digest)),size)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            with storage.connect(server.DB) as db:path=media.asset_path(media.root(db),hashlib.sha256(test_png()).hexdigest())
            moved=path.with_suffix('.saved');path.rename(moved)
            before=set((folder/'backups').iterdir())
            try:
                with self.assertRaises(FileNotFoundError):backup(server.DB,folder/'backups')
                self.assertEqual(set((folder/'backups').iterdir()),before)
            finally:moved.rename(path)
