import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("frontend_release", Path(__file__).resolve().parents[1] / "deploy/frontend_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FrontendSourceTests(unittest.TestCase):
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
