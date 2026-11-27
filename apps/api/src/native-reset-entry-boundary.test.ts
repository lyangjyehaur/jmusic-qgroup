import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {adminCatalogFixture,catalogProfiles} from '../testsupport/admin-catalog-fixture';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {assertAppliedNativeResetCandidateBoundary,repairAppliedNativeResetGlobal,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  db.prepare('INSERT INTO music_entry_creations VALUES(?,?,0)').run(catalogProfiles.bob,'sub-0');
  for(const [position,creator] of [catalogProfiles.alice,'10002'].entries())db.prepare("INSERT INTO music_documents VALUES('entry_source',?,?)").run(position,'{"entryId":"sub-0","entry":{"createdBy":'+JSON.stringify(creator)+'},"large":9007199254740993,"exponent":1e+05}');
  db.prepare("INSERT INTO music_documents VALUES('entry_lock',0,?)").run(JSON.stringify({entryId:'sub-0'}));
  db.exec("INSERT INTO migration_map VALUES('music','entry','old-entry-key','sub-0','original-revision','original-digest','imported'); INSERT INTO music_shouts VALUES('entry-boundary-history',NULL,'anonymous','匿名','原歷史',1000.25,NULL,0)");
  const rows:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(rows),append:entry=>rows.push(structuredClone(entry))},scope=musicErasureScope(db),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:scope.profiles,entries:scope.entries,requestId:randomUUID(),createdAt:'2026-11-21T12:00:00.000Z',secretHash:hash('synthetic-entry-boundary'),signature:hash(randomUUID())},before=db.serialize(),privacy=createPrivacy(db,journal);
  privacy.submit(intent);privacy.guard();
  const evidence:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  const candidate=new Database(evidence.completed.bytes),original=new Database(before);candidate.pragma('foreign_keys = ON');cleanup.push(()=>candidate.close(),()=>original.close());
  const restore=(table:string,where:string)=>{
    const columns=(original.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(r=>r.name),insert=candidate.prepare(`INSERT INTO "${table}"(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
    for(const row of original.prepare(`SELECT rowid AS original_rowid,* FROM "${table}" WHERE ${where}`).safeIntegers(true).all() as Record<string,unknown>[])insert.run(row.original_rowid,...columns.map(c=>row[c]));
  };
  restore('music_entries',"id='sub-0'");restore('music_entry_details',"entry_id='sub-0'");restore('music_selections',"entry_id='sub-0'");restore('music_entry_creations',"entry_id='sub-0'");restore('music_documents',"kind IN ('entry_source','entry_lock')");restore('music_shouts',"id='entry-boundary-history'");
  candidate.exec("INSERT INTO music_profiles VALUES('later-profile','alice',0,'later',NULL); INSERT INTO music_entries VALUES('later-entry','後來詞條','sub'); INSERT INTO music_selections VALUES('later-profile','later-entry',4,0); INSERT INTO music_entry_creations VALUES('later-profile','later-entry',0)");
  const check=()=>assertAppliedNativeResetCandidateBoundary(candidate,journal,evidence),repair=()=>candidate.transaction(()=>repairAppliedNativeResetGlobal(candidate,journal,evidence)).immediate();
  return {candidate,original,evidence,journal,check,repair};
}
it('accepts exact original entry children, source documents and mappings while retaining later different IDs',()=>{
  const s=setup(),before=s.candidate.serialize();s.check();expect(s.candidate.serialize()).toEqual(before);s.repair();
  for(const table of ['music_entries','music_entry_details','music_selections','music_entry_creations'])expect([...forwardRows(s.candidate,table)].filter(r=>r.entry_id==='sub-0'||r.id==='sub-0').length).toBe(table==='music_entries'||table==='music_entry_details'?1:table==='music_selections'?3:1);
  expect(s.candidate.prepare("SELECT 1 FROM music_entries WHERE id='later-entry'").get()).toBeDefined();
});
it.each(['category','aliases','creator','created time','updated time','detail rowid','selection level','selection position','selection rowid','new selection','creation position','creation rowid','new creator','source payload','source rowid','new source slot','lock payload','new lock slot','mapping revision','mapping digest','mapping rowid','new mapping slot','mapping status'])('rejects changed entry generation data while its parent is byte-identical: %s',change=>{
  const s=setup(),sql:Record<string,string>={
    category:"UPDATE music_entry_details SET category='later' WHERE entry_id='sub-0'",
    aliases:"UPDATE music_entry_details SET aliases_json='[\"later\"]' WHERE entry_id='sub-0'",
    creator:"UPDATE music_entry_details SET created_by='later-profile' WHERE entry_id='sub-0'",
    'created time':"UPDATE music_entry_details SET created_at_json='999' WHERE entry_id='sub-0'",
    'updated time':"UPDATE music_entry_details SET updated_at_json='999' WHERE entry_id='sub-0'",
    'detail rowid':"UPDATE music_entry_details SET rowid=rowid+100 WHERE entry_id='sub-0'",
    'selection level':"UPDATE music_selections SET level=2 WHERE profile_id='"+catalogProfiles.alice+"' AND entry_id='sub-0'",
    'selection position':"UPDATE music_selections SET position=99 WHERE profile_id='"+catalogProfiles.alice+"' AND entry_id='sub-0'",
    'selection rowid':"UPDATE music_selections SET rowid=rowid+100 WHERE profile_id='"+catalogProfiles.alice+"' AND entry_id='sub-0'",
    'new selection':"INSERT INTO music_selections VALUES('later-profile','sub-0',3,1)",
    'creation position':"UPDATE music_entry_creations SET position=99 WHERE entry_id='sub-0'",
    'creation rowid':"UPDATE music_entry_creations SET rowid=rowid+100 WHERE entry_id='sub-0'",
    'new creator':"INSERT INTO music_entry_creations VALUES('later-profile','sub-0',1)",
    'source payload':"UPDATE music_documents SET payload_json=replace(payload_json,'9007199254740993','9007199254740992') WHERE kind='entry_source' AND position=0",
    'source rowid':"UPDATE music_documents SET rowid=rowid+100 WHERE kind='entry_source' AND position=0",
    'new source slot':"INSERT INTO music_documents VALUES('entry_source',9,'{\"entryId\":\"sub-0\",\"entry\":{\"createdBy\":\"later-profile\"}}')",
    'lock payload':"UPDATE music_documents SET payload_json='{\"entryId\":\"sub-0\",\"later\":true}' WHERE kind='entry_lock'",
    'new lock slot':"INSERT INTO music_documents VALUES('entry_lock',9,'{\"entryId\":\"sub-0\"}')",
    'mapping revision':"UPDATE migration_map SET source_revision='later' WHERE source='music' AND entity_type='entry'",
    'mapping digest':"UPDATE migration_map SET payload_digest='later' WHERE source='music' AND entity_type='entry'",
    'mapping rowid':"UPDATE migration_map SET rowid=rowid+100 WHERE source='music' AND entity_type='entry'",
    'new mapping slot':"INSERT INTO migration_map VALUES('music','entry','later-slot','sub-0','later','later','imported')",
    'mapping status':"UPDATE migration_map SET status='later-generation' WHERE source='music' AND entity_type='entry'",
  };
  s.candidate.exec(sql[change]!);const original=s.candidate.serialize();expect(()=>s.check()).toThrow();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});
it('accepts only exact original creator redaction without rounding opaque source JSON numbers',()=>{
  const s=setup();s.candidate.exec("UPDATE music_entry_details SET created_by='' WHERE entry_id='sub-0'; UPDATE music_documents SET payload_json=json_set(payload_json,'$.entry.createdBy','') WHERE kind='entry_source'; UPDATE migration_map SET status='erasure_redacted' WHERE source='music' AND entity_type='entry'");
  s.check();expect(s.candidate.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source' AND position=0").get()).toEqual({payload_json:'{"entryId":"sub-0","entry":{"createdBy":""},"large":9007199254740993,"exponent":1e+05}'});
});
