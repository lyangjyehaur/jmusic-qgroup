import {musicProfileActiveSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { musicCreatedIds,type DB } from '@qgroup/database';
import { EmptyHttpQuery, AdminMusicCatalog,AdminMusicEntryCommand,AdminMusicEntryResult } from '@qgroup/contracts';
import { DomainError,musicEntryKey,musicText,mergeMusicAliases,mergeMusicSelections,replaceMusicId,musicNameAliases,emptyMusicNames } from '@qgroup/domain';
import { z } from 'zod';
import type { AdminSecurity } from './admin-security';
import { musicCatalog,entryCategories } from './music-catalog';
import { hash } from './security';
import { lockMusicEntry, lockedMusicEntries, removeMusicEntryLock, retainMusicSelectionLocks } from './music-entry-locks';
import { normalizeMusicEntryNames, saveMusicEntryNames, removeMusicEntryNames } from './music-entry-names';

const profiles=(db:DB)=>db.prepare(`SELECT id,revision FROM music_profiles WHERE ${musicProfileActiveSQL('music_profiles')} ORDER BY id`).all() as {id:string;revision:number}[];
export function adminMusicCatalog(db:DB,now:Date){
  const members=profiles(db),created=members.map(p=>({id:p.id,ids:musicCreatedIds(db,p.id)}));
  const creationCounts=new Map<string,number>();for(const p of created)for(const id of p.ids)creationCounts.set(id,(creationCounts.get(id)??0)+1);
  const entries=musicCatalog(db,now).entries.map(entry=>({...entry,creationCount:creationCounts.get(entry.id)??0}));
  // Review binds to both catalog metadata and the member data a destructive action would change.
  const revision=hash(JSON.stringify([
    db.prepare('SELECT e.*,d.category,d.aliases_json,d.created_by,d.created_at_json,d.updated_at_json FROM music_entries e LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.id').all(),
    db.prepare('SELECT * FROM music_selections ORDER BY profile_id,position').all(),members,created,
    db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_names' ORDER BY position").all(),
  ]));
  return AdminMusicCatalog.parse({entries,revision,categories:[...new Set(['领域',...entryCategories,...entries.map(e=>e.category)])]});
}
function checkName(input:string,entries:ReturnType<typeof adminMusicCatalog>['entries'],id?:string){
  const name=musicText(input),key=musicEntryKey(name);
  if(!key||Array.from(name).length>24||/[\x00-\x1f\x7f]/.test(name))throw withApiError(new DomainError('ENTRY_NAME','詞條名稱須為 1–24 字，不可包含控制字元'));
  const duplicate=entries.find(e=>e.id!==id&&[e.name,...e.aliases].some(alias=>musicEntryKey(alias)===key));
  if(duplicate)throw new DomainError('ENTRY_EXISTS','已有「'+duplicate.name+'」詞條，請編輯既有詞條或合併',409);
  return name;
}
function replaceReferences(db:DB,source:string,target:string|undefined,stamp:string){
  let changed=0;
  // Capture native author-derived creation lists before the source term is removed.
  for(const p of profiles(db)){
    const old=db.prepare('SELECT entry_id AS entryId,level FROM music_selections WHERE profile_id=? ORDER BY position').all(p.id) as {entryId:string;level:number}[];
    const created=musicCreatedIds(db,p.id),selected=old.some(item=>item.entryId===source),owns=created.includes(source);
    if(!selected&&!owns)continue;
    if(selected){
      retainMusicSelectionLocks(db,p.id);
      const next=mergeMusicSelections(old,source,target);
      db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(p.id);
      next.forEach((item,index)=>db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(p.id,item.entryId,item.level,index));
      retainMusicSelectionLocks(db,p.id);
    }
    if(owns){
      const next=replaceMusicId(created,source,target);
      db.prepare('DELETE FROM music_entry_creations WHERE profile_id=?').run(p.id);
      next.forEach((entryId,index)=>db.prepare('INSERT INTO music_entry_creations VALUES(?,?,?)').run(p.id,entryId,index));
      const legacy=db.prepare('SELECT created_entries_json FROM music_legacy_profiles WHERE profile_id=?').get(p.id) as {created_entries_json:string}|undefined;
      if(legacy){const original=z.array(z.string()).parse(JSON.parse(legacy.created_entries_json));db.prepare('UPDATE music_legacy_profiles SET created_entries_json=? WHERE profile_id=?').run(JSON.stringify(replaceMusicId(original,source,target)),p.id);}
    }
    db.prepare('UPDATE music_profiles SET revision=revision+1,updated_at=? WHERE id=?').run(stamp,p.id);changed++;
  }
  return changed;
}
export function registerAdminMusicCatalog(app:FastifyInstance,db:DB,admin:AdminSecurity,now:()=>Date){
  app.get('/api/v2/admin/music-entries',{exposeHeadRoute:false},async request=>db.transaction(()=>{
    admin.authority(request);EmptyHttpQuery.parse(request.query);return adminMusicCatalog(db,now());
  })());
  app.post('/api/v2/admin/music-entries',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async request=>db.transaction(()=>{
    const access=admin.authority(request,true),input=AdminMusicEntryCommand.parse(request.body),key=z.string().uuid().parse(request.headers['idempotency-key']);
    const signature=hash('v2:admin-music-entry:'+JSON.stringify(input));
    const prior=db.prepare('SELECT signature,response_json FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope,key) as {signature:string;response_json:string}|undefined;
    if(prior){if(prior.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於其他內容',409));return JSON.parse(prior.response_json);}
    const current=adminMusicCatalog(db,now());
    if(input.revision!==current.revision)throw withApiError(new DomainError('CATALOG_CHANGED','詞庫或會員選擇已有更新，請重新核對影響範圍後確認',409));
    const before=input.command==='create'?undefined:current.entries.find(e=>e.id===input.id);
    if(input.command!=='create'&&!before)throw withApiError(new DomainError('ENTRY_NOT_FOUND','詞條不存在或已刪除',404));
    admin.preserve(request);
    const stamp=now().toISOString(),seconds=JSON.stringify(Math.trunc(now().getTime()/1000));
    const id=before?.id??'e_'+randomUUID().replaceAll('-','');let targetId='',affectedProfiles=0;
    if(input.command==='create'||input.command==='update'){
      const name=checkName(input.name,current.entries,before?.id);
      const names=normalizeMusicEntryNames(input.names,before,name,current.entries,before?.id),aliases=musicNameAliases(name,names);
      const category=before&&input.category===before.category?before.category:current.categories.includes(input.category.trim())?input.category.trim():'其他';
      if(input.command==='create'){
        db.prepare('INSERT INTO music_entries VALUES(?,?,?)').run(id,name,input.kind);
        db.prepare("INSERT INTO music_entry_details VALUES(?,?,?,'admin',?,'null')").run(id,category,JSON.stringify(aliases),seconds);
      }else{
        db.prepare('UPDATE music_entries SET name=?,kind=? WHERE id=?').run(name,input.kind,id);
        db.prepare("INSERT INTO music_entry_details VALUES(?,?,?,'',?,?) ON CONFLICT(entry_id) DO UPDATE SET category=excluded.category,aliases_json=excluded.aliases_json,updated_at_json=excluded.updated_at_json").run(id,category,JSON.stringify(aliases),JSON.stringify(before!.createdAt??0),seconds);
      }
      if(input.names||before?.names)saveMusicEntryNames(db,id,names);
    }else{
      const target=input.command==='merge'?current.entries.find(e=>e.id===input.toId):undefined;
      if(input.command==='merge'){
        if(input.id===input.toId)throw withApiError(new DomainError('MERGE_SELF','不能合併到同一詞條'));
        if(!target)throw withApiError(new DomainError('ENTRY_NOT_FOUND','目標詞條不存在或已刪除',404));
        targetId=target.id;
        const mergedAliases=mergeMusicAliases(target,before!),aliases=JSON.stringify(mergedAliases);
        if(target.names||before!.names){const targetNames=target.names??emptyMusicNames();saveMusicEntryNames(db,target.id,{...targetNames,aliases:mergedAliases.filter(alias=>![targetNames.zhHant,targetNames.zhHans,targetNames.english,targetNames.reading,targetNames.romaji].some(label=>musicEntryKey(label)===musicEntryKey(alias)))});}
        db.prepare("INSERT INTO music_entry_details VALUES(?,?,?,'',?,'null') ON CONFLICT(entry_id) DO UPDATE SET aliases_json=excluded.aliases_json").run(target.id,target.category,aliases,JSON.stringify(target.createdAt??0));
      }
      if(target && lockedMusicEntries(db).has(id)) lockMusicEntry(db,target.id);
      affectedProfiles=replaceReferences(db,id,target?.id,stamp);
      removeMusicEntryLock(db,id);
      removeMusicEntryNames(db,id);
      db.prepare('DELETE FROM music_entry_details WHERE entry_id=?').run(id);
      db.prepare('DELETE FROM music_entries WHERE id=?').run(id);
      db.prepare("UPDATE migration_map SET status=?,target_id=? WHERE source='music' AND entity_type='entry' AND target_id=?").run(target?'merged':'deleted',targetId||id,id);
    }
    const result=AdminMusicEntryResult.parse({id,command:input.command,targetId,affectedProfiles});
    db.prepare('INSERT INTO music_catalog_actions(actor_id,actor_ref,command,entry_id,target_id,affected_profiles,created_at) VALUES(?,?,?,?,?,?,?)').run(access.userId,access.actorRef,input.command,id,targetId,affectedProfiles,stamp);
    db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope,key,signature,JSON.stringify(result),stamp);return result;
  }).immediate());
}
