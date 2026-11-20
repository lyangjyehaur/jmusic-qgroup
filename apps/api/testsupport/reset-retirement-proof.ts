import {randomUUID} from 'node:crypto';
import type {DB} from '@qgroup/database';
import {createMusicClaims} from '../src/music-claim';
import {accountScope,hash,type Device} from '../src/security';
import {profileId} from '../../../tools/migration/music-codec';

export type ResetRetirementProofStage='pending'|'authorized'|'completed';
/** Genuine native claim transitions with locally consumed synthetic QQ proof,
 * recorded before the original checkpoint and reset source vault are captured. */
export function prepareResetRetirementProof(db:DB,stage:ResetRetirementProofStage){
  const stamp='2026-11-20T00:00:00.000Z',user='reset-claimant',token=hash('synthetic-reset-claimant'),device:Extract<Device,{kind:'member'}>={kind:'member',id:user,nickname:'合成認領帳號',tokenHash:token,scope:accountScope(user)},id=profileId('10001');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,hash('synthetic-reset-claimant-password'),device.nickname,stamp);db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(token,user,stamp);
  const claims=createMusicClaims(db,()=>new Date(stamp)),claimId=randomUUID();claims.start(device,{requestId:claimId,legacyQQ:'10001',pin:'123456',consent:true});
  const attemptId='synthetic-reset-claim-attempt';
  if(stage!=='pending'){
    db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid) VALUES(?,?,'reset-claimant','qq','synthetic-reset-app','bind','used',?,?,'synthetic-reset-subject')").run(attemptId,token,'2026-11-20T00:10:00.000Z',stamp);
    db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-reset-app','synthetic-reset-subject',?,'合成授權',?)").run(user,stamp);claims.attach(device,claimId,attemptId,'bind');
    const row=db.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(claimId) as Parameters<typeof claims.authorize>[0];claims.authorize(row,token,user,'synthetic-reset-app','synthetic-reset-subject');
    if(stage==='completed'){
      db.transaction(()=>claims.finish(device,claimId)).immediate();
      db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(user,'original-retired-save','original-retired-signature',JSON.stringify({profileId:id,private:'synthetic-original-response'}),stamp);
      db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(user,'original-retired-save',id);
    }
  }
  return {id,claimId,attemptId:stage==='pending'?null:attemptId,device,stage,originalStatus:claims.status(device,claimId),originalEpoch:(db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(user) as {epoch:number}|undefined)?.epoch??0};
}
