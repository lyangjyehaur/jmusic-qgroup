import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {reconstructForwardLegacyResetRecovery,verifyForwardLegacyResetRecovery} from '../../../tools/migration/forward-legacy-reset-recovery';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {profileId} from '../../../tools/migration/music-codec';
import {getProfile} from './repositories';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
it.each(['linked','ABA','unlinked'] as const)('preserves actual original post-reset %s ownership, sessions and entry intents with a readonly Python oracle',async kind=>{
  const s=await legacyResetRecoveryFixture();cleanup.push(()=>s.close());
  const observed=JSON.parse(execFileSync('python3',['-c',`import os,json,sys
from pathlib import Path
os.environ['KANBAN_ORIGIN']='https://fixture.invalid';os.environ['KANBAN_MUSIC_PROXY_KEY']='synthetic-'+('a'*40)
from music_site import service,admin_links
folder=Path(sys.argv[1]);service.upstream.DATA_FILE=str(folder/'data.json');service.upstream.BACKUP_DIR=str(folder/'backups');service.STORE=service.Store(folder/'identity.sqlite3');service.upstream.data=json.loads((folder/'data.json').read_bytes())
for target in json.loads(sys.argv[2]):
 with service.STORE.connect() as db:revision=service.STORE.admin_state(db,'38888')['revision']
 admin_links.change(service.upstream.data,service.STORE,dict(qq='38888',user_id=target,base_revision=revision),'synthetic-admin')
session=service.STORE.new_session('38888');service.STORE.login_allowed('38888','192.0.2.3')
entry=service.STORE.entry_start(dict(session='synthetic-old-device',user_id='alice'),dict(selection=[dict(id='e',level=4)]),'38888')
service.upstream.save();print(json.dumps(dict(session=service.Store.digest(session),entry=service.Store.digest(entry))))
`,s.music,JSON.stringify(kind==='linked'?['alice']:kind==='ABA'?['alice','','alice']:['alice',''])],{encoding:'utf8',timeout:30000,stdio:'pipe'})) as {session:string;entry:string};
  for(const [key,name] of [['latestIdentity','identity.sqlite3'],['latestMusic','data.json']] as const){const bytes=readFileSync(join(s.music,name));s.recoveryInput[key]={bytes,sha256:forwardHash(bytes)};}
  const original=Buffer.from(s.recoveryInput.latestIdentity.bytes),result=reconstructForwardLegacyResetRecovery(s.recoveryInput),db=new Database(result.rebased.nativeImage);cleanup.push(()=>db.close());
  expect(verifyForwardLegacyResetRecovery(s.recoveryInput,result).allCandidateRowsVerified).toBe(true);expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profileId('38888'))).toEqual({user_id:kind==='unlinked'?null:'alice'});expect(getProfile(db,'later-native-user')).toEqual(getProfile(s.native,'later-native-user'));
  expect(db.prepare("SELECT 1 FROM music_legacy_identity WHERE table_name='sessions' AND json_extract(payload_json,'$.token_hash')=?").get(observed.session)).toBeDefined();expect(db.prepare("SELECT 1 FROM music_legacy_identity WHERE table_name='entry_intents' AND json_extract(payload_json,'$.token_hash')=?").get(observed.entry)).toBeDefined();
  expect(db.prepare('SELECT 1 FROM browser_sessions WHERE token_hash=?').get(observed.session)).toBeUndefined();expect(db.prepare('SELECT 1 FROM music_claim_intents WHERE id=?').get(observed.entry)).toBeUndefined();
  for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','music_pin_history','privacy_receipts','event_audit','finance_entries','settlement_history'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(s.native,table)]);
  for(const [name,bytes] of [['native',s.recoveryInput.erasures.nativeImage],['final',result.rebased.nativeImage],['merged-identity',result.business.identitySources]] as const)writeFileSync(join(s.root,name+'.sqlite3'),bytes,{mode:0o600});
  const oracle=JSON.parse(execFileSync('python3',['-I','-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);old_path=Path(sys.argv[2]);expected=int(sys.argv[3])
with ExitStack() as stack:
 def open(path):return stack.enter_context(closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)))
 old=open(old_path);merged=open(root/'merged-identity.sqlite3');native=open(root/'native.sqlite3');final=open(root/'final.sqlite3')
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return list(db.execute('SELECT rowid,*,'+','.join('typeof("'+c+'")' for c in columns)+' FROM "'+table+'" ORDER BY rowid'))
 tables=[r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")];assert len(tables)==10
 for table in tables:
  by_id={row[0]:row for row in rows(merged,table)}
  for row in rows(old,table):assert by_id[row[0]]==row,table
 assert old.execute('SELECT count(*) FROM link_audit').fetchone()==(expected,)
 preserved=['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','music_pin_history','event_audit','finance_entries','settlement_history']
 for table in preserved:assert rows(native,table)==rows(final,table),table
 assert final.execute('PRAGMA integrity_check').fetchone()==('ok',) and not final.execute('PRAGMA foreign_key_check').fetchall()
 assert final.execute('SELECT recovery_required FROM rebuild_storage').fetchone()==(1,)
 print(json.dumps(dict(identityTables=10,originalRowsAndStorageClasses=True,actualOldAudits=expected,preservedTables=len(preserved),recoveryBlocked=True)))`,s.root,join(s.music,'identity.sqlite3'),String(kind==='linked'?1:kind==='ABA'?3:2)],{encoding:'utf8',timeout:30000}));
  expect(oracle).toEqual({identityTables:10,originalRowsAndStorageClasses:true,actualOldAudits:kind==='linked'?1:kind==='ABA'?3:2,preservedTables:9,recoveryBlocked:true});expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(original);expect(result.report.releaseEligible).toBe(false);
},30000);
