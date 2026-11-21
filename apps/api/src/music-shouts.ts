import { Identifier128Path } from '@qgroup/contracts/http-paths';
import {musicProfileActiveSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { removeMusicShout, type DB } from '@qgroup/database';
import { AdminMusicShoutsQuery,EmptyHttpQuery,MusicShoutsQuery, MusicShout, MusicShouts, PublishMusicShout, AdminMusicShouts, DeleteMusicShout } from '@qgroup/contracts';
import { DomainError, shoutTTL, shoutCooldown, shoutHistoryMax, shoutText } from '@qgroup/domain';
import { z } from 'zod';
import { getProfile } from './repositories';
import { musicNameJoins, musicNameSQL } from './music-fields';
import { hash, type Security } from './security';
import type { AdminSecurity } from './admin-security';
type Row={id:string;profile_id:string|null;legacy_key:string;name:string;body:string;created_at:number;archived_at:number|null;ordinal:number};

function ordinal(db:DB){return (db.prepare('SELECT COALESCE(max(ordinal),-1)+1 n FROM music_shouts').get() as {n:number}).n;}
export function archiveMusicShouts(db:DB,time:number,replaceProfile?:string){
  const expired=db.prepare('SELECT id FROM music_shouts WHERE archived_at IS NULL AND (created_at<=? OR profile_id=?) ORDER BY ordinal').all(time-shoutTTL,replaceProfile??null) as {id:string}[];
  for(const row of expired)db.prepare('UPDATE music_shouts SET archived_at=?,ordinal=? WHERE id=?').run(Math.trunc(time),ordinal(db),row.id);
  // Source bounds its history when something is moved; preserve an untouched imported history on reads.
  if(expired.length)for(const row of db.prepare('SELECT id FROM music_shouts WHERE archived_at IS NOT NULL ORDER BY created_at DESC,ordinal LIMIT -1 OFFSET ?').all(shoutHistoryMax) as {id:string}[])removeMusicShout(db,row.id,'pruned');
}
function view(db:DB,row:Row,viewer=''){
  const author=row.profile_id?db.prepare(`SELECT p.id,${musicNameSQL} name,COALESCE(c.contact_qq,'') contactQQ,COALESCE(c.source,'') contactSource FROM music_profiles p ${musicNameJoins} LEFT JOIN music_profile_contacts c ON c.profile_id=p.id WHERE p.id=? AND ${musicProfileActiveSQL('p')}`).get(row.profile_id) as {id:string;name:string;contactQQ:string;contactSource:'legacy'|'self_reported'|''}|undefined:undefined;
  return MusicShout.parse({id:row.id,text:row.body,name:author?.name||row.name,author:author??null,createdAt:Math.trunc(row.created_at),expiresAt:Math.trunc(row.created_at)+shoutTTL,archivedAt:row.archived_at===null?null:Math.trunc(row.archived_at),mine:!!viewer&&row.profile_id===viewer});
}
function mine(db:DB,user:string){const profile=getProfile(db,user);if(!profile)throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED','請先保存成分，再使用找搭子',403));return profile;}
const currentShoutSQL=`NOT EXISTS(SELECT 1 FROM music_profiles p WHERE p.id=s.profile_id AND NOT (${musicProfileActiveSQL('p')}))`;
function listing(db:DB,viewer:string,history:boolean,offset:number,limit:number,time:number){
  const where=history?'s.archived_at IS NOT NULL':`s.archived_at IS NULL AND ${currentShoutSQL}`,myRow=db.prepare('SELECT * FROM music_shouts WHERE profile_id=? AND archived_at IS NULL ORDER BY ordinal LIMIT 1').get(viewer) as Row|undefined;
  return MusicShouts.parse({items:(db.prepare('SELECT s.* FROM music_shouts s WHERE '+where+' ORDER BY created_at DESC,ordinal LIMIT ? OFFSET ?').all(limit,offset) as Row[]).map(row=>view(db,row,viewer)),total:(db.prepare('SELECT count(*) n FROM music_shouts s WHERE '+where).get() as {n:number}).n,offset,limit,now:Math.trunc(time),mine:myRow?view(db,myRow,viewer):null,nextAllowedAt:myRow?Math.trunc(myRow.created_at+shoutCooldown):0});
}
export function registerMusicShouts(app:FastifyInstance,db:DB,security:Security,admin:AdminSecurity,now:()=>Date){
  for(const history of [false,true])app.get('/api/v2/music/shouts'+(history?'/history':''),{exposeHeadRoute:false},async request=>db.transaction(()=>{
    const member=security.scopedMember(request),profile=mine(db,member.id),page=MusicShoutsQuery.parse(request.query),time=now().getTime()/1000;
    archiveMusicShouts(db,time);return listing(db,profile.id,history,page.offset,page.limit,time);
  }).immediate());
  app.get('/api/v2/music/shouts/:id',{exposeHeadRoute:false},async request=>db.transaction(()=>{
    const profile=mine(db,security.scopedMember(request).id),{id}=Identifier128Path.parse(request.params);EmptyHttpQuery.parse(request.query);
    archiveMusicShouts(db,now().getTime()/1000);const row=db.prepare(`SELECT s.* FROM music_shouts s WHERE s.id=? AND (s.archived_at IS NOT NULL OR ${currentShoutSQL})`).get(id) as Row|undefined;
    if(!row)throw withApiError(new DomainError('SHOUT_NOT_FOUND','這則找搭子內容不存在或已移除',404));return view(db,row,profile.id);
  }).immediate());
  app.post('/api/v2/me/music/shouts',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>db.transaction(()=>{
    const member=security.memberWrite(request),input=PublishMusicShout.parse(request.body),key=z.string().uuid().parse(request.headers['idempotency-key']),signature=hash('v2:publish-shout:'+JSON.stringify(input));
    const prior=db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(member.id,key) as {signature:string;response_json:string;response_status:number}|undefined;
    if(prior){if(prior.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於另一份內容',409));reply.code(prior.response_status);return JSON.parse(prior.response_json);}
    const profile=mine(db,member.id),epoch=(db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(member.id) as {epoch:number}|undefined)?.epoch??0;
    if(profile.id!==input.profileId||epoch!==input.musicEpoch)throw withApiError(new DomainError('PROFILE_ERASED','成分已刪除、重建或移交，請核對目前成分',409));
    const text=shoutText(input.text),time=now().getTime()/1000,myRow=db.prepare('SELECT created_at FROM music_shouts WHERE profile_id=? AND archived_at IS NULL ORDER BY ordinal LIMIT 1').get(profile.id) as {created_at:number}|undefined;
    if(myRow&&time<myRow.created_at+shoutCooldown)throw withApiError(new DomainError('SHOUT_COOLDOWN','24 小時內只能發布一則；請核對下次可發布時間',429));
    archiveMusicShouts(db,time,profile.id);const id='s_'+randomUUID().replaceAll('-',''),name=(db.prepare(`SELECT ${musicNameSQL} name FROM music_profiles p ${musicNameJoins} WHERE p.id=?`).get(profile.id) as {name:string}).name;
    db.prepare('INSERT INTO music_shouts VALUES(?,?,?, ?,?,?,NULL,?)').run(id,profile.id,'',name,text,Math.trunc(time),ordinal(db));
    db.prepare('INSERT INTO music_shout_authors VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET last_post_at=excluded.last_post_at').run(profile.id,Math.trunc(time));
    const result={id};db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(member.id,key,signature,JSON.stringify(result),now().toISOString());
    db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(member.id,key,profile.id);return result;
  }).immediate());
  app.get('/api/v2/admin/shouts',{exposeHeadRoute:false},async request=>db.transaction(()=>{
    admin.authority(request);const {period,...page}=AdminMusicShoutsQuery.parse(request.query),time=now().getTime()/1000;archiveMusicShouts(db,time);
    const result=listing(db,'',period==='history',page.offset,page.limit,time);
    return AdminMusicShouts.parse({...result,items:result.items.map(item=>({...item,revision:hash(JSON.stringify(db.prepare('SELECT * FROM music_shouts WHERE id=?').get(item.id)))}))});
  }).immediate());
  app.post('/api/v2/admin/shouts/:id/delete',async request=>db.transaction(()=>{
    const access=admin.authority(request,true),{id}=Identifier128Path.parse(request.params),input=DeleteMusicShout.parse(request.body),key=z.string().uuid().parse(request.headers['idempotency-key']),signature=hash('v2:delete-shout:'+id+':'+JSON.stringify(input));
    const prior=db.prepare('SELECT signature FROM auth_requests WHERE token_hash=? AND request_key=?').get(access.receiptScope,key) as {signature:string}|undefined;
    if(prior){if(prior.signature!==signature)throw withApiError(new DomainError('REQUEST_CONFLICT','這個操作編號已用於其他內容',409));return{ok:true};}
    const row=db.prepare('SELECT * FROM music_shouts WHERE id=?').get(id);if(!row)throw withApiError(new DomainError('SHOUT_NOT_FOUND','這則找搭子內容不存在或已移除',404));
    if(hash(JSON.stringify(row))!==input.revision)throw withApiError(new DomainError('SHOUT_CHANGED','內容狀態已變更，請重新讀取後確認',409));
    admin.preserve(request);
    removeMusicShout(db,id,'deleted');db.prepare('INSERT INTO music_shout_deletions(shout_id,actor_ref,created_at) VALUES(?,?,?)').run(id,access.actorRef,now().toISOString());
    db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(access.receiptScope,key,signature,'{"ok":true}',now().toISOString());return{ok:true};
  }).immediate());
  app.get('/api/v2/admin/shouts/:id',{exposeHeadRoute:false},async request=>db.transaction(()=>{
    admin.authority(request);EmptyHttpQuery.parse(request.query);const {id}=Identifier128Path.parse(request.params);
    archiveMusicShouts(db,now().getTime()/1000);const row=db.prepare('SELECT * FROM music_shouts WHERE id=?').get(id) as Row|undefined;
    if(!row)throw withApiError(new DomainError('SHOUT_NOT_FOUND','這則找搭子內容不存在或已移除',404));return{...view(db,row),revision:hash(JSON.stringify(row))};
  }).immediate());
}
