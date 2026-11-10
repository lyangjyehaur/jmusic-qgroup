"""Exercise the release gate against isolated local Git repositories."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(shutil.which("git"), "release source checks require Git")
class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root = base / "source"
        self.root.mkdir()
        self.remote = base / "origin.git"
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.root / "deploy").mkdir()
        self.script = self.root / "deploy/check_release_source.py"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "deploy/check_release_source.py", self.script)
        (self.root / "source.txt").write_text("initial\n")
        self.initial = self.commit("initial")
        self.git("init", "--bare", str(self.remote))
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "origin", "main")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def check(self, commit):
        return subprocess.run([sys.executable, str(self.script), "--commit", commit],
                              capture_output=True, text=True)

    def assert_rejected(self, commit):
        result = self.check(commit)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr)

    def test_accepts_pushed_main_and_refreshes_remote_tracking_ref(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.check(self.initial)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.initial)
        self.assertEqual(self.git("rev-parse", "origin/main"), self.initial)

    def test_accepts_published_ancestor(self):
        (self.root / "source.txt").write_text("next\n")
        self.commit("next")
        self.git("push", "origin", "main")
        self.assertEqual(self.check(self.initial).returncode, 0)

    def test_rejects_unpushed_main_commit(self):
        (self.root / "source.txt").write_text("not pushed\n")
        self.assert_rejected(self.commit("not pushed"))

    def test_rejects_pushed_feature_outside_main(self):
        self.git("switch", "-c", "codex/feature")
        (self.root / "source.txt").write_text("feature\n")
        feature = self.commit("feature")
        self.git("push", "origin", "codex/feature")
        self.assert_rejected(feature)

    def test_rejects_modified_tracked_files(self):
        (self.root / "source.txt").write_text("draft\n")
        self.assert_rejected(self.initial)

    def test_rejects_untracked_files(self):
        (self.root / "draft.txt").write_text("draft\n")
        self.assert_rejected(self.initial)

    def test_rejects_moving_refs_short_or_missing_commits(self):
        for value in ("HEAD", "main", self.initial[:7], "0" * 40):
            with self.subTest(value=value):
                self.assert_rejected(value)

    def test_rejects_unavailable_remote_even_with_cached_main(self):
        self.git("remote", "set-url", "origin", str(self.remote.parent / "missing.git"))
        self.assert_rejected(self.initial)


if __name__ == "__main__":
    unittest.main()
