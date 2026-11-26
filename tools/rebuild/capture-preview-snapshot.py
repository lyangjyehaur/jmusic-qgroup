#!/usr/bin/env python3
"""Capture a consistent, credential-free production copy for local previews."""
import argparse
import json
import pathlib
import shutil
import subprocess

REMOTE = r'''
import datetime, hashlib, json, os, pathlib, secrets, shutil, sqlite3, tempfile
source = pathlib.Path('/var/lib/qgroup-unified/data/kanban.sqlite3')
root = pathlib.Path(tempfile.mkdtemp(prefix='qgroup-preview-'))
try:
    journal = source.with_suffix('.erasures.jsonl')
    ledger_before = journal.read_bytes()
    live = sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True, timeout=10)
    copy = sqlite3.connect(root / 'state.sqlite3')
    live.backup(copy)
    live.close()
    copy.execute('PRAGMA journal_mode=DELETE')
    copy.execute('PRAGMA foreign_keys=ON')
    if journal.read_bytes() != ledger_before:
        raise RuntimeError('Deletion ledger changed during capture; retry with a fresh snapshot')
    applied = {r[0] for r in copy.execute('SELECT request_id FROM erasure_applied')}
    intents = [json.loads(line) for line in ledger_before.splitlines() if line.strip()]
    ids = {e.get('request_id', e.get('markerId', e.get('requestId'))) for e in intents}
    if applied != ids:
        raise RuntimeError('Snapshot deletion markers and ledger differ')
    for entry in intents:
        if entry.get('version') in (1, 2):
            receipt = copy.execute('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?', (entry['requestId'],)).fetchone()
            if receipt != (entry['signature'], entry['secretHash']):
                raise RuntimeError('Snapshot deletion receipt differs')
    counts = {t: copy.execute('SELECT count(*) FROM ' + t).fetchone()[0] for t in ['events', 'attendees', 'users']}
    tables = {r[0] for r in copy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    removed = []
    for table in ['browser_accounts', 'browser_sessions', 'visitor_sessions', 'admin_sessions', 'auth_requests', 'login_attempts', 'qq_attempts', 'device_links', 'music_claim_attempts', 'music_claim_intents', 'music_profile_receipts', 'request_results', 'bot_outbox', 'bot_runtime']:
        if table in tables:
            copy.execute('DELETE FROM ' + table)
            removed.append(table)
    for (user_id,) in copy.execute('SELECT id FROM users').fetchall():
        copy.execute('UPDATE users SET token_hash=? WHERE id=?', (secrets.token_hex(32), user_id))
    for table, column in [('events', 'invite_token'), ('attendees', 'invitation_token'), ('attendee_claims', 'token'), ('management_invitations', 'token')]:
        for (rowid,) in copy.execute('SELECT rowid FROM ' + table + ' WHERE ' + column + ' IS NOT NULL').fetchall():
            copy.execute('UPDATE ' + table + ' SET ' + column + '=? WHERE rowid=?', (secrets.token_hex(32), rowid))
    copy.execute("UPDATE music_legacy_profiles SET pin_hash=''")
    # Archived source documents can also contain old credentials. Redact only the
    # disposable copy, restoring its exact history triggers before validation.
    def redact(value):
        if isinstance(value, dict):
            return {k: '' if any(part in k.lower() for part in ('token', 'password', 'secret', 'credential')) or k.lower() in ('pin', 'pinhash', 'pin_hash', 'pinproof', 'pin_proof') else redact(v) for k, v in value.items()}
        if isinstance(value, list):
            return [redact(v) for v in value]
        if isinstance(value, str) and value.startswith(('{', '[')):
            try:
                parsed = json.loads(value)
                cleaned = redact(parsed)
                return json.dumps(cleaned, ensure_ascii=False) if parsed != cleaned else value
            except ValueError:
                pass
        return value
    triggers = copy.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND upper(sql) LIKE '%BEFORE UPDATE%'").fetchall()
    for name, _ in triggers:
        copy.execute('DROP TRIGGER "' + name.replace('"', '""') + '"')
    for table in tables - {'privacy_receipts'}:
        quoted = '"' + table.replace('"', '""') + '"'
        columns = [r[1] for r in copy.execute('PRAGMA table_info(' + quoted + ')') if r[1].endswith('_json')]
        for column in columns:
            for rowid, raw in copy.execute('SELECT rowid,"' + column + '" FROM ' + quoted).fetchall():
                try:
                    parsed = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                cleaned = redact(parsed)
                if cleaned != parsed:
                    copy.execute('UPDATE ' + quoted + ' SET "' + column + '"=? WHERE rowid=?', (json.dumps(cleaned, ensure_ascii=False), rowid))
    for _, sql in triggers:
        copy.execute(sql)
    copy.execute('UPDATE events SET bot_enabled=0')
    if 'time_polls' in tables:
        copy.execute('UPDATE time_polls SET bot_enabled=0')
    copy.commit()
    copy.execute('VACUUM')
    if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('Snapshot integrity check failed')
    if copy.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise RuntimeError('Snapshot foreign key check failed')
    for digest, size, mime in copy.execute('SELECT digest,size,mime FROM image_assets'):
        if mime != 'image/png' or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise RuntimeError('Invalid image reference')
        raw = (source.parent / 'images' / digest[:2] / (digest + '.png')).read_bytes()
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError('Image changed or digest differs')
        folder = root / 'images' / digest[:2]
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        (folder / (digest + '.png')).write_bytes(raw)
    copy.close()
    (root / 'state.erasures.jsonl').write_bytes(ledger_before)
    release = json.loads(pathlib.Path('/opt/qgroup/release-manifest.json').read_text())
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_file():
            os.chmod(path, 0o600)
            raw = path.read_bytes()
            files.append({'path': str(path.relative_to(root)), 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    manifest = {'version': 1, 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source': 'server2 production snapshot',
        'frontendCommit': release.get('frontend', {}).get('commit'), 'apiCommit': release.get('services', {}).get('web', {}).get('sourceCommit'),
        'counts': counts, 'removedTables': removed, 'credentialsReplaced': True, 'deliveryDisabled': True, 'files': files}
    (root / 'preview-snapshot.json').write_text(json.dumps(manifest, indent=2) + '\n')
    os.chmod(root / 'preview-snapshot.json', 0o600)
    print(json.dumps({'root': str(root), 'capturedAt': manifest['capturedAt'], 'counts': counts}))
except BaseException:
    shutil.rmtree(root)
    raise
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    repository = pathlib.Path(__file__).resolve().parents[2]
    private_root = repository / 'artifacts' / 'private'
    destination = pathlib.Path(args.destination).resolve()
    if not destination.is_relative_to(private_root) or destination == private_root or destination.exists():
        parser.error('Use a new directory under artifacts/private')
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'server2', 'python3 -'], input=REMOTE, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Production snapshot capture failed: ' + result.stderr[-1600:])
    info = json.loads(result.stdout)
    remote = info['root']
    if not remote.startswith('/tmp/qgroup-preview-') or not remote.removeprefix('/tmp/qgroup-preview-') or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_' for c in remote.removeprefix('/tmp/qgroup-preview-')):
        raise RuntimeError('Unexpected snapshot staging path')
    try:
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination.mkdir(mode=0o700)
        subprocess.run(['scp', '-q', '-r', 'server2:' + remote + '/.', str(destination)], check=True)
        import hashlib
        manifest = json.loads((destination / 'preview-snapshot.json').read_text())
        for record in manifest['files']:
            path = destination / record['path']
            if not path.resolve().is_relative_to(destination) or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
                raise RuntimeError('Transferred snapshot differs')
            path.chmod(0o600)
        (destination / 'preview-snapshot.json').chmod(0o600)
        print(json.dumps({'destination': str(destination), 'capturedAt': info['capturedAt'], 'counts': info['counts']}, ensure_ascii=False))
    except BaseException:
        if destination.exists():
            shutil.rmtree(destination)
        raise
    finally:
        subprocess.run(['ssh', '-o', 'BatchMode=yes', 'server2', 'rm -rf -- ' + remote], check=True)


if __name__ == '__main__':
    main()
