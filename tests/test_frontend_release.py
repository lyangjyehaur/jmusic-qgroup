import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("frontend_release", Path(__file__).resolve().parents[1] / "deploy/frontend_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FrontendSourceTests(unittest.TestCase):
    def test_public_parent_directories_remain_readable_with_restrictive_deployment_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifact, root = Path(tmp) / 'artifact', Path(tmp) / 'public'
            artifact.mkdir()
            files = {name: b'fixture' for name in release.FIXED}
            build_id = 'd' * 64
            files['index.html'] = f'<html><meta name="qgroup-build" content="{build_id}" /></html>'.encode()
            files['sw.js'] = build_id.encode()
            files['music/sw.js'] = b'/* legacy retirement worker has no version constant */'
            files['assets/page-12345678.js'] = b'export const version=1'
            files['assets/page-12345678.css'] = b'.fixture{}'
            for name, data in files.items():
                (artifact / name).parent.mkdir(parents=True, exist_ok=True)
                (artifact / name).write_bytes(data)
            manifest = dict(version=1, source='origin-main', commit='a' * 40, tree='b' * 40, apiCommit='c' * 40, backendFingerprint='e' * 64, buildId=build_id, files={name: release.digest(data) for name, data in files.items()})
            raw = json.dumps(manifest).encode()
            (artifact / 'frontend-release.json').write_bytes(raw)
            archive = Path(tmp) / 'frontend.tar.gz'
            archive_sha = release.pack(artifact, archive)
            self.assertEqual(archive_sha, release.digest(archive.read_bytes()))
            extracted = Path(tmp) / 'extracted'
            with tarfile.open(archive) as transport:
                self.assertFalse(any(Path(name).name.startswith('._') for name in transport.getnames()))
                transport.extractall(extracted)
            release.verify(extracted, release.digest(raw), 'c' * 40)
            with self.assertRaises(FileExistsError):
                release.pack(artifact, archive)
            previous = os.umask(0o077)
            try:
                release.activate(artifact, root, release.digest(raw), 'c' * 40)
            finally:
                os.umask(previous)
            for directory in [root, root / 'assets', root / 'releases', (root / 'current').resolve()]:
                self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
            (root / 'private-config').write_text('fixture')
            with self.assertRaisesRegex(ValueError, 'unrelated'):
                release.activate(artifact, root, release.digest(raw), 'c' * 40)

    def test_frontend_changes_keep_backend_fingerprint_but_api_shared_and_lock_changes_do_not(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(release, "ROOT", Path(tmp)):
            root = Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init")
            for name in ["apps/web/ui.tsx", "apps/api/server.ts", "packages/contracts/schema.ts", "package-lock.json"]:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("baseline")
            def commit():
                git("add", ".")
                git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
                return git("rev-parse", "HEAD")
            baseline = release.fingerprint(commit())
            (root / "apps/web/ui.tsx").write_text("new layout")
            self.assertEqual(release.fingerprint(commit()), baseline)
            for name in ["apps/api/server.ts", "packages/contracts/schema.ts", "package-lock.json"]:
                (root / name).write_text("new contract")
                before = release.fingerprint(git("rev-parse", "HEAD"))
                self.assertNotEqual(release.fingerprint(commit()), before)

    def test_backend_difference_stops_before_install_or_build(self):
        with patch.object(release.subprocess, "check_output", return_value="a" * 40 + "\n"), patch.object(release, "fingerprint", side_effect=["changed", "running"]), patch.object(release.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Backend inputs changed"):
                release.build("a" * 40, "b" * 40, "/unused/frontend")
            run.assert_not_called()

    def test_failed_main_source_check_stops_before_install_or_build(self):
        with patch.object(release.subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, "source check")), patch.object(release.subprocess, "run") as run:
            with self.assertRaises(subprocess.CalledProcessError):
                release.build("a" * 40, "b" * 40, "/unused/frontend")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
