import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetGenerationFixture} from '../testsupport/legacy-reset-generation-fixture';
import {prepareForwardLegacyResetGenerations,verifyForwardLegacyResetGenerations} from '../../../tools/migration/forward-legacy-reset-generations';
import {forwardHash} from '../../../tools/migration/forward-board-storage';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
async function setup(completed=true){const s=await legacyResetGenerationFixture(completed);cleanup.push(()=>s.close());return s;}
function changed(bytes:Buffer,caseName:string){return execFileSync('python3',['-c',`import sys
from tools.migration.rollback_music_reset import _json,_encode
data=_json(sys.stdin.buffer.read());case=sys.argv[1];entries=data['entries'];first=next(iter(entries));member=data['members']['38888']
if case=='name':entries[first]['text']='changed'
elif case=='entry id':entries[first]['id']='e'
elif case=='old selection':member['selection'][0]='e'
elif case=='level type':member['selection'][1]['level']=1
elif case=='unused reference':member['selection'][1]['entryId']='changed'
elif case=='created order':member['created'].reverse()
elif case=='historic trend':data['trend'][0]['counts'].pop(next(key for key in data['trend'][0]['counts'] if key not in entries))
elif case=='trend value':data['trend'][0]['counts'][next(iter(data['trend'][0]['counts']))]=1
elif case=='shout id':data['shouts'][0]['id']='reused-shout'
elif case=='archive placement':data['shouts']+=data['shoutHistory'];data['shoutHistory']=[]
elif case=='unknown literal':data['unclassified']['literal']=first
elif case=='empty list reference':member['selection'][7]['id']=None
elif case=='unresolved selection':member['selection'].append('missing-entry')
elif case=='erased member':data['members'][sys.argv[2]]=dict(qq=sys.argv[2],selection=[],created=[],boardUserId='')
elif case=='erased creator':entries[first]['createdBy']=sys.argv[2]
elif case=='erased shout':data['shouts'][0]['qq']=sys.argv[2]
elif case=='duplicate shout':data['shoutHistory'][0]['id']=data['shouts'][0]['id']
elif case=='unmatched entry':entries[first]['id']='wrong'
elif case=='unresolved created':member['created'].append('gone')
sys.stdout.buffer.write(_encode(data))
`,caseName,'10001'],{input:bytes,timeout:10000,stdio:['pipe','pipe','pipe']});}
it('separates genuinely reused IDs after two real resets and round-trips Python data, historical references and original selection coercions',async()=>{
  const s=await setup(),head=readFileSync(join(s.authority,'authority-head.json')),result=prepareForwardLegacyResetGenerations(s.input),data=JSON.parse(result.derivedMusic.bytes.toString()) as {entries:Record<string,{id:string;text:string;opaque?:unknown}>;members:Record<string,{created:string[];selection:unknown[]}>;trend:{counts:Record<string,number>}[];shouts:{id:string}[];shoutHistory:{id:string}[];unclassified:{literal:string}};
  expect(result.report).toMatchObject({resetSequence:2,catalogEntries:5,historicalEntryReferences:1,shouts:2,allKnownReferencesVerified:true,originalContentAndOrderRoundTripVerified:true,latestSourceAncestryVerified:false,resetGenerationsReconciled:false,releaseEligible:false});
  const ids=new Map(result.mapping.entries.map(row=>[row.originalKey,row.derivedId]));expect(data.entries[ids.get('e')!]?.id).toBe(ids.get('e'));expect(data.entries.e).toBeUndefined();expect(data.unclassified.literal).toBe('e');
  expect(data.members['38888']!.created).toEqual(['e','聲:[]/詞','1','e'].map(key=>ids.get(key)));expect(data.members['38888']!.selection).toEqual([ids.get('e'),{id:ids.get('e'),entryId:'ignored',level:1},{id:'',entryId:ids.get('e'),level:-0},{id:ids.get('1'),level:'2'},{id:ids.get('true'),level:true},{id:ids.get('e'),level:2.9},{id:ids.get('[object Object]'),level:false},{id:[],entryId:'ignored',level:1},'']);
  expect(Object.keys(data.trend[0]!.counts)).toEqual(['e','historic-gone','1'].map(key=>ids.get(key)));expect(data.entries[ids.get('historic-gone')!]).toBeUndefined();expect(data.shouts[0]!.id).toBe(result.mapping.shouts[0]!.derivedId);expect(data.shoutHistory[0]!.id).toBe(result.mapping.shouts[1]!.derivedId);
  expect(result.derivedMusic.bytes.toString()).toContain('1.0');expect(result.derivedMusic.bytes.toString()).toContain('-0.0');expect(result.derivedMusic.bytes.toString()).toContain('1e-07');expect(verifyForwardLegacyResetGenerations(s.input,result).originalContentAndOrderRoundTripVerified).toBe(true);
  expect(prepareForwardLegacyResetGenerations(s.input).derivedMusic.bytes).toEqual(result.derivedMusic.bytes);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['name','entry id','old selection','level type','unused reference','created order','historic trend','trend value','shout id','archive placement','unknown literal','empty list reference'])('rejects re-pinned derived corruption with the independent reverse oracle: %s',async change=>{
  const s=await setup(),result=prepareForwardLegacyResetGenerations(s.input),bytes=changed(result.derivedMusic.bytes,change),bundle={...result,derivedMusic:{bytes,sha256:forwardHash(bytes)}};
  expect(()=>verifyForwardLegacyResetGenerations(s.input,bundle)).toThrow();expect(s.db.serialize()).toEqual(s.before);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);
});
it.each(['missing','order','identity','catalog'])('requires the full deterministic mapping: %s',async change=>{
  const s=await setup(),result=prepareForwardLegacyResetGenerations(s.input),mapping=structuredClone(result.mapping);
  if(change==='missing')mapping.entries.pop();if(change==='order')mapping.entries.reverse();if(change==='identity')mapping.entries[0]!.derivedId='e_'+'f'.repeat(40);if(change==='catalog')mapping.entries[0]!.catalog=false;
  expect(()=>verifyForwardLegacyResetGenerations(s.input,{...result,mapping})).toThrow();expect(s.db.serialize()).toEqual(s.before);
});
it.each(['unresolved selection','erased member','erased creator','erased shout','duplicate shout','unmatched entry','unresolved created'])('keeps original inputs and bot work when current source requires review: %s',async change=>{
  const s=await setup(),bytes=changed(s.latest,change);s.input.latestMusic={bytes,sha256:forwardHash(bytes)};
  expect(()=>prepareForwardLegacyResetGenerations(s.input)).toThrow();expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it('refuses to classify a current source while the last recorded reset completion is absent',async()=>{
  const s=await setup(false);expect(()=>prepareForwardLegacyResetGenerations(s.input)).toThrow('complete source and result');expect(s.db.serialize()).toEqual(s.before);
});
it('retains long original shout IDs within the source byte limit instead of imposing the catalog ID bound',async()=>{
  const s=await setup(),bytes=execFileSync('python3',['-c',"import sys\nfrom tools.migration.rollback_music_reset import _json,_encode\ndata=_json(sys.stdin.buffer.read());data['shouts'][0]['id']='聲'*500;sys.stdout.buffer.write(_encode(data))"],{input:s.latest,timeout:10000,stdio:['pipe','pipe','pipe']});s.input.latestMusic={bytes,sha256:forwardHash(bytes)};
  const result=prepareForwardLegacyResetGenerations(s.input);expect(result.mapping.shouts[0]!.originalKey).toBe('聲'.repeat(500));expect(verifyForwardLegacyResetGenerations(s.input,result).originalContentAndOrderRoundTripVerified).toBe(true);expect(s.db.serialize()).toEqual(s.before);
});
it.each(['entry','shout'])('reserves actual native IDs rather than overwriting a colliding %s',async kind=>{
  const s=await setup(),result=prepareForwardLegacyResetGenerations(s.input),db=new Database(s.input.nativeImage.bytes);cleanup.push(()=>db.close());
  if(kind==='entry')db.prepare("INSERT INTO music_entries VALUES(?,'reserved','sub')").run(result.mapping.entries[0]!.derivedId);
  else db.prepare("INSERT INTO music_shouts VALUES(?,NULL,'','reserved','body',2,NULL,999)").run(result.mapping.shouts[0]!.derivedId);
  const bytes=db.serialize();s.input.nativeImage={bytes,sha256:forwardHash(bytes)};expect(()=>prepareForwardLegacyResetGenerations(s.input)).toThrow('generation relation failed');expect(s.db.serialize()).toEqual(s.before);
});
it('binds native reservations to the original complete authority checkpoint and its lineage',async()=>{
  const s=await setup();s.input.checkpoint.sha256='f'.repeat(64);expect(()=>prepareForwardLegacyResetGenerations(s.input)).toThrow('source pin');s.input.checkpoint.sha256=forwardHash(s.input.checkpoint.bytes);
  const db=openDatabase(':memory:');cleanup.push(()=>db.close());const bytes=db.serialize();s.input.nativeImage={bytes,sha256:forwardHash(bytes)};expect(()=>prepareForwardLegacyResetGenerations(s.input)).toThrow('lineage differs');expect(s.db.serialize()).toEqual(s.before);
});
it.each(['latest bytes','vault declaration','async'])('rejects changing source boundaries without modifying original native data: %s',async change=>{
  const s=await setup();let count=0;const boundary=()=>{if(++count!==2)return;if(change==='latest bytes')s.input.latestMusic.bytes.fill(32);else writeFileSync(join(s.vault,'unexpected.txt'),'synthetic');};
  expect(()=>prepareForwardLegacyResetGenerations(s.input,change==='async'?(()=>Promise.resolve()) as unknown as ()=>void:boundary)).toThrow();expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
it.each(['derived bytes','mapping','final boundary'])('rejects bundle changes during independent verification: %s',async change=>{
  const s=await setup(),result=prepareForwardLegacyResetGenerations(s.input);let count=0;
  expect(()=>verifyForwardLegacyResetGenerations(s.input,result,()=>{
    if(++count!==(change==='final boundary'?3:2))return;
    if(change==='mapping')result.mapping.entries[0]!.catalog=false;
    else{result.derivedMusic.bytes.fill(32);result.derivedMusic.sha256=forwardHash(result.derivedMusic.bytes);}
  })).toThrow('bundle changed');
  expect(s.db.serialize()).toEqual(s.before);expect(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.bot);
});
