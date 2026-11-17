import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { AdminMusicErasureInput,AdminMusicErasurePreview,AdminMusicErasureResult,ErasureProof } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import type { AdminSecurity } from './admin-security';
import type { PrivacyService } from './privacy';
import { adminMusicProfile,musicAdminProfileId } from './admin-music';
import { hash } from './security';

export function musicErasureScope(db:DB,id?:string){
  const profile=id?adminMusicProfile(db,id):null;
  const profiles=db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL'+(id?' AND id=?':'')+' ORDER BY id').all(...id?[id]:[]) as {id:string;userId:string|null}[];
  const entries=id?[]:(db.prepare('SELECT id FROM music_entries ORDER BY id').all() as {id:string}[]).map(row=>row.id);
  // Bind review to every affected record, including PIN, identity proofs and draft revisions.
  const tables=['music_profiles','music_legacy_profiles','music_profile_fields','music_profile_contacts','music_selections','music_entry_details','music_entry_creations','music_claim_intents','music_legacy_identity','music_shouts','music_shout_authors','music_entries','music_documents'];
  const revision=hash(JSON.stringify([id??null,...tables.map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())]));
  const count=(table:string)=> (db.prepare('SELECT count(*) n FROM '+table+(id?' WHERE profile_id=?':'')).get(...id?[id]:[]) as {n:number}).n;
  const shouts=(db.prepare('SELECT count(*) n FROM music_shouts'+(id?' WHERE profile_id=?':'')).get(...id?[id]:[]) as {n:number}).n;
  const preview=AdminMusicErasurePreview.parse({command:id?'delete_profile':'reset_music',revision,profile:profile?{id:profile.id,name:profile.name,ownerId:profile.owner?.id??null}:null,profiles:profiles.length,entries:id?(db.prepare("SELECT count(*) n FROM music_entry_details WHERE created_by=? OR created_by=?").get(id,profile!.legacyKey||id) as {n:number}).n:entries.length,selections:count('music_selections'),shouts});
  return{preview,profiles,entries};
}
export function registerAdminMusicErasure(app:FastifyInstance,db:DB,admin:AdminSecurity,now:()=>Date,privacy:PrivacyService){
  for(const reset of [false,true]){
    const path=reset?'/api/v2/admin/music-reset':'/api/v2/admin/music/:id/erase';
    app.get(path,{exposeHeadRoute:false},async request=>db.transaction(()=>{
      admin.authority(request);z.object({}).strict().parse(request.query);
      return musicErasureScope(db,reset?undefined:musicAdminProfileId(request.params)).preview;
    })());
    app.post(path,{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async request=>{
      const input=AdminMusicErasureInput.parse(request.body);
      db.transaction(()=>{
        const access=admin.authority(request,true),id=reset?undefined:musicAdminProfileId(request.params);
        if(input.confirm!==(reset?'RESET':'DELETE'))throw new DomainError('ERASURE_CONFIRM','請輸入正確的刪除確認字詞');
        const signature=hash('v2:admin-music-erasure:'+access.actorRef+':'+(id??'reset')+':'+JSON.stringify(input));
        const prior=db.prepare('SELECT signature FROM privacy_receipts WHERE request_id=?').get(input.requestId) as {signature:string}|undefined;
        if(prior){if(prior.signature!==signature)throw new DomainError('REQUEST_CONFLICT','這個操作編號已用於其他內容',409);return;}
        const scope=musicErasureScope(db,id);
        if(scope.preview.revision!==input.revision)throw new DomainError('MUSIC_ERASURE_CHANGED','成分、詞庫或相關資料已有變更，請重新核對刪除範圍',409);
        if(!scope.profiles.length&&!scope.entries.length)throw new DomainError('NO_MUSIC_DATA','目前沒有可重置的成分或詞條',409);
        admin.preserve(request);
        privacy.submit({version:2,kind:'admin_music',command:reset?'reset_music':'delete_profile',actorRef:access.actorRef,profiles:scope.profiles,entries:scope.entries,requestId:input.requestId,secretHash:hash(input.secret),signature,createdAt:now().toISOString()});
      }).immediate();
      privacy.guard();return AdminMusicErasureResult.parse(privacy.receipt(input.requestId,input.secret));
    });
  }
  app.post('/api/v2/admin/music-erasure/receipt',async request=>{
    admin.authority(request,true);const input=ErasureProof.parse(request.body);
    const result=privacy.receipt(input.requestId,input.secret);
    if(result.target!=='admin_music')throw new DomainError('RECEIPT_NOT_FOUND','尚未找到此管理操作的結果',404);
    return AdminMusicErasureResult.parse(result);
  });
}
