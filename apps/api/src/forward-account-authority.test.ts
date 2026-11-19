import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {forwardSourceRebaseFixture} from '../testsupport/forward-source-rebase-fixture';
import {accountRows} from '../testsupport/forward-account-fixture';
import {rebaseForwardSources} from '../../../tools/migration/forward-source-rebase';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackErasureAuthority,readRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {projectNativeForwardErasures} from '../../../tools/migration/forward-erasure-projection';
import {readSourceRebaseEvidence} from '../../../tools/migration/source-rebase-evidence';
import {projectRollbackMusic} from '../../../tools/migration/rollback-music';
import {projectRollbackIdentity} from '../../../tools/migration/rollback-identity';
import {erasureJournal,erasureJournalPath,decodeErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function open(bytes:Buffer){const db=new Database(bytes);db.pragma('foreign_keys=ON');cleanup.push(()=>db.close());return db;}
it.each(['claimant','fresh-native'])('applies actual original Python closure after full business/proof/source rebase for %s, repairs mixed private restore, and retains original source IDs, frozen audits and raw authority',async userId=>{
 const s=await forwardSourceRebaseFixture();cleanup.push(()=>s.close());
 for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at,recipient_user_id) VALUES('listen','rebase-close',?,'synthetic','{\"original\":true}',?,?,?,?,?,'original',?)").run('rebase-close-'+i,status,status==='sending'?'uncertain':'',status==='failed'?'retry':null,status==='skipped'?'simulation':null,status==='sent'?'saved-original-payload':null,userId);
 const rebased=rebaseForwardSources(s.rebaseInput()),data=join(s.fixtureRoot,'rebased-private');mkdirSync(data,{mode:0o700});mkdirSync(join(data,'paired-backups'),{mode:0o700});const database=join(data,'unified.sqlite3');writeFileSync(database,rebased.nativeImage,{mode:0o600});writeFileSync(erasureJournalPath(database),rebased.nativeJournal,{mode:0o600});const latest=new Database(database);cleanup.push(()=>latest.close());latest.pragma('foreign_keys=ON');
 const journal=erasureJournal(latest),media=captureRollbackMedia(latest,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.captureConfig,native:{root:join(data,'paired-backups'),manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.captureConfig.manifestSha256,native:[]}));
 const packageRoot=join(s.fixtureRoot,'rebased-package'),stamp=new Date('2026-11-20T05:00:00Z'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.captureRoot,data],stamp).manifestSha256,authorityRoot=join(s.fixtureRoot,'rebased-authority'),pin=writeRollbackErasureAuthority(packageRoot,packagePin,authorityRoot,stamp,undefined,{database,sha256:forwardHash(rebased.nativeJournal)}).manifestSha256;
 const oldRoot=join(s.fixtureRoot,'original-board');mkdirSync(oldRoot,{mode:0o700});const oldDatabase=join(oldRoot,'board.sqlite3');writeFileSync(oldDatabase,state.boardImage,{mode:0o600});const bindings:Record<string,string>={};for(const domain of ['board','music','unified'] as const){const path=join(oldRoot,domain+'.erasures.jsonl');writeFileSync(path,readRollbackErasureAuthority(authorityRoot,pin).ledgers[domain],{mode:0o600});bindings[domain]=path;}
 const output=execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from qgroup_core import privacy
root,pin,bindings,path,uid=sys.argv[1:];a=ErasureAuthority(root,pin,json.loads(bindings));undo=install_legacy_erasure_authority(a,board_privacy=privacy,board_database=Path(path))
try:
 with sqlite3.connect(path) as db:
  db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON');db.execute('BEGIN IMMEDIATE');user=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();result=privacy.close(db,user,{'confirm_close':True})
 assert result['ok'];print(json.dumps(result))
