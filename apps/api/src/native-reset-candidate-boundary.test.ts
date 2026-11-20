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
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import {verifyNativeResetSource,repairAppliedNativeResetGlobal,reconcileAppliedNativeResetGlobal,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
function setup(){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  db.exec("INSERT INTO music_account_epochs VALUES('alice',2); INSERT INTO music_shouts VALUES('original-anonymous',NULL,'anonymous','匿名','原歷史',1000.25,NULL,0)");
  const rows:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(rows),append:entry=>rows.push(structuredClone(entry))},scope=musicErasureScope(db),intent:ErasureIntent={version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:scope.profiles,entries:scope.entries,requestId:randomUUID(),createdAt:'2026-11-21T09:00:00.000Z',secretHash:hash('synthetic-epoch-boundary'),signature:hash(randomUUID())},before=db.serialize(),privacy=createPrivacy(db,journal);
  privacy.submit(intent);privacy.guard();
  const evidence:NativeResetSource={requestId:intent.requestId,before:pin(before),beforeJournal:pin(Buffer.alloc(0)),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(JSON.stringify(intent)+'\n'))};
  const candidate=new Database(evidence.completed.bytes);candidate.pragma('foreign_keys = ON');cleanup.push(()=>candidate.close());
  candidate.exec("INSERT INTO music_shouts VALUES('original-anonymous',NULL,'anonymous','匿名','原歷史',1000.25,NULL,0)");
  const repair=()=>candidate.transaction(()=>repairAppliedNativeResetGlobal(candidate,journal,evidence)).immediate();
  const source=()=>{const image=new Database(candidate.serialize());image.pragma('foreign_keys = ON');cleanup.push(()=>image.close());return image;};
  const repin=(key:'before'|'completed',sql:string)=>{const copy=new Database(evidence[key].bytes);cleanup.push(()=>copy.close());copy.exec(sql);evidence[key]=pin(copy.serialize());};
  return {candidate,evidence,journal,privacy,rows,repair,source,repin};
}
it.each(['rewound','missing','text','real','negative'])('rejects a candidate with an invalid or rewound completed owner epoch before deleting any history: %s',change=>{
  const s=setup();
  if(change==='missing')s.candidate.exec("DELETE FROM music_account_epochs WHERE user_id='alice'");
  else s.candidate.exec("UPDATE music_account_epochs SET epoch="+({rewound:'2',text:"'opaque'",real:'3.25',negative:'-1'} as Record<string,string>)[change]+" WHERE user_id='alice'");
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});
it.each(['missing','owner','active','revision','updated time','erasure time'])('rejects a changed original reset profile tombstone before modifying any row: %s',change=>{
  const s=setup(),id=catalogProfiles.bob;
  if(change==='missing')s.candidate.prepare('DELETE FROM music_profiles WHERE id=?').run(id);
  else if(change==='owner')s.candidate.prepare("UPDATE music_profiles SET user_id='bob',erased_at=NULL WHERE id=?").run(id);
  else if(change==='active')s.candidate.prepare('UPDATE music_profiles SET erased_at=NULL WHERE id=?').run(id);
  else if(change==='revision')s.candidate.prepare('UPDATE music_profiles SET revision=revision+1 WHERE id=?').run(id);
  else if(change==='updated time')s.candidate.prepare("UPDATE music_profiles SET updated_at='later' WHERE id=?").run(id);
  else s.candidate.prepare("UPDATE music_profiles SET erased_at='2026-11-21T10:00:00.000Z' WHERE id=?").run(id);
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});
it.each(['negative','real','text'])('rejects malformed before/completion owner epochs even when the exact reset transition agrees: %s',change=>{
  const s=setup(),values=change==='negative'?['-1','0']:change==='real'?['0.25','1.25']:["'opaque'",'1'];
  s.repin('before',"UPDATE music_account_epochs SET epoch="+values[0]+" WHERE user_id='alice'");s.repin('completed',"UPDATE music_account_epochs SET epoch="+values[1]+" WHERE user_id='alice'");
  expect(()=>verifyNativeResetSource(s.evidence)).toThrow();
});
it('rejects a source and repaired candidate which agree on an owner epoch below the original completion',()=>{
  const s=setup(),original=s.source();s.repair();for(const db of [original,s.candidate])db.exec("UPDATE music_account_epochs SET epoch=2 WHERE user_id='alice'");
  expect(()=>reconcileAppliedNativeResetGlobal(original,s.candidate,s.journal,s.evidence)).toThrow();
});
it('preserves a higher exact 64-bit owner epoch and every later unrelated profile and entry',()=>{
  const s=setup();s.candidate.prepare("UPDATE music_account_epochs SET epoch=? WHERE user_id='alice'").run(9007199254740993n);
  s.candidate.exec("INSERT INTO music_profiles VALUES('later-profile','alice',0,'later',NULL); INSERT INTO music_entries VALUES('later-entry','後來詞條','sub')");
  const original=s.source();s.repair();expect(reconcileAppliedNativeResetGlobal(original,s.candidate,s.journal,s.evidence).allRowsVerified).toBe(true);
  expect(s.candidate.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='alice'").safeIntegers(true).get()).toEqual({epoch:9007199254740993n});
  expect(s.candidate.prepare("SELECT id FROM music_profiles WHERE erased_at IS NULL").get()).toEqual({id:'later-profile'});expect(s.candidate.prepare('SELECT id FROM music_entries').get()).toEqual({id:'later-entry'});
});
it.each(['music','admin','both'])('permits only the exact latest applied %s erasure timestamp on an original tombstone',kind=>{
  const s=setup(),intent:ErasureIntent=kind==='admin'?{version:2,kind:'admin_music',command:'delete_profile',actorRef:'account:bob',profiles:[{id:catalogProfiles.bob,userId:'bob'}],entries:[],requestId:randomUUID(),createdAt:'2026-11-21T08:00:00.000Z',secretHash:hash('later-secret'),signature:hash(randomUUID())}:{version:1,kind:kind==='both'?'both':'music',userId:'bob',profileId:catalogProfiles.bob,requestId:randomUUID(),createdAt:'2026-11-21T08:00:00.000Z',secretHash:hash('later-secret'),signature:hash(randomUUID())};
  const privacy=createPrivacy(s.candidate,s.journal);privacy.submit(intent);privacy.guard();const original=s.source();s.repair();expect(reconcileAppliedNativeResetGlobal(original,s.candidate,s.journal,s.evidence).allRowsVerified).toBe(true);
  s.candidate.prepare("UPDATE music_profiles SET erased_at='2026-11-21T11:00:00.000Z' WHERE id=?").run(catalogProfiles.bob);expect(()=>s.repair()).toThrow();
});
it.each(['different name','different rowid'])('rejects a reused original entry identity with %s before global repair',change=>{
  const s=setup(),original=new Database(s.evidence.before.bytes);cleanup.push(()=>original.close());
  const row=original.prepare("SELECT rowid AS rid,* FROM music_entries WHERE id='sub-0'").get() as {rid:number;id:string;name:string;kind:string};
  s.candidate.prepare('INSERT INTO music_entries(rowid,id,name,kind) VALUES(?,?,?,?)').run(change==='different rowid'?row.rid+100:row.rid,row.id,change==='different name'?'後來同 ID 詞條':row.name,row.kind);
  const before=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(before);
});
