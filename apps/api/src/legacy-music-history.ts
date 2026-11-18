import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { digest, musicErasures, parseJson, readIdentity } from '../../../tools/migration/music-codec';
import { decodeErasureJournal, erasureRequestId, type StoredIntent } from './erasure-journal';
import { exportLegacyMusic } from './legacy-music-export';

export const LegacyHistoryConfig = z.object({ root:z.string().min(1), manifestSha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Config = z.infer<typeof LegacyHistoryConfig>;
const File = z.object({path:z.string().min(1),size:z.number().int().nonnegative().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Manifest = z.object({version:z.literal(1),files:z.array(File),sourceDigest:z.string(),releaseEligible:z.literal(false)}).passthrough();
const stampPattern = '[0-9]{8}-[0-9]{6}';
const pairPattern = new RegExp('^history/music/paired-backups/('+stampPattern+')/(?:data\\.json|identity\\.sqlite3|walls/(?:manifest\\.json|[^/]+\\.(?:png|jpg|jpeg|webp)))$');
const jsonPattern = new RegExp('^history/music/backups/data-('+stampPattern+')\\.json$');
function directory(path:string) { const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe history directory'); }
function read(path:string,limit=512*1024*1024) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const info=fstatSync(fd);if(!info.isFile()||info.size>limit)throw Error('Invalid history file');return readFileSync(fd);}finally{closeSync(fd);}
}
const decode=(raw:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
/** Explicit immutable capture mount + externally pinned manifest. No retention,
 * source database opening, credentials import, activation or bot operations. */
export function createLegacyMusicHistory(db:DB,input:Config) {
  const config=LegacyHistoryConfig.parse(input),root=resolve(config.root);
  if(config.root!==root)throw Error('History root must be an absolute canonical path');
  function catalog() {
    directory(root);if(realpathSync(root)!==root)throw Error('History path must be canonical');
    const encoded=read(join(root,'capture-manifest.json'),16*1024*1024);
    if(digest(encoded)!==config.manifestSha256)throw Error('History manifest pin differs');
    const manifest=Manifest.parse(parseJson(decode(encoded)));
    if(digest(JSON.stringify(manifest.files))!==manifest.sourceDigest)throw Error('Capture fingerprint differs');
    const all=new Map<string,z.infer<typeof File>>();
    for(const file of manifest.files){if(file.path.startsWith('/')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||file.path.includes('\\')||all.has(file.path))throw Error('Unsafe capture path');all.set(file.path,file);}
    const current=manifest.files.filter(file=>file.path.startsWith('current/')).map(file=>({path:file.path.slice(8),digest:file.sha256,size:file.size})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const fingerprint=digest(JSON.stringify(current));
    const run=db.prepare('SELECT manifest_json FROM migration_runs WHERE source_digest=?').get(fingerprint) as {manifest_json:string}|undefined;
    if(!run||run.manifest_json!==JSON.stringify(current))throw Error('History does not belong to this imported source');
    const verified=(path:string)=>{
      const file=all.get(path);if(!file)throw Error('Missing captured history file');
      for(let parent=dirname(path);parent!=='.';parent=dirname(parent))directory(join(root,parent));
      const bytes=read(join(root,path));if(bytes.length!==file.size||digest(bytes)!==file.sha256)throw Error('Captured history checksum differs');return bytes;
    };
    const erased=new Set(musicErasures(decode(verified('current/music/erasures.jsonl'))).keys());
    const capturedIntents=decodeErasureJournal(decode(verified('current/board.erasures.jsonl')));
    const groups=new Map<string,{id:string;source:'legacy_pair'|'legacy_json';sourceStamp:string;createdAt:null;schema:null;size:number;paths:string[]}>();
    for(const file of manifest.files.filter(file=>file.path.startsWith('history/music/'))){
      const pair=pairPattern.exec(file.path),json=jsonPattern.exec(file.path),stamp=pair?.[1]??json?.[1];
      if(!stamp)throw Error('Unclassified music history file');
      const source=pair?'legacy_pair':'legacy_json',id='legacy-'+(pair?'pair':'json')+'-'+stamp;
      const group=groups.get(id)??{id,source,sourceStamp:stamp,createdAt:null,schema:null,size:0,paths:[]};
      group.paths.push(file.path);group.size+=file.size;if(!Number.isSafeInteger(group.size))throw Error('History size exceeds safe integer');groups.set(id,group);
    }
    // Check real inventory, including empty/unclassified directories, without
    // following links. Missing/added original files cannot silently disappear.
    const expected=new Set([...groups.values()].flatMap(group=>group.paths));
    const folders=new Set(['history/music','history/music/paired-backups','history/music/backups']);for(const path of expected)for(let p=dirname(path);p!=='history';p=dirname(p))folders.add(p);
    const seen=new Set<string>();
    function visit(path:string){directory(join(root,path));for(const item of readdirSync(join(root,path),{withFileTypes:true})){const child=path+'/'+item.name;if(item.isSymbolicLink())throw Error('Unsafe historical inventory');if(item.isDirectory()&&folders.has(child))visit(child);else if(item.isFile()&&expected.has(child))seen.add(child);else throw Error('Unclassified historical inventory');}}
    let historyExists=false;
    try{lstatSync(join(root,'history/music'));historyExists=true;}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
    if(historyExists){directory(join(root,'history'));visit('history/music');}
    if(seen.size!==expected.size)throw Error('Missing history inventory');
    for(const group of groups.values()){
      const base='history/music/paired-backups/'+group.sourceStamp;
      if(group.source==='legacy_pair'&&(!group.paths.includes(base+'/data.json')||!group.paths.includes(base+'/identity.sqlite3')))throw Error('Incomplete historical pair');
    }
    return {groups,verified,erased,capturedIntents,assertPinned(){if(digest(read(join(root,'capture-manifest.json'),16*1024*1024))!==config.manifestSha256)throw Error('History manifest changed');}};
  }
  return {
    list(){return [...catalog().groups.values()].sort((a,b)=>b.sourceStamp.localeCompare(a.sourceStamp)||a.id.localeCompare(b.id)).map(({paths,...item})=>item);},
    export(id:string,intents:StoredIntent[]){
      const source=catalog(),group=source.groups.get(id);if(!group)throw Error('Missing legacy history');
      const latest=new Map(intents.map(entry=>[erasureRequestId(entry),JSON.stringify(entry)]));
      if(source.capturedIntents.some(entry=>latest.get(erasureRequestId(entry))!==JSON.stringify(entry)))throw Error('Captured erasure intent was lost');
      let data:Buffer|undefined;
      for(const path of group.paths){
        const bytes=source.verified(path);
        if(path.endsWith('/identity.sqlite3')){
          const copy=new Database(bytes);try{if(copy.pragma('integrity_check',{simple:true})!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)throw Error('Historical identity integrity failed');readIdentity(copy);}finally{copy.close();}
        }else if(path.endsWith('/data.json')||group.source==='legacy_json')data=bytes;
        else if(path.endsWith('/walls/manifest.json')){
          const walls=z.object({items:z.array(z.object({src:z.string()}).passthrough())}).passthrough().parse(parseJson(decode(bytes)));
          for(const item of walls.items){if(!/^\/walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(item.src)||item.src.includes('..'))throw Error('Invalid historical wall reference');source.verified('history/music/paired-backups/'+group.sourceStamp+item.src);}
        }
      }
      const result=exportLegacyMusic(parseJson(decode(data!)),db,intents,source.erased);
      for(const path of group.paths)source.verified(path);source.assertPinned();return result;
    },
  };
}
export type LegacyMusicHistory=ReturnType<typeof createLegacyMusicHistory>;
