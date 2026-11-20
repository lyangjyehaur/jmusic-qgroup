import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {fixture} from '../testsupport/fixture';
import {createPrivacy} from './privacy';
import {musicErasureScope} from './admin-music-erasure';
import {hash} from './security';
import type {ErasureIntent,ErasureJournal} from './erasure-journal';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {verifyNativeResetSource,verifyNativeOrphanResetSource,repairAppliedNativeResetGlobal,reconcileAppliedNativeResetGlobal,type NativeResetSource} from '../../../tools/migration/forward-native-orphan-reset';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes,sha256:forwardHash(bytes)});
function memory(bytes:Buffer){const db=new Database(bytes);db.pragma('foreign_keys = ON');cleanup.push(()=>db.close());return db;}
function setup(orphan=false){
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());fixture(db);
  const entries:ErasureIntent[]=[],journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>entries.push(structuredClone(entry))},privacy=createPrivacy(db,journal);
  db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,created_at) VALUES('listen','forward','high-water-fixture','synthetic','{}','pending','before')").run();
  // A retained watermark may exceed live rows, including after prior deletions.
  db.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='bot_outbox'").run();
  function intent():ErasureIntent{const s=musicErasureScope(db);return {version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.profiles,entries:s.entries,requestId:randomUUID(),createdAt:'2026-11-21T06:00:00.000Z',secretHash:hash('synthetic-high-water-secret'),signature:hash(randomUUID())};}
  if(orphan){privacy.submit(intent());privacy.guard();}
  db.exec("INSERT INTO music_shouts VALUES('high-water-shout',NULL,'anonymous','匿名','原歷史',1000.25,NULL,0)");
  const before=db.serialize(),beforeJournal=Buffer.from(entries.map(e=>JSON.stringify(e)+'\n').join('')),next=intent();privacy.submit(next);privacy.guard();
  const evidence:NativeResetSource={requestId:next.requestId,before:pin(before),beforeJournal:pin(beforeJournal),completed:pin(db.serialize()),completedJournal:pin(Buffer.from(entries.map(e=>JSON.stringify(e)+'\n').join('')))};
  const candidate=memory(evidence.completed.bytes);candidate.exec("INSERT INTO music_shouts(rowid,id,profile_id,legacy_key,name,body,created_at,archived_at,ordinal) VALUES(1,'high-water-shout',NULL,'anonymous','匿名','原歷史',1000.25,NULL,0)");
  const source=memory(candidate.serialize());
  const repin=(key:'before'|'completed',change:(db:Database.Database)=>void)=>{const image=memory(evidence[key].bytes);change(image);evidence[key]=pin(image.serialize());};
  return {source,candidate,evidence,journal,repin,repair:()=>candidate.transaction(()=>repairAppliedNativeResetGlobal(candidate,journal,evidence)).immediate(),verify:()=>reconcileAppliedNativeResetGlobal(source,candidate,journal,evidence)};
}

it.each(['below live row','missing','duplicate','unknown table','text','real','negative'])('rejects mutually matching malformed reset source watermarks: %s',change=>{
  const s=setup();
  for(const key of ['before','completed'] as const)s.repin(key,db=>{
    if(change==='below live row')db.exec("UPDATE sqlite_sequence SET seq=0 WHERE name='bot_outbox'");
    if(change==='missing')db.exec("DELETE FROM sqlite_sequence WHERE name='bot_outbox'");
    if(change==='duplicate')db.exec("INSERT INTO sqlite_sequence VALUES('bot_outbox',100)");
    if(change==='unknown table')db.exec("INSERT INTO sqlite_sequence VALUES('unrecognized-counter',100)");
    if(change==='text')db.exec("UPDATE sqlite_sequence SET seq='opaque-counter' WHERE name='bot_outbox'");
    if(change==='real')db.exec("UPDATE sqlite_sequence SET seq=100.25 WHERE name='bot_outbox'");
    if(change==='negative')db.exec("UPDATE sqlite_sequence SET seq=-1 WHERE name='bot_outbox'");
  });
  const original=s.candidate.serialize();expect(()=>verifyNativeResetSource(s.evidence)).toThrow();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it('checks the same physical watermark rules for orphan-only reset evidence',()=>{
  const s=setup(true);for(const key of ['before','completed'] as const)s.repin(key,db=>db.exec("UPDATE sqlite_sequence SET seq=0 WHERE name='bot_outbox'"));
  expect(()=>verifyNativeOrphanResetSource(s.evidence)).toThrow();
});

it.each(['rewound above live row','below live row','missing'])('rejects a candidate watermark below the original completion before deleting any history: %s',change=>{
  const s=setup();
  if(change==='rewound above live row')s.candidate.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='bot_outbox'");
  if(change==='below live row')s.candidate.exec("UPDATE sqlite_sequence SET seq=0 WHERE name='bot_outbox'");
  if(change==='missing')s.candidate.exec("DELETE FROM sqlite_sequence WHERE name='bot_outbox'");
  const original=s.candidate.serialize();expect(()=>s.repair()).toThrow();expect(s.candidate.serialize()).toEqual(original);
});

it('rejects a source and repaired candidate that agree on an above-row rewind below the completion watermark',()=>{
  const s=setup();s.repair();for(const db of [s.source,s.candidate])db.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='bot_outbox'");
  expect(()=>s.verify()).toThrow();
});

it('retains a later higher watermark and every frozen bot row during reset repair',()=>{
  const s=setup();for(const db of [s.source,s.candidate])db.exec("UPDATE sqlite_sequence SET seq=101 WHERE name='bot_outbox'");
  s.repair();expect(s.verify()).toMatchObject({allRowsVerified:true,releaseEligible:false});
  expect(s.candidate.prepare("SELECT seq FROM sqlite_sequence WHERE name='bot_outbox'").safeIntegers(true).get()).toEqual({seq:101n});
  expect([...forwardRows(s.candidate,'bot_outbox')]).toEqual([...forwardRows(s.source,'bot_outbox')]);
});

it('compares retained SQLite watermarks as exact 64-bit integers',()=>{
  const s=setup(),large=9007199254740993n;
  for(const key of ['before','completed'] as const)s.repin(key,db=>db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='bot_outbox'").run(large));
  for(const db of [s.source,s.candidate])db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='bot_outbox'").run(large);
  expect(verifyNativeResetSource(s.evidence)).toMatchObject({allTransitionRowsVerified:true,releaseEligible:false});s.repair();expect(s.verify().allRowsVerified).toBe(true);
  expect(s.candidate.prepare("SELECT seq FROM sqlite_sequence WHERE name='bot_outbox'").safeIntegers(true).get()).toEqual({seq:large});
});
