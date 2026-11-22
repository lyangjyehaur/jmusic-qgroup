import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { openDatabase } from '@qgroup/database';
import { createApp } from '../../apps/api/src/app';
import { fixture } from '../../apps/api/testsupport/fixture';
// Input contains only relabelled graph shape. Never load production identities, names, settings or credentials.
const Input=z.object({observedAt:z.string(),readOnly:z.literal(true),valuesFromLive:z.literal(true),anonymized:z.literal(true),identifiersExported:z.literal(false),namesExported:z.literal(false),unknownEntries:z.literal(0),entries:z.array(z.object({id:z.string().regex(/^e\d+$/),name:z.string().regex(/^詞\d+$/),kind:z.enum(['main','sub']),count:z.number().int().nonnegative()}).strict()),members:z.array(z.object({id:z.string().regex(/^m\d+$/),name:z.string().regex(/^人\d+$/),selections:z.array(z.object({entryId:z.string().regex(/^e\d+$/),level:z.number().int().min(1).max(4)}).strict()).max(20)}).strict())}).strict();
assert(process.argv.length===3&&isAbsolute(process.argv[2]!));
const bytes=readFileSync(process.argv[2]!),shape=Input.parse(JSON.parse(bytes.toString('utf8'))),db=openDatabase(':memory:');fixture(db);
db.prepare('DELETE FROM music_entries').run();
for(const e of shape.entries)db.prepare('INSERT INTO music_entries VALUES(?,?,?)').run(e.id,e.name,e.kind);
for(const [i,m] of shape.members.entries()){
 db.prepare("INSERT INTO music_profiles VALUES(?,?,0,'synthetic',NULL)").run(m.id,i===0?'alice':null);
 db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'',0,'',0,0,'synthetic')").run(m.id,m.name);
 for(const [position,p] of m.selections.entries())db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(m.id,p.entryId,p.level,position);
}
const entryRows=db.prepare('SELECT id,name,kind FROM music_entries ORDER BY id').all();
const expectedEntries=shape.entries.map(({id,name,kind})=>({id,name,kind}));
const order=(a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0;expectedEntries.sort(order);
assert.deepEqual(entryRows,expectedEntries);
const expectedSelections=shape.members.flatMap(m=>m.selections.map((p,position)=>({profile_id:m.id,entry_id:p.entryId,level:p.level,position}))).sort((a,b)=>a.profile_id<b.profile_id?-1:a.profile_id>b.profile_id?1:a.position-b.position);
assert.deepEqual(db.prepare('SELECT profile_id,entry_id,level,position FROM music_selections ORDER BY profile_id,position').all(),expectedSelections);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM music_profiles').get() as {n:number}).n,shape.members.length);
for(const entry of shape.entries)assert.equal((db.prepare('SELECT COUNT(*) AS n FROM music_selections WHERE entry_id=?').get(entry.id) as {n:number}).n,entry.count);
const origin='https://benchmark.invalid',app=createApp({db,origin,musicTrendSampling:false,pairedBackupScheduling:false});
try{
 await app.ready();const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json(),headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
 const get=async(url:string)=>{const r=await app.inject({url,headers});assert.equal(r.statusCode,200,r.body);return r.json();};
 const source=await get('/api/v2/music/rooms/source'),selected=source.members.slice(0,40).map((m:{id:string})=>m.id),samples=[];
 const before=db.prepare('SELECT total_changes() AS n').get();
 for(const [name,work] of [
  ['search',()=>get('/api/v2/search?q='+encodeURIComponent('詞'))],
  ['matches',()=>get('/api/v2/music/matches')],
  ['circles',()=>get('/api/v2/music/circles')],
  ['roomSplit40',async()=>{const r=await app.inject({method:'POST',url:'/api/v2/music/rooms/calculate',headers,payload:{command:'split',sourceVersion:source.sourceVersion,selected,config:{mode:'capacity',value:10},sameGender:false}});assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().rooms.flatMap((x:{members:string[]})=>x.members).sort(),[...selected].sort());return r.json();}],
 ] as const){
  const timings:number[]=[];
  for(let i=0;i<5;i++){const start=performance.now();await work();timings.push(performance.now()-start);}
  timings.sort((a,b)=>a-b);samples.push({name,repetitions:5,medianMilliseconds:Number(timings[2]!.toFixed(2)),maxMilliseconds:Number(timings[4]!.toFixed(2))});
 }
 assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),before);
 console.log(JSON.stringify({version:1,inputSha256:createHash('sha256').update(bytes).digest('hex'),observedAt:shape.observedAt,members:shape.members.length,entries:shape.entries.length,totalSelections:shape.members.reduce((n,m)=>n+m.selections.length,0),picksPerMemberMax:Math.max(...shape.members.map(m=>m.selections.length)),valuesFromLive:true,anonymized:true,relationshipRowsVerified:true,selectionOrderAndLevelsVerified:true,formalPrivateMigrationVerified:false,productionChanged:false,databaseWritesDuringMeasurements:0,concurrency:1,measuredPeakTraffic:false,node:process.version,platform:process.platform,arch:process.arch,rssMiB:Number((process.memoryUsage().rss/2**20).toFixed(1)),samples,releaseEligible:false}));
}finally{await app.close();db.close();}
