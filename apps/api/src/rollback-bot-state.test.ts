import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {AbbreviationDelivery} from '../../bot/src/abbreviation-delivery';
import {BotWordMask} from '../../bot/src/word-mask';
import {GROUP_PUSH_BLOCK,readBotAuthorizationBlock} from '../../bot/src/group-state';
import {captureRollbackBotState,encodeRollbackBotIndex,pinRollbackBotState,verifyRollbackBotState,type RollbackBotState} from '../../../tools/migration/rollback-bot-state';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const token='a'.repeat(24),group='synthetic-group',groupRef=createHash('sha256').update(group).digest('hex'),body='已讀🙂續讀正文';
function setup(options:{absent?:boolean;words?:boolean}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-rollback-bot-'))),database=join(root,'unified.sqlite3'),logs=join(root,'bot-logs'),abbreviations=join(root,'bot-abbreviation-results'),words=join(root,'sensitive-words.json');cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=openDatabase(database);db.close();
  const save=(folder:string,name:string,bytes:string)=>{writeFileSync(join(folder,name),bytes,{mode:0o600});utimesSync(join(folder,name),1000,1001);};
  if(!options.absent){mkdirSync(logs,{mode:0o700});mkdirSync(abbreviations,{mode:0o700});
    save(logs,'bot-group-state.json',JSON.stringify({push_authorized:false,code:40034105,recorded_at:'original'}));
    save(logs,'bot-group-state-'+'b'.repeat(20)+'.json','{"push_authorized":false}');
    save(logs,'bot-health.json','{"runtime_state":"stopped","last_ack":999}');
    for(const suffix of ['', '.1','.2','.3','.4'])save(logs,'bot-events.jsonl'+suffix,'{"event":"synthetic","private":"raw-evidence"}\n');
    save(logs,'.bot-health-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.tmp','{"incomplete":');
    save(logs,'.bot-group-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.tmp','{"incomplete":');
    save(abbreviations,token+'.json',JSON.stringify({group:groupRef,created:1000,offset:Buffer.byteLength('已讀🙂'),budget:2000,uncertain:true,body:token+'.'+'c'.repeat(12)+'.txt',section_ends:[Buffer.byteLength(body)]}));
    save(abbreviations,token+'.'+'c'.repeat(12)+'.txt',body);save(abbreviations,token+'.txt','original unused body');
    save(abbreviations,token+'.json.'+'d'.repeat(12)+'.tmp','{"incomplete":');
  }
  if(options.words!==false)save(root,'sensitive-words.json','["合成屏蔽詞"]');
  const input={database,logDirectory:logs,sensitiveWordsFile:options.words===false?null:words};
  return {root,database,logs,abbreviations,words,input,capture:()=>captureRollbackBotState(input,new Date('2026-11-19T08:00:00Z'))};
}
function clone(state:RollbackBotState):RollbackBotState{return {...state,sources:{...state.sources},directories:state.directories.map(row=>({...row})),files:state.files.map(file=>({...file,bytes:Buffer.from(file.bytes)}))};}
it('captures current group restrictions, all log rotations, uncertainty/cursors, revised and temporary bodies and custom words without writes or time renewal',()=>{
  const s=setup(),mode=lstatSync(s.words).mode,mtime=lstatSync(s.words,{bigint:true}).mtimeNs,db=readFileSync(s.database),captured=s.capture();
  expect(captured.report.rollbackEligible).toBe(false);expect(captured.state.files).toHaveLength(15);expect(captured.pin).toBe(pinRollbackBotState(captured.state));
  expect(captured.state.sources.abbreviationDirectory).toBe(s.abbreviations);expect(captured.state.directories).toEqual([{role:'logs',exists:true},{role:'abbreviations',exists:true}]);
  for(const file of captured.state.files){const source=file.path.startsWith('logs/')?join(s.logs,file.path.slice(5)):file.path.startsWith('abbreviations/')?join(s.abbreviations,file.path.slice(14)):s.words;expect(file.bytes).toEqual(readFileSync(source));expect(file.mtimeNs).toBe(lstatSync(source,{bigint:true}).mtimeNs.toString());}
  expect(captured.state.files.find(file=>file.path==='abbreviations/'+token+'.json')!.bytes.toString()).toContain('"uncertain":true');
  expect(captured.state.files.find(file=>file.path.startsWith('logs/.bot-health'))!.bytes.toString()).toBe('{"incomplete":');
  captured.assertUnchanged();expect(readFileSync(s.database)).toEqual(db);expect(lstatSync(s.words).mode).toBe(mode);expect(lstatSync(s.words,{bigint:true}).mtimeNs).toBe(mtime);expect(encodeRollbackBotIndex(captured.state).toString()).not.toContain('raw-evidence');
});
it('preserves original metadata for actual continuation reads with group/expiry restrictions, and retains current authorization denial',async()=>{
  const s=setup(),captured=s.capture(),copy=join(s.root,'disposable-continuations'),copyLogs=join(s.root,'disposable-logs');mkdirSync(copy,{mode:0o700});mkdirSync(copyLogs,{mode:0o700});
  for(const file of captured.state.files){const root=file.path.startsWith('abbreviations/')?copy:file.path.startsWith('logs/')?copyLogs:null;if(root)writeFileSync(join(root,file.path.split('/')[1]!),file.bytes,{mode:0o600});}
  const path=join(copy,token+'.json'),before=readFileSync(path),delivery=new AbbreviationDelivery(copy,{clock:()=>2000,loadMask:()=>new BotWordMask([])});
  const page=await delivery.continuation(group,'继续 '+token);expect(page?.token).toBe(token);expect(String(page?.text)).toBe('續讀正文');expect(readFileSync(path)).toEqual(before);
  expect((await delivery.continuation('another-group','继续 '+token))?.token).toBeUndefined();
  const expired=new AbbreviationDelivery(copy,{clock:()=>4601,loadMask:()=>new BotWordMask([])});expect((await expired.continuation(group,'继续 '+token))?.token).toBeUndefined();expect(readFileSync(path)).toEqual(before);
  expect(readBotAuthorizationBlock(copyLogs,group,group)).toBe(GROUP_PUSH_BLOCK);captured.assertUnchanged();
});
it('records absent directories and unconfigured words distinctly without creating them',()=>{
  const s=setup({absent:true,words:false}),captured=s.capture();expect(captured.state.files).toEqual([]);expect(captured.state.sources.sensitiveWordsFile).toBeNull();expect(captured.state.directories.every(row=>!row.exists)).toBe(true);captured.assertUnchanged();expect(existsSync(s.logs)).toBe(false);expect(existsSync(s.abbreviations)).toBe(false);expect(existsSync(s.words)).toBe(false);
  mkdirSync(s.logs);expect(()=>captured.assertUnchanged()).toThrow('appeared');
});
it.each(['log bytes','continuation cursor','word bytes','mtime only','file replacement','file removed','extra log','extra continuation','root replacement','database replacement','hardlink after capture','parent replacement'])('detects %s after acquisition and leaves evidence intact',change=>{
  const s=setup(),captured=s.capture(),path=join(s.abbreviations,token+'.json');
  if(change==='log bytes')writeFileSync(join(s.logs,'bot-group-state.json'),'{"push_authorized":true}');
  if(change==='continuation cursor')writeFileSync(path,'{"offset":0}');if(change==='word bytes')writeFileSync(s.words,'[]');if(change==='mtime only')utimesSync(path,1000,1002);
  if(change==='file replacement'){renameSync(path,path+'.saved');copyFileSync(path+'.saved',path);rmSync(path+'.saved');}
  if(change==='file removed')rmSync(path);if(change==='extra log')writeFileSync(join(s.logs,'bot-events.jsonl.5'),'new');if(change==='extra continuation')writeFileSync(join(s.abbreviations,'b'.repeat(24)+'.txt'),'new');
  if(change==='root replacement'){renameSync(s.logs,s.logs+'.saved');mkdirSync(s.logs);}
  if(change==='database replacement'){renameSync(s.database,s.database+'.saved');copyFileSync(s.database+'.saved',s.database);}
  if(change==='hardlink after capture')linkSync(s.words,join(s.root,'extra-link'));
  if(change==='parent replacement'){const saved=s.root+'.saved';renameSync(s.root,saved);mkdirSync(s.root);cleanup.push(()=>rmSync(saved,{recursive:true,force:true}));}
  expect(()=>captured.assertUnchanged()).toThrow();expect(existsSync(s.root)).toBe(true);
});
it.each(['root symlink','file symlink','file hardlink','directory entry','unknown log','unknown continuation','missing configured words','noncanonical database'])('rejects unsafe %s without modifying sources',change=>{
  const s=setup(),db=readFileSync(s.database),path=join(s.logs,'bot-health.json');
  if(change==='root symlink'){renameSync(s.logs,s.logs+'.saved');symlinkSync(s.logs+'.saved',s.logs);}
  if(change==='file symlink'){rmSync(path);symlinkSync(s.words,path);}if(change==='file hardlink'){rmSync(path);linkSync(s.words,path);}if(change==='directory entry'){rmSync(path);mkdirSync(path);}
  if(change==='unknown log')writeFileSync(join(s.logs,'credentials.env'),'synthetic-private');if(change==='unknown continuation')writeFileSync(join(s.abbreviations,'unknown'),'synthetic-private');if(change==='missing configured words')rmSync(s.words);
  if(change==='noncanonical database')s.input.database=s.database+'/../unified.sqlite3';expect(()=>s.capture()).toThrow();expect(readFileSync(s.database)).toEqual(db);
});
it.each(['changed bytes','changed group scope','renewed mtime','renewed capture time','changed source path','duplicate file','reordered inventory','absent directory','lost word file','extra word file','unknown path','unknown root','unknown file field'])('rejects %s against the saved original bot pin',change=>{
  const s=setup(),captured=s.capture(),state=clone(captured.state);
  if(change==='changed bytes')state.files[0]!.bytes=Buffer.from('wrong');if(change==='changed group scope'){const row=state.files.find(file=>file.path==='abbreviations/'+token+'.json')!;row.bytes=Buffer.from(row.bytes.toString().replace(groupRef,'0'.repeat(64)));}
  if(change==='renewed mtime')state.files[0]!.mtimeNs='2000000000000';if(change==='renewed capture time')state.capturedAt='2026-11-20T00:00:00Z';if(change==='changed source path')state.sources.logDirectory='/private/other';if(change==='duplicate file')state.files[1]=state.files[0]!;if(change==='reordered inventory')state.files.reverse();if(change==='absent directory')state.directories[0]!.exists=false;if(change==='lost word file')state.files=state.files.filter(file=>!file.path.startsWith('configuration/'));if(change==='extra word file')state.sources.sensitiveWordsFile=null;
  if(change==='unknown path')state.files[0]!.path='../private';if(change==='unknown root')Object.assign(state,{rollbackEligible:true});if(change==='unknown file field')Object.assign(state.files[0]!,{active:true});
  expect(()=>verifyRollbackBotState(state,captured.pin)).toThrow();captured.assertUnchanged();
});
it('keeps source file mode even when the configured word file was public-readable',()=>{const s=setup();chmodSync(s.words,0o644);const captured=s.capture();expect(lstatSync(s.words).mode&0o777).toBe(0o644);captured.assertUnchanged();});
it('refuses configured SQLite aliases before an additional FD could release the business writer lock',()=>{
  const s=setup(),db=openDatabase(s.database);try{db.exec('BEGIN IMMEDIATE');expect(()=>captureRollbackBotState({...s.input,sensitiveWordsFile:s.database})).toThrow('alias');
    const competitor=new Database(s.database,{timeout:0});try{expect(()=>competitor.exec('BEGIN IMMEDIATE')).toThrow('locked');}finally{competitor.close();}
    db.exec('ROLLBACK');
  }finally{db.close();}
});
