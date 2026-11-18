import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, type DB } from '@qgroup/database';
import { legacySchema } from '../../../packages/database/src/legacy-schema';
import { identitySchema } from '../../../tools/migration/identity-schema';
import { importSnapshot } from '../../../tools/migration/import-snapshot';
import { digest } from '../../../tools/migration/music-codec';
import { fixture } from './fixture';
import { hash } from '../src/security';

/** Synthetic immutable capture-shaped history; container acquisition is covered
 * separately by capture-snapshot tests. This helper imports its actual current DB. */
export async function legacyHistoryFixture(options:{boardLedger?:string;musicLedger?:string}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-legacy-history-'))),capture=join(root,'capture'),current=join(capture,'current'),stamp='20261118-010203';
  let db:DB|undefined;
  try {
    mkdirSync(join(current,'music/walls'),{recursive:true,mode:0o700});mkdirSync(join(current,'images'),{mode:0o700});
    const board=new Database(join(current,'board.sqlite3'));try{board.exec(legacySchema);board.exec('CREATE TEMP TABLE music_entries(id TEXT,name TEXT,kind TEXT)');fixture(board);board.exec("INSERT INTO site_settings(id) VALUES(1); INSERT INTO bot_settings VALUES(1,0,'{}','baseline'); INSERT INTO bot_settings_history VALUES(0,'{}','baseline','','baseline'); INSERT INTO bot_runtime(id) VALUES(1)");
      board.prepare("INSERT INTO users VALUES('contact-owner',?,'原生成分帳號','synthetic')").run(hash('fixture-contact-owner'));board.prepare("INSERT INTO browser_sessions VALUES(?,'contact-owner','synthetic')").run(hash('fixture-contact-owner'));
    }finally{board.close();}
    const identity=new Database(join(current,'music/identity.sqlite3'));let identityBytes:Buffer;
    const nativeKey='m_'+'a'.repeat(24);
    try{identity.exec(identitySchema);identity.prepare('INSERT INTO prelinks VALUES(?,?,?)').run('10001','alice',123);identity.prepare('INSERT INTO prelinks VALUES(?,?,?)').run('10002','bob',123);identity.prepare('INSERT INTO prelinks VALUES(?,?,?)').run(nativeKey,'contact-owner',123);identityBytes=identity.serialize();}finally{identity.close();}
    const entries={e:{id:'e',text:'歷史詞條',kind:'sub',createdBy:'10002',aliases:['原別名'],createdAt:123}};
    const member=(qq:string,name:string)=>({qq,name,selection:[{id:'e',level:4},{id:'e',level:'2'}],created:['e'],consent:true,note:'歷史私人留言',pinHash:'HISTORICAL-PIN-NEVER-EXPORTED',boardUserId:qq==='10001'?'alice':qq==='10002'?'bob':'',contactQQ:qq});
    const data={entries,members:{'10001':member('10001','原稱呼alice'),'10002':member('10002','原稱呼bob'),[nativeKey]:{...member(nativeKey,'原生成分'),contactQQ:'12345'}},settings:{adminPasswordHash:'HISTORICAL-ADMIN-NEVER-EXPORTED'},shouts:[{id:'old',qq:'10002',name:'舊作者',text:'歷史私人喊話',createdAt:123}],shoutHistory:[{id:'orphan',qq:'99999',name:'原作者',text:'孤兒歷史',createdAt:122,archivedAt:124}],trend:[{t:123,counts:{e:2}}]};
    const save=(path:string,value:unknown)=>{mkdirSync(join(capture,path,'..'),{recursive:true,mode:0o700});writeFileSync(join(capture,path),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});};
    const currentData=structuredClone(data);for(const member of Object.values(currentData.members))member.pinHash='CURRENT-PIN';
    save('current/music/data.json',currentData);save('current/music/erasures.jsonl',options.musicLedger??'');save('current/board.erasures.jsonl',options.boardLedger??'');save('current/music/walls/manifest.json',{items:[]});
    const historical={...data,members:{...data.members,'10004':member('10004','歷史獨有成分')}};
    const pair='history/music/paired-backups/'+stamp;
    save(pair+'/data.json',historical);save(pair+'/identity.sqlite3',identityBytes!);save(pair+'/walls/manifest.json',{items:[{src:'/walls/old.png'}]});save(pair+'/walls/old.png',Buffer.from('synthetic-private-wall'));
    save('history/music/backups/data-'+stamp+'.json',historical);
    const manifestPath=join(capture,'capture-manifest.json');
    function repin(){
      const files:{path:string;size:number;sha256:string}[]=[];
      const walk=(path:string,prefix='')=>{for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const relative=prefix+item.name;if(item.isDirectory())walk(join(path,item.name),relative+'/');else if(relative!=='capture-manifest.json'){const bytes=readFileSync(join(path,item.name));files.push({path:relative,size:bytes.length,sha256:digest(bytes)});}}};walk(capture);
      const manifest={version:1,createdAt:'2026-11-19T00:00:00.000Z',files,sourceDigest:digest(JSON.stringify(files)),releaseEligible:false};save('capture-manifest.json',manifest);return {root:capture,manifestSha256:digest(readFileSync(manifestPath))};
    }
    let config=repin();await importSnapshot(current,join(root,'candidate'),new Date('2026-11-19T00:00:00Z'));db=openDatabase(join(root,'candidate/unified.sqlite3'));
    return {root,capture,db,data,historical,pair,stamp,config,save,repin,close(){db?.close();rmSync(root,{recursive:true,force:true});}};
  }catch(error){db?.close();rmSync(root,{recursive:true,force:true});throw error;}
}
