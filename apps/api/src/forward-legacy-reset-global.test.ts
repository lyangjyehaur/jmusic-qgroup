import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {legacyResetGenerationFixture} from '../testsupport/legacy-reset-generation-fixture';
import {projectNativeForwardErasures,type ForwardErasureInput} from '../../../tools/migration/forward-erasure-projection';
import {repairAppliedLegacyGlobalReset,reconcileAppliedLegacyGlobalReset} from '../../../tools/migration/forward-legacy-reset-global';
import {forwardHash,forwardRows,forwardEqual} from '../../../tools/migration/forward-board-storage';
import {readRollbackErasureAuthority} from './erasure-authority-protocol';
import {readForwardLegacyResetVault} from '../../../tools/migration/forward-legacy-reset-vault';
import {projectRollbackMusic} from '../../../tools/migration/rollback-music';
import {decodeErasureJournal,type ErasureIntent} from './erasure-journal';
import {createPrivacy} from './privacy';
import {hash} from './security';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
async function setup(pruned=false){const s=await legacyResetGenerationFixture(true,pruned?'old-later-key':'e','',pruned);cleanup.push(()=>s.close());return s;}
function open(bytes:Buffer){const db=new Database(bytes);db.pragma('foreign_keys = ON');cleanup.push(()=>db.close());return db;}
function input(s:Awaited<ReturnType<typeof setup>>):ForwardErasureInput{return {authorityRoot:s.authority,manifestSha256:s.pin,checkpoint:s.input.checkpoint.bytes,nativeImage:s.input.nativeImage.bytes,nativeImageSha256:s.input.nativeImage.sha256,nativeJournal:Buffer.alloc(0),nativeJournalSha256:forwardHash(Buffer.alloc(0)),resetSourceVault:{vaultRoot:s.vault,vaultManifestSha256:s.input.vault.vaultManifestSha256}};}
function rows(db:Database.Database){return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>[row.name,[...forwardRows(db,row.name)]]));}
function later(db:Database.Database){
  db.prepare("INSERT INTO music_entries VALUES('new-native-entry','later native','sub')").run();
  db.prepare("INSERT INTO music_shouts VALUES('new-native-shout',NULL,'','later author','later body',999,NULL,999)").run();
  db.prepare("INSERT INTO music_shouts VALUES('new-native-archive',NULL,'','later archive','archive body',999,1000,1000)").run();
  db.prepare("INSERT INTO music_documents VALUES('shouts',99,'{\"id\":\"new-native-shout\",\"qq\":\"\",\"text\":\"later body\",\"createdAt\":999}')").run();
  db.prepare("INSERT INTO music_documents VALUES('trend_sample',0,'{\"t\":999,\"counts\":{\"new-native-entry\":1}}')").run();
}
it('clears all five original reset containers in the actual native projection while preserving original sources and all bot states',async()=>{
  const s=await setup(),i=input(s),head=readFileSync(join(s.authority,'authority-head.json')),result=projectNativeForwardErasures(i),db=open(result.nativeImage);
  expect(result.report.legacyGlobalResetRepair).toMatchObject({originalResetRecords:2,checkpointShoutScopes:2,checkpointDocumentScopes:3,allRowsVerified:true,checkpointGenerationCleared:true,allResetGenerationsReconciled:false,releaseEligible:false});
  const projected=projectRollbackMusic(db,{read:()=>decodeErasureJournal(result.nativeJournal.toString()),append(){throw Error('read-only');}});
  expect(projected.data).toMatchObject({entries:{},members:{},shouts:[],shoutHistory:[],trend:[]});expect(Object.keys(projected.data.entries as object)).toHaveLength(0);expect(Object.keys(projected.data.members as object)).toHaveLength(0);
  for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','music_catalog_actions','music_shout_deletions','event_audit','finance_entries','settlement_history'])expect([...forwardRows(db,table)],table).toEqual([...forwardRows(open(i.nativeImage),table)]);
  const again=projectNativeForwardErasures({...i,nativeImage:result.nativeImage,nativeImageSha256:forwardHash(result.nativeImage)});expect(forwardEqual(rows(open(again.nativeImage)),rows(db))).toBe(true);expect(again.nativeJournal).toEqual(result.nativeJournal);
  expect(s.db.serialize()).toEqual(s.before);expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);
});
it('does not revive checkpoint entries, anonymous shouts or trends pruned from the actual persisted source before the first global reset',async()=>{
  const s=await setup(true),vault=readForwardLegacyResetVault(s.input.vault),original=JSON.parse(vault.sources.resets[0]!.persisted.bytes.toString());
  expect(original).toMatchObject({entries:{},shouts:[],shoutHistory:[],trend:[]});expect(Object.keys(original.entries)).toHaveLength(0);
  expect(vault.sources.resets[1]!.persisted.bytes.toString()).not.toContain('"id":"e"');
  const result=projectNativeForwardErasures(input(s)),db=open(result.nativeImage);expect(db.prepare("SELECT 1 FROM music_entries WHERE id='e'").get()).toBeUndefined();expect(db.prepare('SELECT 1 FROM music_shouts').get()).toBeUndefined();expect(db.prepare("SELECT 1 FROM music_documents WHERE kind IN ('trend','trend_sample')").get()).toBeUndefined();
  expect(result.report.legacyGlobalResetRepair?.allRowsVerified).toBe(true);expect(s.db.serialize()).toEqual(s.before);
});
it('retains later native active/archive shouts, source shadows and trend samples through projection and original rollback readers',async()=>{
  const s=await setup(),i=input(s),native=open(i.nativeImage);later(native);i.nativeImage=native.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);
  const result=projectNativeForwardErasures(i),db=open(result.nativeImage),projected=projectRollbackMusic(db,{read:()=>decodeErasureJournal(result.nativeJournal.toString()),append(){throw Error('read-only');}});
  expect(projected.data.shouts).toEqual([{id:'new-native-shout',qq:'',text:'later body',createdAt:999,name:'later author'}]);
  expect(projected.data.shoutHistory).toEqual([{id:'new-native-archive',qq:'',name:'later archive',text:'archive body',createdAt:999,archivedAt:1000}]);
  expect(projected.data.trend).toEqual([{t:999,counts:{'new-native-entry':1}}]);expect(db.prepare("SELECT payload_json FROM music_documents WHERE kind='shouts' AND position=99").get()).toEqual(native.prepare("SELECT payload_json FROM music_documents WHERE kind='shouts' AND position=99").get());
  expect(s.db.serialize()).toEqual(s.before);expect(db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('rejects a genuinely old-created shout ID colliding with an unrelated native shout',async()=>{
  const s=await setup(),i=input(s),db=open(i.nativeImage);db.prepare("INSERT INTO music_shouts VALUES('reused-shout',NULL,'','native author','native only',999,NULL,999)").run();i.nativeImage=db.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);
  expect(()=>projectNativeForwardErasures(i)).toThrow('unrelated native generation');expect(s.db.serialize()).toEqual(s.before);
});
it.each(['shadow','digest','revision','target'])('rejects changed original document/mapping generations: %s',async kind=>{
  const s=await setup(),i=input(s),db=open(i.nativeImage);
  if(kind==='shadow')db.prepare("UPDATE music_documents SET payload_json='{\"t\":999,\"counts\":{}}' WHERE kind='trend'").run();
  else db.prepare(`UPDATE migration_map SET ${kind==='digest'?'payload_digest':kind==='revision'?'source_revision':'target_id'}='changed-generation' WHERE source='music' AND entity_type='trend'`).run();
  i.nativeImage=db.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);expect(()=>projectNativeForwardErasures(i)).toThrow('generation changed');expect(s.db.serialize()).toEqual(s.before);
});
it('requires explicit reconciliation when a genuine native reset after the checkpoint introduces a later generation',async()=>{
  const s=await setup(),checkpoint=open(s.input.checkpoint.bytes),db=open(s.input.nativeImage.bytes),intents:ErasureIntent[]=[],journal={read:()=>intents,append:(entry:ErasureIntent)=>{intents.push(entry);}},privacy=createPrivacy(db,journal);
  const intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:(db.prepare('SELECT id,user_id FROM music_profiles WHERE erased_at IS NULL').all() as {id:string;user_id:string|null}[]).map(row=>({id:row.id,userId:row.user_id})),entries:['e'],requestId:randomUUID(),createdAt:'2026-11-20T12:00:00.000Z',secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')};
  db.transaction(()=>privacy.submit(intent)).immediate();db.prepare("INSERT INTO music_shouts VALUES('orphan',NULL,'','new generation','body',999,NULL,999)").run();
  const authority=readRollbackErasureAuthority(s.authority,s.pin),vault=readForwardLegacyResetVault(s.input.vault);
  expect(()=>db.transaction(()=>repairAppliedLegacyGlobalReset(checkpoint,db,authority.records,vault,intents)).immediate()).toThrow('Native reset after checkpoint');
  expect(db.prepare("SELECT body FROM music_shouts WHERE id='orphan'").get()).toEqual({body:'body'});expect(s.db.serialize()).toEqual(s.before);
});
it.each(['shout revival','trend revival','shadow revival','mapping status','bot sending','sequence','schema','later removed'])('rejects complete-row candidate corruption independently: %s',async kind=>{
  const s=await setup(),checkpoint=open(s.input.checkpoint.bytes),source=open(s.input.nativeImage.bytes);later(source);const candidate=open(source.serialize()),authority=readRollbackErasureAuthority(s.authority,s.pin),vault=readForwardLegacyResetVault(s.input.vault);
  candidate.transaction(()=>repairAppliedLegacyGlobalReset(checkpoint,candidate,authority.records,vault,[])).immediate();
  if(kind==='shout revival')candidate.prepare("INSERT INTO music_shouts VALUES('orphan',NULL,'','revived','private',999,NULL,998)").run();
  if(kind==='trend revival')candidate.prepare("INSERT INTO music_documents VALUES('trend',0,'{\"t\":123,\"counts\":{\"e\":2}}')").run();
  if(kind==='shadow revival')candidate.prepare("INSERT INTO music_documents VALUES('shouts',98,'{\"id\":\"orphan\",\"qq\":\"\",\"text\":\"revived\"}')").run();
  if(kind==='mapping status')candidate.prepare("UPDATE migration_map SET status='preserved' WHERE source='music' AND entity_type='trend'").run();
  if(kind==='bot sending')candidate.prepare("UPDATE bot_outbox SET status='pending',claim_token='' WHERE status='sending'").run();
  if(kind==='sequence')candidate.prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name='bot_outbox'").run();
  if(kind==='schema')candidate.exec('CREATE TABLE unexpected(value TEXT)');
  if(kind==='later removed')candidate.prepare("DELETE FROM music_shouts WHERE id='new-native-shout'").run();
  expect(()=>reconcileAppliedLegacyGlobalReset(checkpoint,source,candidate,authority.records,vault,[])).toThrow();expect(s.db.serialize()).toEqual(s.before);
});
it('independently reads the projected standalone SQLite and exact retained bot/history rows with original Python',async()=>{
  const s=await setup(true),i=input(s),result=projectNativeForwardErasures(i),folder=join(s.root,'global-oracle');mkdirSync(folder,{mode:0o700});writeFileSync(join(folder,'source.sqlite3'),i.nativeImage,{mode:0o600});writeFileSync(join(folder,'candidate.sqlite3'),result.nativeImage,{mode:0o600});
  const output=execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import closing
folder=Path(sys.argv[1])
with closing(sqlite3.connect((folder/'source.sqlite3').as_uri()+'?mode=ro',uri=True)) as source,closing(sqlite3.connect((folder/'candidate.sqlite3').as_uri()+'?mode=ro',uri=True)) as candidate:
 assert candidate.execute('PRAGMA integrity_check').fetchone()==('ok',) and not candidate.execute('PRAGMA foreign_key_check').fetchall()
 for table in ['music_entries','music_shouts']:assert not candidate.execute('SELECT 1 FROM '+table).fetchall()
 assert not candidate.execute("SELECT 1 FROM music_documents WHERE kind IN ('entry_source','shouts','shoutHistory','trend','trend_sample')").fetchall()
 for table in ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','music_catalog_actions','music_shout_deletions','event_audit','finance_entries','settlement_history']:
  assert candidate.execute('SELECT rowid,* FROM '+table+' ORDER BY rowid').fetchall()==source.execute('SELECT rowid,* FROM '+table+' ORDER BY rowid').fetchall(),table
 assert candidate.execute('SELECT recovery_required FROM rebuild_storage').fetchone()==(1,)
print(json.dumps(dict(originalGenerationCleared=True,botAndHistoryRetained=True,recoveryBlocked=True)))`,folder],{encoding:'utf8',timeout:30000});
  expect(JSON.parse(output)).toEqual({originalGenerationCleared:true,botAndHistoryRetained:true,recoveryBlocked:true});expect(s.db.serialize()).toEqual(s.before);
});
