import Database from 'better-sqlite3';
import {gunzipSync} from 'node:zlib';
import type {DB} from '@qgroup/database';
import {digest} from './music-codec';
import type {RollbackPackage} from './rollback-package-codec';
import {openHistoryNative} from './rollback-history-source';
import {verifyRollbackBoard} from './rollback-board-reconciliation';

export const boardLegacyStamp=/^[0-9]{8}-[0-9]{6}-[0-9]{6}$/;
export const boardNativeStamp=/^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/;
export const boardImagePath=/^images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/;
export type BoardHistoryMetadata={id:string;source:'legacy_board'|'native_board';sourceStamp:string;createdAt:string|null;schema:number|null;databaseSha256:string;assetsSha256:string|null};
const maximum=512*1024*1024;
function field(bytes:Buffer,start:number,length:number){const raw=bytes.subarray(start,start+length),end=raw.indexOf(0);if(end>=0&&raw.subarray(end).some(byte=>byte!==0))throw Error('Invalid tar text padding');return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(end<0?raw:raw.subarray(0,end));}
function octal(bytes:Buffer,start:number,length:number){const raw=bytes.subarray(start,start+length).toString('ascii');if(bytes.subarray(start,start+length).some(byte=>byte>127)||!/^ *[0-7]+[\0 ]*$/.test(raw))throw Error('Unsupported tar number');const value=parseInt(raw.trim().replace(/\0/g,''),8);if(!Number.isSafeInteger(value)||value<0)throw Error('Unsafe tar number');return value;}
/** The old backup.py emits regular ustar files only, not links, directories,
 * PAX or GNU extensions. Decode in memory with a bound; never extract a tar path.
 * Original compressed bytes stay in the externally pinned private package. */
export function readBoardImageArchive(encoded:Buffer){
  if(!Buffer.isBuffer(encoded)||encoded.length>maximum)throw Error('Historical image archive exceeds limit');
  const tar=gunzipSync(encoded,{maxOutputLength:maximum}),files=new Map<string,Buffer>();if(tar.length%512!==0)throw Error('Incomplete historical image archive');
  let offset=0,ended=false;
  while(offset+512<=tar.length){const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0)){if(offset+1024>tar.length||tar.subarray(offset).some(byte=>byte!==0))throw Error('Invalid tar end or trailing archive');ended=true;break;}
    const sum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0);if(octal(header,148,8)!==sum)throw Error('Historical tar checksum differs');
    if(field(header,257,6)!=='ustar'||field(header,263,2)!=='00'||field(header,345,155)!==''||field(header,157,100)!==''||![0,48].includes(header[156]!))throw Error('Unsupported historical tar entry');
    const path=field(header,0,100),size=octal(header,124,12);if(!boardImagePath.test(path)||path.slice(7,9)!==path.slice(10,12)||files.has(path)||size>maximum)throw Error('Unsafe or duplicate historical image path');
    const start=offset+512,end=start+size,next=start+Math.ceil(size/512)*512;if(end>tar.length||next>tar.length||tar.subarray(end,next).some(byte=>byte!==0))throw Error('Incomplete historical image entry');
    const bytes=Buffer.from(tar.subarray(start,end));if(digest(bytes)!==path.slice(10,74))throw Error('Historical image filename digest differs');files.set(path,bytes);offset=next;
  }
  if(!ended)throw Error('Historical tar terminator missing');return files;
}
export function historicalBoardImages(db:DB,files:Map<string,Buffer>){
  const rows=db.prepare('SELECT digest,size,mime FROM image_assets ORDER BY digest').safeIntegers(true).all() as {digest:string;size:bigint;mime:string}[];
  const wanted=rows.map(row=>'images/'+row.digest.slice(0,2)+'/'+row.digest+'.png');if(JSON.stringify([...files.keys()].sort())!==JSON.stringify(wanted))throw Error('Historical image inventory differs');
  for(const row of rows){const path='images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',bytes=files.get(path);if(!/^[a-f0-9]{64}$/.test(row.digest)||typeof row.size!=='bigint'||row.size<0n||row.mime!=='image/png'||!bytes||BigInt(bytes.length)!==row.size||digest(bytes)!==row.digest)throw Error('Historical image pairing differs');}
  return rows.map(row=>({path:'images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',bytes:Buffer.from(files.get('images/'+row.digest.slice(0,2)+'/'+row.digest+'.png')!)}));
}
export function listRollbackBoardHistories(pkg:RollbackPackage){
  const result:BoardHistoryMetadata[]=[];
  for(const file of pkg.history.sources.captureFiles){const match=/^history\/board\/kanban-([0-9]{8}-[0-9]{6}-[0-9]{6})\.sqlite3$/.exec(file.path);if(!match)continue;const paired=pkg.history.sources.captureFiles.find(row=>row.path===file.path.replace('.sqlite3','.images.tar.gz'));
    result.push({id:'legacy-board-'+match[1],source:'legacy_board',sourceStamp:match[1]!,createdAt:null,schema:null,databaseSha256:digest(file.bytes),assetsSha256:paired?digest(paired.bytes):null});}
  for(const archive of pkg.history.sources.native){const music=pkg.history.projections.find(row=>row.id==='native-'+archive.id);if(!music)throw Error('Missing native history metadata');result.push({id:'native-board-'+archive.id,source:'native_board',sourceStamp:archive.id,createdAt:music.createdAt,schema:music.schema,databaseSha256:digest(archive.files.find(row=>row.path==='state.sqlite3')!.bytes),assetsSha256:digest(archive.manifest)});}
  return result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
/** Open only independently verified package bytes, never a recorded live path.
 * Unsupported historical legacy schemas block this rehearsal; they are not
 * silently migrated or accepted as complete historical-version coverage. */
export function openRollbackBoardHistory(pkg:RollbackPackage,id:string){
  const metadata=listRollbackBoardHistories(pkg).find(row=>row.id===id);if(!metadata)throw Error('Unknown exact board history ID');
  let db:DB|undefined;
  try{
    let images:Map<string,Buffer>;
    if(metadata.source==='legacy_board'){
      const path='history/board/kanban-'+metadata.sourceStamp+'.sqlite3',image=pkg.history.sources.captureFiles.find(row=>row.path===path)!.bytes;
      if(image.length<100||image[18]!==1||image[19]!==1)throw Error('Historical board must be standalone');db=new Database(image);verifyRollbackBoard(db,db);
      const archive=pkg.history.sources.captureFiles.find(row=>row.path===path.replace('.sqlite3','.images.tar.gz'));images=archive?readBoardImageArchive(archive.bytes):new Map();
    }else{
      const archive=pkg.history.sources.native.find(row=>row.id===metadata.sourceStamp)!;const fixed=new Database(pkg.state.checkpointImage);
      try{db=openHistoryNative(fixed,archive,pkg.sourcePins,pkg.state.journal).db;}finally{fixed.close();}
      images=new Map(archive.files.filter(row=>row.path.startsWith('images/')).map(row=>[row.path,Buffer.from(row.bytes)]));
    }
    db.pragma('foreign_keys=ON');historicalBoardImages(db,images);return {db,images,metadata};
  }catch(error){db?.close();throw error;}
}
