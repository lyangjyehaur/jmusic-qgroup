import {cloneJson,stringifyJson} from '../../../tools/migration/music-codec';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {legacyHistoryFixture} from './legacy-history-fixture';
import {hash,accountScope,type Device} from '../src/security';
import {createMusicClaims} from '../src/music-claim';
import {profileId} from '../../../tools/migration/music-codec';
import {erasureJournal} from '../src/erasure-journal';
import {projectRollbackState} from '../../../tools/migration/rollback-state';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {forwardHash} from '../../../tools/migration/forward-board-storage';
import {reconstructForwardBusiness} from '../../../tools/migration/forward-business-reconstruction';
import type {ForwardMusicInput} from '../../../tools/migration/forward-music-sources';
import type {ForwardProofInput} from '../../../tools/migration/forward-proof-source';

export const proofStamp='2026-11-20T01:00:00.000Z',proofReconstructedAt='2026-11-20T01:01:00.000Z',proofReconciledAt='2026-11-20T01:02:00.000Z';
export const proofPin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
/** Original native use cases with a synthetic, explicitly consumed QQ proof.
 * No provider calls, worker, credentials or production files. */
export async function forwardProofFixture(stage:'none'|'pending'|'authorized'|'completed'='pending'){
  const f=await legacyHistoryFixture(),db=f.db;let board:Database.Database|undefined,identity:Database.Database|undefined;
  try{
    const id=profileId('10003'),token=hash('synthetic-proof-claimant'),device:Extract<Device,{kind:'member'}>={kind:'member',id:'claimant',nickname:'合成找回者',tokenHash:token,scope:accountScope('claimant')};
    for(const user of ['claimant','claimant2']){db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user,hash('synthetic-'+user),user,proofStamp);db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('synthetic-proof-'+user),user,proofStamp);}
    db.prepare('INSERT INTO music_profiles VALUES(?,NULL,0,?,NULL)').run(id,proofStamp);
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(id,'10003','合成找回成分',1,hash('jpm-pin|123456'),'10003','{}','[]','unlinked');
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'',0,'',0,0,?)").run(id,'合成找回成分',proofStamp);db.prepare("INSERT INTO music_profile_contacts VALUES(?,?,'legacy',0,?)").run(id,'10003',proofStamp);
    const claims=createMusicClaims(db,()=>new Date(proofStamp));let claimId='';
    if(stage!=='none'){
      claimId=randomUUID();claims.start(device,{requestId:claimId,legacyQQ:'10003',pin:'123456',consent:true});
      if(stage!=='pending'){
        const attempt='synthetic-completed-attempt';db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid) VALUES(?,?,'claimant','qq','synthetic-app','bind','used',?,?,'synthetic-subject')").run(attempt,token,'2026-11-20T01:10:00.000Z',proofStamp);
        db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-app','synthetic-subject','claimant','合成授權',?)").run(proofStamp);claims.attach(device,claimId,attempt,'bind');const row=db.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(claimId) as Parameters<typeof claims.authorize>[0];claims.authorize(row,token,'claimant','synthetic-app','synthetic-subject');
        if(stage==='completed')db.transaction(()=>claims.finish(device,claimId)).immediate();
      }
    }
    for(const [user,profile] of [['alice',profileId('10001')],['bob',profileId('10002')],...(stage==='completed'?[['claimant',id]]:[])] as [string,string][]){db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(user,'original-'+user,'original-signature-'+user,JSON.stringify({original:user,private:'original-native-result'}),'original-operation-time');db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(user,'original-'+user,profile);}
    const journal=erasureJournal(db),base=projectRollbackState(db,journal);board=new Database(base.boardImage);identity=new Database(base.identityImage);const old=cloneJson(base.music.data),oldBoard=board,oldIdentity=identity;
    const input=():ForwardMusicInput=>({checkpoint:proofPin(base.checkpointImage),baselineBoard:proofPin(base.boardImage),baselineJournal:proofPin(Buffer.from(base.journal.map(row=>JSON.stringify(row)+'\n').join(''))),nativeImage:proofPin(captureRollbackCheckpoint(db,journal).image),nativeJournal:proofPin(Buffer.from(journal.read().map(row=>JSON.stringify(row)+'\n').join(''))),oldBoard:proofPin(oldBoard.serialize()),baselineMusic:proofPin(Buffer.from(stringifyJson({...base.music,identityAuditMappings:base.identityAuditMappings}))),baselineIdentity:proofPin(base.identityImage),oldMusic:proofPin(Buffer.from(stringifyJson(old))),oldIdentity:proofPin(oldIdentity.serialize())});
    const proofInput=():ForwardProofInput=>{const sources=input(),business=reconstructForwardBusiness(sources,proofReconstructedAt);return {sources,businessImage:proofPin(business.nativeImage),musicSources:proofPin(Buffer.from(stringifyJson(business.musicSources))),identitySources:proofPin(business.identitySources),reconstructedAt:proofReconstructedAt,reconciledAt:proofReconciledAt};};
    return {db,oldBoard,oldIdentity,old,base,id,claimId,device,input,proofInput,captureConfig:f.config,captureRoot:f.capture,fixtureRoot:f.root,close(){oldIdentity.close();oldBoard.close();f.close();}};
  }catch(error){identity?.close();board?.close();f.close();throw error;}
}
