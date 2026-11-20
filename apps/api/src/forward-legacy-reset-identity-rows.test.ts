import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identitySchema} from '../../../tools/migration/identity-schema';
import {prepareForwardLegacyResetIdentityRows,verifyForwardLegacyResetIdentityRows,type ResetIdentityRowsInput} from '../../../tools/migration/forward-legacy-reset-identity-rows';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
const open=(bytes?:Buffer)=>{const db=bytes?new Database(bytes):new Database(':memory:');if(!bytes)db.exec(identitySchema);cleanup.push(()=>db.close());return db;};
function setup(){
  const b=open(),n=open(),o=open();
  for(const [db,key,user] of [[n,'m_'+'a'.repeat(24),'native-user'],[o,'m_'+'b'.repeat(24),'old-user']] as const){
    db.prepare('INSERT INTO native_profiles(rowid,qq,payload) VALUES(1,?,?)').run(key,JSON.stringify({qq:key,name:user,boardUserId:user}));db.prepare('INSERT INTO prelinks(rowid,qq,user_id,created) VALUES(1,?,?,123.5)').run(key,user);db.prepare('INSERT INTO profile_contacts(rowid,qq,number,updated) VALUES(1,?,?,124.5)').run(key,db===n?'12345':'23456');
  }
  o.prepare("INSERT INTO used_oauth(rowid,attempt,created) VALUES(-9,'old-consumed',123.5)").run();o.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',777)").run();
  return {b,n,o,input:{baseline:pin(b.serialize()),native:pin(n.serialize()),old:pin(o.serialize())} satisfies ResetIdentityRowsInput};
}
it('binds all three distinct concurrent member row collisions and retains exact original values, types, signed IDs and sequence',()=>{
  const s=setup(),result=prepareForwardLegacyResetIdentityRows(s.input),db=open(result.identity.bytes);
  expect(result.bindings).toEqual(['native_profiles','prelinks','profile_contacts'].map(table=>({table,qq:'m_'+'b'.repeat(24),originalRowid:'1',derivedRowid:'2'})));
  for(const table of ['native_profiles','prelinks','profile_contacts'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(s.o,table)].map(row=>({...row,__forward_rowid__:2n})));
  expect([...forwardRows(db,'used_oauth')]).toEqual([...forwardRows(s.o,'used_oauth')]);expect([...forwardRows(db,'sqlite_sequence')]).toEqual([...forwardRows(s.o,'sqlite_sequence')]);expect(verifyForwardLegacyResetIdentityRows(s.input,result).allValuesAndStorageClassesVerified).toBe(true);expect(s.o.serialize()).toEqual(s.input.old.bytes);expect(s.n.serialize()).toEqual(s.input.native.bytes);
});
it.each(['common-slot','common-key','same-new-key'] as const)('does not silently relocate a %s conflict that needs explicit business reconciliation',kind=>{
  const s=setup();if(kind==='common-slot')s.b.prepare("INSERT INTO prelinks VALUES('10001','original-user',123)").run();if(kind==='common-key')s.b.prepare("INSERT INTO prelinks(rowid,qq,user_id,created) VALUES(99,?,'original-user',123)").run('m_'+'b'.repeat(24));if(kind==='same-new-key')s.n.prepare('UPDATE prelinks SET qq=?').run('m_'+'b'.repeat(24));s.input.baseline=pin(s.b.serialize());s.input.native=pin(s.n.serialize());const result=prepareForwardLegacyResetIdentityRows(s.input);expect(result.bindings.some(row=>row.table==='prelinks')).toBe(false);expect([...forwardRows(open(result.identity.bytes),'prelinks')]).toEqual([...forwardRows(s.o,'prelinks')]);
});
it.each(['value','storage','rowid','omitted-binding','forged-binding','high-water','unrelated-row','metadata'] as const)('independently rejects re-pinned %s corruption',kind=>{
  const s=setup(),original=prepareForwardLegacyResetIdentityRows(s.input),db=open(original.identity.bytes),bindings=original.bindings.map(row=>({...row}));
  if(kind==='value')db.prepare("UPDATE prelinks SET user_id='forged'").run();if(kind==='storage')db.prepare('UPDATE native_profiles SET payload=?').run(Buffer.from('{}'));if(kind==='rowid')db.prepare('UPDATE native_profiles SET rowid=3').run();if(kind==='omitted-binding')bindings.pop();if(kind==='forged-binding')bindings[0]!.originalRowid='99';if(kind==='high-water')db.prepare('UPDATE sqlite_sequence SET seq=778').run();if(kind==='unrelated-row')db.prepare("INSERT INTO used_oauth VALUES('forged',0)").run();if(kind==='metadata')db.pragma('application_id=99');expect(()=>verifyForwardLegacyResetIdentityRows(s.input,{identity:pin(db.serialize()),bindings})).toThrow();
});
it('rejects derived row capacity exhaustion before producing a remapped image',()=>{
  const s=setup();s.o.prepare('INSERT INTO native_profiles(rowid,qq,payload) VALUES(?,?,?)').run(9223372036854775807n,'m_'+'c'.repeat(24),'{}');s.input.old=pin(s.o.serialize());const original=Buffer.from(s.input.old.bytes);expect(()=>prepareForwardLegacyResetIdentityRows(s.input)).toThrow('capacity exhausted');expect(s.input.old.bytes).toEqual(original);
});
it.each(['baseline','native','old'] as const)('fences original %s source changes during remapping',key=>{
  const s=setup();let calls=0;expect(()=>prepareForwardLegacyResetIdentityRows(s.input,()=>{if(++calls===2)s.input[key].bytes[0]=s.input[key].bytes[0]!^1;})).toThrow('source changed');expect(calls).toBe(2);
});
it('fences output mappings and rejects asynchronous boundaries',()=>{
  const s=setup(),result=prepareForwardLegacyResetIdentityRows(s.input);let calls=0;expect(()=>verifyForwardLegacyResetIdentityRows(s.input,result,()=>{if(++calls===2)result.bindings=[];})).toThrow('output changed');expect(()=>prepareForwardLegacyResetIdentityRows(s.input,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');
});

it('independently verifies multiple row collisions, every original value, type and high-water with readonly Python SQLite',()=>{
  const s=setup();s.n.prepare('INSERT INTO native_profiles(rowid,qq,payload) VALUES(7,?,?)').run('m_'+'c'.repeat(24),JSON.stringify({qq:'m_'+'c'.repeat(24),name:'native second'}));s.o.prepare('INSERT INTO native_profiles(rowid,qq,payload) VALUES(7,?,?)').run('m_'+'d'.repeat(24),JSON.stringify({qq:'m_'+'d'.repeat(24),name:'old second'}));s.input.native=pin(s.n.serialize());s.input.old=pin(s.o.serialize());const result=prepareForwardLegacyResetIdentityRows(s.input),root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-identity-row-oracle-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  for(const [name,bytes] of [['baseline',s.input.baseline.bytes],['native',s.input.native.bytes],['old',s.input.old.bytes],['derived',result.identity.bytes]] as const)writeFileSync(join(root,name+'.sqlite3'),bytes,{mode:0o600});
  const receipt=JSON.parse(execFileSync('python3',['-I','-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);remappable=['native_profiles','prelinks','profile_contacts'];bindings=[]
with ExitStack() as stack:
 db={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('baseline','native','old','derived')}
 names=[row[0] for row in db['old'].execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")];assert len(names)==10
 for table in names:
  columns=[r[1] for r in db['old'].execute('PRAGMA table_xinfo("'+table+'")')]
  query='SELECT rowid,*,'+','.join('typeof("'+c+'")' for c in columns)+' FROM "'+table+'" ORDER BY rowid'
  sources={name:list(db[name].execute(query)) for name in db};expected=[]
  high=max([0]+[r[0] for name in ('baseline','native','old') for r in sources[name]])
  for row in sources['old']:
   wanted=list(row)
   if table in remappable:
    alias=columns.index('qq')+1;n=next((r for r in sources['native'] if r[0]==row[0]),None);before=sources['baseline']
    if n and n[alias]!=row[alias] and not any(b[0]==row[0] or b[alias] in (row[alias],n[alias]) for b in before):
     high+=1;wanted[0]=high;bindings.append(dict(table=table,qq=row[alias],originalRowid=str(row[0]),derivedRowid=str(high)))
   expected.append(tuple(wanted))
  assert sorted(expected)==sources['derived'],table
 assert list(db['old'].execute('SELECT rowid,* FROM sqlite_sequence'))==list(db['derived'].execute('SELECT rowid,* FROM sqlite_sequence'))
 assert db['derived'].execute('PRAGMA integrity_check').fetchone()==('ok',)
 bindings.sort(key=lambda b:(remappable.index(b['table']),int(b['originalRowid'])))
 print(json.dumps(dict(tables=10,bindings=bindings,allOriginalValuesAndTypes=True,originalHighWater=True)))`,root],{encoding:'utf8',timeout:10000}));expect(receipt).toEqual({tables:10,bindings:result.bindings,allOriginalValuesAndTypes:true,originalHighWater:true});expect(result.bindings.filter(row=>row.table==='native_profiles').map(row=>row.derivedRowid)).toEqual(['8','9']);
});
