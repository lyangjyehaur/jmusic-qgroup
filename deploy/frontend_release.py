#!/usr/bin/env python3
"""Build from approved main; activate immutable frontend files without Docker.

No database, credentials, container lifecycle or reverse proxy is modified.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tarfile
from datetime import datetime, timezone
from urllib.parse import urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
SHA = re.compile(r"[a-f0-9]{40}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
ASSET = re.compile(r"assets/[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+(?:\.(?:br|gz))?\Z")
FIXED = {"index.html", "sw.js", "music/sw.js", "manifest.webmanifest", "music/manifest.json", "icon.svg", "icon-192.png", "icon-512.png"}
BACKEND_INPUTS = ["apps/api", "apps/bot", "packages", "package.json", "package-lock.json", "tsconfig.rebuild.json", "tools/rebuild/build-api.mjs", "deploy/unified.Dockerfile"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def fingerprint(commit):
    if not SHA.fullmatch(commit):
        raise ValueError("A full commit SHA is required")
    # build-api.mjs rejects .test.ts dependencies in runtime bundles. Keep all
    # other support files, runtime sources, package inputs and build rules pinned.
    entries = git("ls-tree", "-r", "-z", commit, "--", *BACKEND_INPUTS).split(b"\0")
    return digest(b"\0".join(entry for entry in entries if entry and not entry.partition(b"\t")[2].endswith(b".test.ts")))


def allowed(name):
    return name in FIXED or name.removesuffix(".br").removesuffix(".gz") in FIXED or bool(ASSET.fullmatch(name))


def verify(folder, expected_hash, api_commit):
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('A regular release directory is required')
    raw = (folder / "frontend-release.json").read_bytes()
    if not HASH.fullmatch(expected_hash) or digest(raw) != expected_hash:
        raise ValueError("Frontend manifest digest differs")
    m = json.loads(raw)
    if m.get("version") != 1 or m.get("source") != "origin-main" or m.get("apiCommit") != api_commit:
        raise ValueError("Frontend source or API version differs")
    if not all(SHA.fullmatch(m.get(k, "")) for k in ("commit", "tree", "apiCommit")) or not HASH.fullmatch(m.get("backendFingerprint", "")) or not HASH.fullmatch(m.get("buildId", "")):
        raise ValueError("Invalid frontend metadata")
    files = m["files"]
    if not FIXED.issubset(files) or not any(n.startswith("assets/") and n.endswith(".js") for n in files) or not any(n.startswith("assets/") and n.endswith(".css") for n in files):
        raise ValueError("Incomplete frontend build")
    actual = set()
    for p in folder.rglob("*"):
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise ValueError("Only regular release files are accepted")
        if p.is_file():
            actual.add(p.relative_to(folder).as_posix())
    if actual != set(files) | {"frontend-release.json"}:
        raise ValueError("Unexpected or missing release files")
    for name, sha in files.items():
        if not allowed(name) or not HASH.fullmatch(sha) or digest((folder / name).read_bytes()) != sha:
            raise ValueError("Invalid frontend file: " + name)
    html = (folder / "index.html").read_text()
    if f'name="qgroup-build" content="{m["buildId"]}"' not in html:
        raise ValueError("Shell and worker build version differ")
    # The legacy music worker only unregisters its old scope. It deliberately
    # has no build constant or fetch handler; its exact bytes are hashed above.
    if m["buildId"] not in (folder / 'sw.js').read_text():
        raise ValueError("Worker build version differs")
    for name in re.findall(r'(?:src|href)="/([^"?#]+)"', html):
        if name not in files:
            raise ValueError("Missing shell dependency: " + name)
    return m


def pack(folder, output):
    """Portable transport: omit macOS resource forks and filesystem xattrs."""
    folder, output = Path(folder), Path(output)
    with tarfile.open(output, 'x:gz', format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(folder.rglob('*')):
            archive.add(path, arcname=path.relative_to(folder).as_posix(), recursive=False)
    return digest(output.read_bytes())


def build(commit, api_commit, output):
    if not SHA.fullmatch(commit) or not SHA.fullmatch(api_commit):
        raise ValueError("Explicit full source and API SHAs are required")
    approved = subprocess.check_output(["python3", str(ROOT / "deploy/check_release_source.py"), "--commit", commit], text=True).strip()
    if approved != commit or fingerprint(commit) != fingerprint(api_commit):
        raise ValueError("Backend inputs changed; deploy and verify the API first")
    output = Path(output)
    archive_path = Path(str(output) + '.tar.gz')
    if not output.is_absolute() or output.exists() or archive_path.exists():
        raise ValueError("A new absolute output directory is required")
    # Only the approved commit enters the build; no checkout files are copied.
    with tempfile.TemporaryDirectory(prefix="qgroup-frontend-build-") as tmp:
        stage = Path(tmp)
        archive = stage / "source.tar"
        archive.write_bytes(git("archive", "--format=tar", commit))
        subprocess.run(["tar", "-xf", str(archive), "-C", tmp], check=True)
        archive.unlink()
        for command in (["npm", "ci", "--no-audit", "--no-fund"], ["npm", "run", "build:frontend"]):
            subprocess.run(command, cwd=stage, check=True)
        web = stage / ".rebuild-dist/web"
        html = (web / "index.html").read_text()
        build_id = re.search(r'name="qgroup-build" content="([a-f0-9]{64})"', html).group(1)
        files = {p.relative_to(web).as_posix(): digest(p.read_bytes()) for p in sorted(web.rglob("*")) if p.is_file()}
        manifest = dict(version=1, source="origin-main", commit=commit, tree=git("rev-parse", commit + "^{tree}").decode().strip(), apiCommit=api_commit, backendFingerprint=fingerprint(commit), buildId=build_id, files=files)
        raw = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
        (web / "frontend-release.json").write_bytes(raw)
        verify(web, digest(raw), api_commit)
        shutil.copytree(web, output)
    archive_sha = pack(output, archive_path)
    return {"artifact": str(output), "archive": str(archive_path), "archiveSha256": archive_sha, "manifestSha256": digest(raw), "commit": commit, "apiCommit": api_commit, "buildId": build_id}


def activate(artifact, root, manifest_sha256, api_commit, api_url=None, release_manifest=None):
    """Validate everything before switching; retained assets support old tabs."""
    m = verify(artifact, manifest_sha256, api_commit)
    if api_url:
        url = urlparse(api_url)
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1', 'localhost') or url.path not in ('', '/') or url.username or url.password or url.query or url.fragment:
            raise ValueError('Use the local API origin without credentials')
        with urlopen(api_url.rstrip('/') + '/api/v2/version', timeout=5) as response:
            version = json.load(response)
        if version.get('commit') != api_commit or version.get('service') != 'web':
            raise ValueError('The running API version differs')
    runtime = None
    if release_manifest:
        if not api_url:
            raise ValueError('Verify the local API before updating the runtime manifest')
        runtime = json.loads(Path(release_manifest).read_text())
        if runtime['services']['web']['sourceCommit'] != api_commit:
            raise ValueError('Runtime manifest API version differs')
    artifact, root = Path(artifact).resolve(), Path(root)
    if not root.is_absolute() or root.is_symlink() or str(root) in ("/", "/var", "/etc", "/opt"):
        raise ValueError("An explicit frontend-only root is required")
    managed = {'assets', 'releases', 'current', 'activation.json', '.release.lock'}
    if root.exists() and any(p.name not in managed for p in root.iterdir()):
        raise ValueError('Refusing a directory containing unrelated files')
    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    root.chmod(0o755)  # Deployment commonly runs with umask 077.
    with (root / ".release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for directory in ("assets", "releases"):
            path = root / directory
            if path.is_symlink():
                raise ValueError("Release storage must not be a symlink")
            path.mkdir(exist_ok=True, mode=0o755)
            path.chmod(0o755)
        release_id = m["commit"] + "-" + manifest_sha256[:16]
        target = root / "releases" / release_id
        if target.exists():
            verify(target, manifest_sha256, api_commit)
        else:
            temp = Path(tempfile.mkdtemp(prefix=".incoming-", dir=root / "releases"))
            try:
                shutil.copytree(artifact, temp, dirs_exist_ok=True)
                verify(temp, manifest_sha256, api_commit)
                # Public artifacts contain no credentials. The service reads only.
                for p in temp.rglob("*"):
                    p.chmod(0o755 if p.is_dir() else 0o644)
                temp.chmod(0o755)
                temp.rename(target)
            finally:
                if temp.exists():
                    shutil.rmtree(temp)
        for name, sha in m["files"].items():
            if not name.startswith("assets/"):
                continue
            dest = root / name
            if dest.is_symlink() or dest.exists() and digest(dest.read_bytes()) != sha:
                raise ValueError("Immutable asset collision: " + name)
        for name in m["files"]:
            if name.startswith("assets/") and not (root / name).exists():
                # Complete files only; current still points at the old shell.
                temp = root / "assets" / (".incoming-" + os.urandom(8).hex())
                shutil.copyfile(target / name, temp)
                temp.chmod(0o644)
                os.replace(temp, root / name)
        previous = os.readlink(root / "current") if (root / "current").is_symlink() else None
        if (root / "current").exists() and previous is None:
            raise ValueError("Current must be a managed release symlink")
        result = dict(release=release_id, previous=previous, commit=m["commit"], apiCommit=api_commit, manifestSha256=manifest_sha256, buildId=m['buildId'], activatedAt=datetime.now(timezone.utc).isoformat(), containersRestarted=False)
        runtime_temp = None
        if runtime is not None:
            runtime['frontend'] = dict(result, root=str(root))
            runtime_temp = Path(str(release_manifest) + '.frontend-pending')
            with runtime_temp.open('x') as output:
                output.write(json.dumps(runtime, indent=2) + '\n')
            runtime_temp.chmod(0o600)
        pointer = root / (".current-" + os.urandom(8).hex())
        pointer.symlink_to("releases/" + release_id)
        os.replace(pointer, root / "current")
        if runtime_temp:
            try:
                os.replace(runtime_temp, release_manifest)
            except OSError:
                if previous:
                    pointer.symlink_to(previous)
                    os.replace(pointer, root / 'current')
                else:
                    (root / 'current').unlink()
                runtime_temp.unlink(missing_ok=True)
                raise
        receipt = root / (".receipt-" + os.urandom(8).hex())
        receipt.write_text(json.dumps(result) + "\n")
        os.replace(receipt, root / "activation.json")
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--commit", required=True)
    b.add_argument("--api-commit", required=True)
    b.add_argument("--output", required=True)
    for name in ("verify", "activate"):
        a = sub.add_parser(name)
        a.add_argument("--artifact", required=True)
        a.add_argument("--manifest-sha256", required=True)
        a.add_argument("--api-commit", required=True)
        if name == "activate":
            a.add_argument("--root", required=True)
            a.add_argument("--api-url")
            a.add_argument("--release-manifest")
    args = p.parse_args()
    if args.command == "build":
        result = build(args.commit, args.api_commit, args.output)
    elif args.command == "verify":
        m = verify(args.artifact, args.manifest_sha256, args.api_commit)
        result = {"verified": True, "commit": m["commit"], "apiCommit": m["apiCommit"]}
    else:
        result = activate(args.artifact, args.root, args.manifest_sha256, args.api_commit, args.api_url, args.release_manifest)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
