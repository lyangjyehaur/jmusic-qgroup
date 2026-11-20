import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetGenerationFixture} from '../testsupport/legacy-reset-generation-fixture';
import {projectNativeForwardErasures,type ForwardErasureInput} from '../../../tools/migration/forward-erasure-projection';
import {prepareForwardLegacyResetGenerations} from '../../../tools/migration/forward-legacy-reset-generations';
import {forwardHash,forwardRows,forwardEqual} from '../../../tools/migration/forward-board-storage';
import {readRollbackErasureAuthority} from './erasure-authority-protocol';
import {readForwardLegacyResetVault} from '../../../tools/migration/forward-legacy-reset-vault';
import {repairAppliedLegacyResetEntries,reconcileAppliedLegacyResetEntries} from '../../../tools/migration/forward-legacy-reset-entries';
import {decodeErasureJournal,readVerifiedErasureJournal} from './erasure-journal';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
async function setup(completed=true,middleKey='e'){const s=await legacyResetGenerationFixture(completed,middleKey);cleanup.push(()=>s.close());return s;}
function open(bytes:Buffer){const db=new Database(bytes);db.pragma('foreign_keys = ON');cleanup.push(()=>db.close());return db;}
function input(s:Awaited<ReturnType<typeof setup>>):ForwardErasureInput{return {authorityRoot:s.authority,manifestSha256:s.pin,checkpoint:s.input.checkpoint.bytes,nativeImage:s.input.nativeImage.bytes,nativeImageSha256:s.input.nativeImage.sha256,nativeJournal:Buffer.alloc(0),nativeJournalSha256:forwardHash(Buffer.alloc(0)),resetSourceVault:{vaultRoot:s.vault,vaultManifestSha256:s.input.vault.vaultManifestSha256}};}
function rows(db:Database.Database){return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>[row.name,[...forwardRows(db,row.name)]]));}