finally:undo();a.close()`,authorityRoot,pin,JSON.stringify(bindings),oldDatabase,userId],{encoding:'utf8',stdio:'pipe',timeout:10000});
 const oldClosure=JSON.parse(output) as {request_id:string;status:string};const authority=readRollbackErasureAuthority(authorityRoot,pin),boardJournal=Buffer.from(authority.ledgers.board),head=readFileSync(join(authorityRoot,'authority-head.json'));
 const oldCompleted=open(readFileSync(oldDatabase)),original=open(rebased.nativeImage),closureSource=open(rebased.nativeImage),oldRow=oldCompleted.prepare('SELECT rowid,* FROM privacy_requests WHERE user_id=?').safeIntegers(true).get(userId) as Record<string,unknown>,closureColumns=(oldCompleted.prepare('PRAGMA table_info(privacy_requests)').all() as {name:string}[]).map(row=>row.name);
 closureSource.prepare(`INSERT INTO privacy_requests(rowid,${closureColumns.join(',')}) VALUES(${Array(closureColumns.length+1).fill('?').join(',')})`).run(oldRow.rowid,...closureColumns.map(name=>oldRow[name]));const closureImage=closureSource.serialize();
 const input={authorityRoot,manifestSha256:pin,checkpoint:media.checkpointImage,nativeImage:closureImage,nativeImageSha256:forwardHash(closureImage),nativeJournal:rebased.nativeJournal,nativeJournalSha256:forwardHash(rebased.nativeJournal)},first=projectNativeForwardErasures(input),mixed=open(first.nativeImage),id=userId==='claimant'?s.id:s.native.id,key=state.music.keys.find(row=>row.profileId===id)!;
 expect(mixed.prepare('SELECT id,status FROM privacy_requests WHERE user_id=?').get(userId)).toEqual({id:oldClosure.request_id,status:oldClosure.status});expect(mixed.prepare('SELECT 1 FROM privacy_receipts WHERE request_id=?').get(oldClosure.request_id)).toBeUndefined();
 const originalClosure=accountRows(mixed,'privacy_requests');expect(originalClosure).toEqual(accountRows(oldCompleted,'privacy_requests'));
 for(const table of ['external_identities','browser_sessions','request_results','music_profile_receipts','music_claim_intents','music_legacy_identity','music_documents']){
  const columns=(original.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name);for(const row of forwardRows(original,table))mixed.prepare(`INSERT OR IGNORE INTO ${table}(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(row.__forward_rowid__,...columns.map(name=>row[name]));
 }
 mixed.prepare('UPDATE users SET nickname=(SELECT nickname FROM users WHERE id=?)||?,token_hash=? WHERE id=?').run(userId,'private-restore','f'.repeat(64),userId);mixed.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run(userId,id);
 const before=mixed.serialize(),second=projectNativeForwardErasures({...input,nativeImage:before,nativeImageSha256:forwardHash(before)}),db=open(second.nativeImage),nativeJournal={read:()=>decodeErasureJournal(second.nativeJournal.toString()),append(){throw Error('Read-only journal');}};
 expect(second.report).toMatchObject({accountRepair:{accountClosures:1,allRowsVerified:true},recoveryRequired:true,releaseEligible:false});expect(second.boardJournal).toEqual(boardJournal);expect(second.nativeJournal).toEqual(first.nativeJournal);expect(accountRows(db,'privacy_requests')).toEqual(originalClosure);expect(readFileSync(join(authorityRoot,'authority-head.json'))).toEqual(head);expect(readSourceRebaseEvidence(db)?.bindings).toEqual(readSourceRebaseEvidence(original)?.bindings);
 for(const table of ['music_profile_audit','music_ownership_history','music_profile_creation','bot_outbox','bot_settings','bot_settings_history','bot_runtime','events','settlement_history','finance_entries','migration_runs'])expect(accountRows(db,table),table).toEqual(accountRows(original,table));
 for(const table of ['external_identities','browser_sessions','request_results','music_profile_receipts'])expect(db.prepare('SELECT 1 FROM '+table+' WHERE user_id=?').get(userId),table).toBeUndefined();expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(id)).toEqual({user_id:null,erased_at:null});
 const music=projectRollbackMusic(db,nativeJournal),identity=projectRollbackIdentity(db,nativeJournal,music);cleanup.push(()=>identity.db.close());expect(music.keys.find(row=>row.profileId===id)).toEqual(key);expect(identity.report.auditMappings).toEqual(state.identityAuditMappings);expect(identity.db.prepare('SELECT 1 FROM links WHERE qq=?').get(key.legacyKey)).toBeUndefined();expect(identity.db.prepare('SELECT 1 FROM prelinks WHERE qq=?').get(key.legacyKey)).toBeUndefined();
 const third=projectNativeForwardErasures({...input,nativeImage:second.nativeImage,nativeImageSha256:forwardHash(second.nativeImage)}),again=open(third.nativeImage);for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])expect(accountRows(again,table.name),table.name).toEqual(accountRows(db,table.name));
 const oracle=join(s.fixtureRoot,'python-account-oracle');mkdirSync(oracle,{mode:0o700});for(const [name,bytes] of [['source.sqlite3',before],['candidate.sqlite3',second.nativeImage],['repeat.sqlite3',third.nativeImage],['baseline.sqlite3',rebased.nativeImage],['journal.jsonl',second.nativeJournal]] as const)writeFileSync(join(oracle,name),bytes,{mode:0o600});
 const verified=execFileSync('python3',['-c',`import hashlib,json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack
root=Path(sys.argv[1]);uid=sys.argv[2];profile=sys.argv[3]
with ExitStack() as stack:
 dbs=[stack.enter_context(sqlite3.connect((root/name).as_uri()+'?mode=ro',uri=True)) for name in ['source.sqlite3','candidate.sqlite3','repeat.sqlite3','baseline.sqlite3']];source,candidate,repeat,baseline=dbs
 for db in dbs:assert db.execute('PRAGMA integrity_check').fetchone()==('ok',) and not db.execute('PRAGMA foreign_key_check').fetchall()
 tables=[r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
 count=0
 for table in tables:
  q='SELECT rowid,* FROM "'+table+'" ORDER BY rowid';rows=candidate.execute(q).fetchall();assert rows==repeat.execute(q).fetchall(),table;count+=len(rows)
  types=[r[1] for r in candidate.execute('PRAGMA table_info("'+table+'")')];t='SELECT '+','.join('typeof("'+c+'")' for c in types)+' FROM "'+table+'" ORDER BY rowid';assert candidate.execute(t).fetchall()==repeat.execute(t).fetchall(),table
 for table in ['privacy_requests','privacy_receipts','erasure_applied','bot_outbox','bot_settings','bot_settings_history','bot_runtime','music_profile_audit','music_ownership_history','music_profile_creation','events','settlement_history','finance_entries','migration_runs','sqlite_sequence']:
  q='SELECT rowid,* FROM "'+table+'" ORDER BY rowid';assert candidate.execute(q).fetchall()==source.execute(q).fetchall(),table
 request=candidate.execute('SELECT id,created_at FROM privacy_requests WHERE user_id=?',(uid,)).fetchone();intents=[json.loads(line) for line in (root/'journal.jsonl').read_text().splitlines()];assert any(r.get('user_id')==uid and r.get('request_id')==request[0] and r.get('created_at')==request[1] for r in intents)
 token='erased-account-v1:'+hashlib.sha256(json.dumps([uid,request[0]],ensure_ascii=False,separators=(',',':')).encode()).hexdigest();assert candidate.execute('SELECT token_hash,nickname FROM users WHERE id=?',(uid,)).fetchone()==(token,'已注销用户')
 assert candidate.execute('SELECT user_id,erased_at FROM music_profiles WHERE id=?',(profile,)).fetchone()==(None,None)
 for table in ['browser_sessions','browser_accounts','external_identities','request_results','music_profile_receipts']:assert not candidate.execute('SELECT 1 FROM '+table+' WHERE user_id=?',(uid,)).fetchall(),table
 print(json.dumps(dict(allTablesRepeatExact=len(tables),rows=count,originalClosureMatched=True,credentialOracle=True,frozenHistoryAndBotExact=True)))`,oracle,userId,id],{encoding:'utf8',timeout:10000});expect(JSON.parse(verified)).toMatchObject({originalClosureMatched:true,credentialOracle:true,frozenHistoryAndBotExact:true});
});
