import socket
import tempfile
import unittest
from pathlib import Path
from deploy.reset_test_data import archive_test_data


class ResetTests(unittest.TestCase):
    def test_archive_retains_database_wal_and_images_and_refuses_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state';state.mkdir();db=state/'test.sqlite3';db.write_bytes(b'test data')
            (state/'images').mkdir();(state/'images'/'receipt.png').write_bytes(b'image');Path(str(db)+'-wal').write_bytes(b'wal')
            with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
            archive=root/'archive';names=archive_test_data(db,archive,port)
            self.assertEqual(set(names),{'test.sqlite3','test.sqlite3-wal','images'})
            self.assertFalse(db.exists());self.assertEqual((archive/'test.sqlite3').read_bytes(),b'test data')
            self.assertEqual((archive/'images/receipt.png').read_bytes(),b'image')
            self.assertEqual((archive/'test.sqlite3-wal').read_bytes(),b'wal')
            with self.assertRaises(ValueError):archive_test_data(db,archive,port)

    def test_running_server_refuses_to_move_data(self):
        with tempfile.TemporaryDirectory() as folder,socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen();root=Path(folder);db=root/'test.sqlite3';db.write_bytes(b'data')
            with self.assertRaises(RuntimeError):archive_test_data(db,root.parent/('archive-'+root.name),listener.getsockname()[1])
            self.assertEqual(db.read_bytes(),b'data')