it('projects loaded-member erasures and persisted-entry reset scopes from two actual original resets, preserving later qualified entries and all bot work',async()=>{
  const s=await setup(),i=input(s),generation=prepareForwardLegacyResetGenerations(s.input),native=open(i.nativeImage),later=generation.mapping.entries[0]!.derivedId;
  native.prepare("INSERT INTO music_entries VALUES(?,'post-reset generation','sub')").run(later);
  native.prepare("INSERT INTO music_entries VALUES('native-unrelated','unrelated native entry','sub')").run();
  i.nativeImage=native.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);
  const original=Buffer.from(i.nativeImage),head=readFileSync(join(s.authority,'authority-head.json')),result=projectNativeForwardErasures(i),db=open(result.nativeImage);
  expect(result.report.legacyResetEntryRepair).toMatchObject({originalResetRecords:2,entryScopes:1,allRowsVerified:true,globalResetGenerationsVerified:false,releaseEligible:false});
  expect(db.prepare("SELECT 1 FROM music_entries WHERE id='e'").get()).toBeUndefined();
  expect(db.prepare('SELECT name FROM music_entries WHERE id=?').get(later)).toEqual({name:'post-reset generation'});
  expect(db.prepare("SELECT name FROM music_entries WHERE id='native-unrelated'").get()).toEqual({name:'unrelated native entry'});
  for(const key of Object.keys(s.state.music.data.members as object))expect(db.prepare('SELECT 1 FROM music_legacy_profiles WHERE legacy_key=?').get(key)).toBeUndefined();
  for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','event_audit','finance_entries','settlement_history','privacy_receipts','music_catalog_actions'])expect([...forwardRows(db,table)],table).toEqual([...forwardRows(native,table)]);
  expect(result.nativeJournal.length).toBeGreaterThan(0);expect(decodeErasureJournal(result.nativeJournal.toString()).every(row=>'version' in row&&row.version===3)).toBe(true);
  readVerifiedErasureJournal(db,{read:()=>decodeErasureJournal(result.nativeJournal.toString()),append(){throw Error('read-only');}});
  expect(result.report).toMatchObject({recoveryRequired:true,releaseEligible:false,erasureOnly:true});expect(db.prepare('SELECT recovery_required FROM rebuild_storage').get()).toEqual({recovery_required:1});
  const again=projectNativeForwardErasures({...i,nativeImage:result.nativeImage,nativeImageSha256:forwardHash(result.nativeImage)});
  expect(forwardEqual(rows(open(again.nativeImage)),rows(db))).toBe(true);expect(again.nativeJournal).toEqual(result.nativeJournal);
  expect(i.nativeImage).toEqual(original);expect(s.db.serialize()).toEqual(s.before);expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);
});
it.each(['absent vault','incomplete completion'])('refuses destructive projection without %s',async kind=>{
  const s=await setup(kind!=='incomplete completion'),i=input(s);if(kind==='absent vault')delete i.resetSourceVault;
  expect(()=>projectNativeForwardErasures(i)).toThrow();expect(s.db.serialize()).toEqual(s.before);
});
it('uses persisted entry containers while keeping loaded-only entries outside the original clear scope',async()=>{
  const s=await legacyResetGenerationFixture(true,'e','loaded-only');cleanup.push(()=>s.close());const i=input(s),native=open(i.nativeImage);
  native.prepare("INSERT INTO music_entries VALUES('loaded-only','unrelated native content','sub')").run();i.nativeImage=native.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);
  const result=projectNativeForwardErasures(i),db=open(result.nativeImage);
  expect(result.report.legacyResetEntryRepair).toMatchObject({entryScopes:1,allRowsVerified:true});expect(db.prepare("SELECT 1 FROM music_entries WHERE id='e'").get()).toBeUndefined();
  expect(db.prepare("SELECT name FROM music_entries WHERE id='loaded-only'").get()).toEqual({name:'unrelated native content'});expect(s.db.serialize()).toEqual(s.before);
});
it('binds vault evidence to the requested authority even when an untyped caller supplies extra fields',async()=>{
  const s=await setup(),i=input(s);
  Object.assign(i.resetSourceVault!,{authorityRoot:join(s.root,'unrelated-authority'),manifestSha256:'f'.repeat(64)});
  const result=projectNativeForwardErasures(i);expect(result.report.authoritySha256).toBe(s.pin);expect(result.report.legacyResetEntryRepair?.allRowsVerified).toBe(true);expect(s.db.serialize()).toEqual(s.before);
});
it('rejects an old-created key colliding with an unrelated native-only entry',async()=>{
  const s=await setup(true,'unrelated-key'),i=input(s),db=open(i.nativeImage);
  db.prepare("INSERT INTO music_entries VALUES('unrelated-key','native only','sub')").run();i.nativeImage=db.serialize();i.nativeImageSha256=forwardHash(i.nativeImage);
  expect(()=>projectNativeForwardErasures(i)).toThrow('unrelated native entry');expect(s.db.serialize()).toEqual(s.before);
});
it.each(['source bytes','vault metadata','vault binding','native pin','authority identity'])('rejects changed projection boundary: %s',async kind=>{
  const s=await setup(),i=input(s);let count=0;
  expect(()=>projectNativeForwardErasures(i,()=>{if(++count!==2)return;if(kind==='source bytes')i.nativeImage.fill(32);else if(kind==='vault binding')i.resetSourceVault!.vaultManifestSha256='f'.repeat(64);else if(kind==='native pin')i.nativeImageSha256='f'.repeat(64);else if(kind==='authority identity')i.manifestSha256='f'.repeat(64);else writeFileSync(join(s.vault,'unexpected'),'fixture');})).toThrow();
  expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['entry revival','document revival','map status','bot state','schema','sequence'])('independently rejects changed complete-row candidate: %s',async kind=>{
  const s=await setup(),checkpoint=open(s.input.checkpoint.bytes),source=open(s.input.nativeImage.bytes),candidate=open(s.input.nativeImage.bytes),authority=readRollbackErasureAuthority(s.authority,s.pin),vault=readForwardLegacyResetVault(s.input.vault);
  candidate.transaction(()=>repairAppliedLegacyResetEntries(checkpoint,candidate,authority.records,vault)).immediate();
  if(kind==='entry revival')candidate.prepare("INSERT INTO music_entries VALUES('e','revived','sub')").run();
  if(kind==='document revival')candidate.prepare("INSERT INTO music_documents VALUES('entry_source',999,'{\"entryId\":\"e\",\"entry\":{\"id\":\"e\"}}')").run();
  if(kind==='map status')candidate.prepare("UPDATE migration_map SET status='preserved' WHERE source='music' AND entity_type='entry' AND target_id='e'").run();
  if(kind==='bot state')candidate.prepare("UPDATE bot_outbox SET status='pending',claim_token='' WHERE status='sending'").run();
  if(kind==='schema')candidate.exec('CREATE TABLE unexpected(value TEXT)');
  if(kind==='sequence')candidate.prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name='bot_outbox'").run();
  expect(()=>reconcileAppliedLegacyResetEntries(checkpoint,source,candidate,authority.records,vault)).toThrow();expect(s.db.serialize()).toEqual(s.before);
});
