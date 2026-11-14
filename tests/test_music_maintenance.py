import json
from pathlib import Path
import shutil
import tempfile
import unittest

from deploy.prepare_music_snapshot import prepare
from music_site.identity_store import Store
from music_site.maintenance import backup_pair, replay, service_lock


class MusicMaintenanceTests(unittest.TestCase):
    def test_snapshot_only_reuses_unambiguous_active_account_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            data={'members':{qq:{'qq':qq,'boardUserId':uid,'selection':['e1']} for qq,uid in
                             [('10001','valid'),('10002','duplicate'),('10003','duplicate'),('10004','closed')]},
                  'entries':{'e1':{'id':'e1','text':'Artist'}},'settings':{'adminPasswordHash':'old-hash'}}
            (root/'snapshot.json').write_text(json.dumps(data));(root/'active.json').write_text(json.dumps(['valid','duplicate']))
            summary=prepare(root/'snapshot.json',root/'active.json',root/'out')
            self.assertEqual(summary['prelinked'],1)
            self.assertEqual(summary['conflicting_records'],2)
            self.assertEqual(summary['invalid_records'],1)
            store=Store(root/'out/identity.sqlite3')
            self.assertEqual(store.link_for_qq('10001')['user_id'],'valid')
            self.assertIsNone(store.link_for_qq('10002'))
            copied=json.loads((root/'out/data.json').read_text())
            self.assertEqual(copied['members'],data['members'])
            self.assertNotEqual(copied['settings']['adminPasswordHash'],'old-hash')

    def test_paired_backup_and_erasure_replay_after_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            data={'members':{'10001':{'qq':'10001'},'10002':{'qq':'10002'}},
                  'entries':{'e1':{'createdBy':'10001','text':'Artist'}},
                  'shouts':[{'qq':'10001','text':'private'}],'shoutHistory':[{'qq':'10001'}]}
            (root/'data.json').write_text(json.dumps(data))
            store=Store(root/'identity.sqlite3');store.import_prelinks([{'qq':'10001','user_id':'uid'}])
            backup_pair(root,store)
            backup=next((root/'paired-backups').iterdir())
            self.assertTrue((backup/'data.json').is_file());self.assertTrue((backup/'identity.sqlite3').is_file())
            (root/'erasures.jsonl').write_text(json.dumps({'qq':'10001'})+'\n')
            replay(root,store)
            self.assertIsNone(store.link_for_qq('10001'))
            erased=json.loads((root/'data.json').read_text())
            self.assertNotIn('10001',erased['members']);self.assertIn('10002',erased['members'])
            self.assertEqual(erased['entries']['e1']['createdBy'],'')
            self.assertEqual(erased['shouts'],[]);self.assertEqual(erased['shoutHistory'],[])
            shutil.copyfile(backup/'data.json',root/'data.json')
            shutil.copyfile(backup/'identity.sqlite3',root/'identity.sqlite3')
            replay(root,Store(root/'identity.sqlite3'))
            self.assertNotIn('10001',json.loads((root/'data.json').read_text())['members'])
            self.assertIsNone(Store(root/'identity.sqlite3').link_for_qq('10001'))

    def test_offline_maintenance_cannot_write_while_service_holds_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            lock=service_lock(folder)
            try:
                with self.assertRaises(RuntimeError): service_lock(folder)
            finally: lock.close()
            service_lock(folder).close()
