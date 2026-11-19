import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { identitySchema } from './identity-schema';
import { parseJson,object,keys } from './music-codec';
import type { IdentitySourceEvidence } from './identity-source';

export type IdentityRow={rowid:bigint;value:Record<string,string|number|bigint>};
export const identityTables=['sessions','links','used_oauth','prelinks','login_attempts','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents'] as const;
export const identityColumns={sessions:['token_hash','qq','expires','source_session','pending_until'],links:['qq','app_id','openid','user_id','created','source'],used_oauth:['attempt','created'],prelinks:['qq','user_id','created'],login_attempts:['bucket','created'],link_overrides:['qq','user_id','revision','updated'],link_audit:['id','qq','actor','before_user_id','after_user_id','created'],native_profiles:['qq','payload'],profile_contacts:['qq','number','updated'],entry_intents:['token_hash','qq','source_session','target_user_id','payload','expires']};
export const quoteIdentity=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function identitySeconds(value:unknown){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value))throw Error('Missing rollback identity timestamp provenance');const time=Date.parse(value)/1000;if(!Number.isFinite(time)||Math.abs(time)>8640000000000)throw Error('Invalid rollback identity timestamp provenance');return time;}
/** Decode original structural evidence and retained private rows only; this
 * reader applies no ownership, authentication, contact or audit projection. */
export function readRollbackIdentitySource(db:DB){
  const docs=db.prepare("SELECT position,payload_json FROM music_documents WHERE kind='identity_source' ORDER BY position").all() as {position:number;payload_json:string}[];
  const originals=db.prepare('SELECT table_name,row_number,payload_json FROM music_legacy_identity ORDER BY table_name,row_number').all() as {table_name:string;row_number:number;payload_json:string}[];
  const rows=Object.fromEntries(identityTables.map(name=>[name,[] as IdentityRow[]])) as Record<typeof identityTables[number],IdentityRow[]>;
  if(!docs.length){if(originals.length||db.prepare("SELECT 1 FROM migration_map WHERE source='music-identity'").get())throw Error('Missing rollback identity source evidence');return {rows,highWater:0n,reserved:new Map<string,bigint>(),evidence:null};}
  if(docs.length!==1||docs[0]!.position!==0)throw Error('Ambiguous rollback identity source evidence');
  const evidence=object(parseJson(docs[0]!.payload_json),'identity source') as unknown as IdentitySourceEvidence;
  keys(evidence as unknown as ReturnType<typeof object>,['version','schema','pragmas','sqliteSequence','tables'],'identity source');
  const reference=new Database(':memory:');
  try{
    reference.exec(identitySchema);
    const schema=reference.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    if(evidence.version!==1||JSON.stringify(evidence.schema)!==JSON.stringify(schema)||JSON.stringify(evidence.pragmas)!==JSON.stringify({userVersion:0,applicationId:0,encoding:'UTF-8'})||!Array.isArray(evidence.tables)||evidence.tables.length!==10)throw Error('Unsupported rollback identity source structure');
    const reserved=new Map<string,bigint>(),byTable=new Map<string,Map<number,{rowid:bigint;types:string[]}>>();
    for(const table of evidence.tables){
      keys(table as unknown as ReturnType<typeof object>,['name','columns','rows'],'identity table evidence');
      if(!identityTables.includes(table.name as typeof identityTables[number])||byTable.has(table.name)||JSON.stringify(table.columns)!==JSON.stringify(reference.prepare(`PRAGMA table_xinfo(${quoteIdentity(table.name)})`).all())||!Array.isArray(table.rows))throw Error('Invalid rollback identity source table');
      const records=new Map<number,{rowid:bigint;types:string[]}>();let last:bigint|null=null,maximum=0n;
      for(const [index,row] of table.rows.entries()){
        keys(row as unknown as ReturnType<typeof object>,['rowNumber','rowid','storageClasses'],'identity row evidence');
        if(row.rowNumber!==index||typeof row.rowid!=='string'||! /^-?(?:0|[1-9]\d*)$/.test(row.rowid)||!Array.isArray(row.storageClasses)||row.storageClasses.length!==table.columns.length||row.storageClasses.some(type=>!['integer','real','text'].includes(type)))throw Error('Invalid rollback identity row structure');
        const rowid=BigInt(row.rowid);if(rowid<-9223372036854775808n||rowid>9223372036854775807n||last!==null&&rowid<=last)throw Error('Invalid rollback identity rowid');last=rowid;maximum=rowid>maximum?rowid:maximum;
        records.set(index,{rowid,types:row.storageClasses});
      }
      reserved.set(table.name,maximum);byTable.set(table.name,records);
    }
    if(!Array.isArray(evidence.sqliteSequence)||evidence.sqliteSequence.length>1)throw Error('Invalid rollback identity high-water');
    let highWater=0n;
    for(const row of evidence.sqliteSequence){keys(row as unknown as ReturnType<typeof object>,['name','seq'],'identity sequence evidence');if(row.name!=='link_audit'||typeof row.seq!=='string'||!/^(?:0|[1-9]\d*)$/.test(row.seq))throw Error('Invalid rollback identity high-water');highWater=BigInt(row.seq);if(highWater>9223372036854775807n||highWater<(reserved.get('link_audit')??0n))throw Error('Invalid rollback identity high-water');}
    if(!evidence.sqliteSequence.length&&(reserved.get('link_audit')??0n)>0n)throw Error('Missing rollback identity high-water');
    for(const row of originals){
      const table=row.table_name as typeof identityTables[number],structure=byTable.get(table)?.get(row.row_number);if(!structure)throw Error('Unmapped rollback identity source row');
      const value=object(parseJson(row.payload_json),'identity row');keys(value,identityColumns[table],'identity row');if(Object.keys(value).length!==identityColumns[table].length)throw Error('Incomplete rollback identity source row');
      const restored:Record<string,string|number|bigint>={};
      for(const [index,column] of identityColumns[table].entries()){
        const field=value[column],type=structure.types[index];
        if(type==='text'){if(typeof field!=='string')throw Error('Invalid rollback identity text storage');restored[column]=field;}
        else{if(typeof field!=='number'||!Number.isFinite(field)||Math.abs(field)>Number.MAX_SAFE_INTEGER||type==='integer'&&!Number.isSafeInteger(field))throw Error('Invalid rollback identity numeric storage');restored[column]=type==='integer'?BigInt(field):field;}
      }
      if(table==='link_audit'&&restored.id!==structure.rowid)throw Error('Rollback identity audit ID differs from rowid');
      rows[table].push({rowid:structure.rowid,value:restored});
    }
    return {rows,highWater,reserved,evidence};
  }finally{reference.close();}
}
