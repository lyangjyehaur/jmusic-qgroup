import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {assertDatabaseUsable} from '@qgroup/database';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {reconstructForwardRetiredResetRecovery,verifyForwardRetiredResetRecovery} from '../../../tools/migration/forward-retired-reset-recovery';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {createMusicClaims} from './music-claim';
import {getProfile} from './repositories';

it.each(['pending','authorized','completed'] as const)('preserves genuine original %s claim evidence through retirement and full reset recovery without restoring access',async stage=>{
  const s=await legacyResetRecoveryFixture(true,false,'persisted-only',stage);let db:Database.Database|undefined,retired:Database.Database|undefined,retained:Database.Database|undefined;
  try{
    const original=s.claim!;expect(original.originalStatus.status).toBe(stage);
    const bundle=reconstructForwardRetiredResetRecovery(s.recoveryInput);db=new Database(bundle.rebased.nativeImage);retired=new Database(bundle.retirement.native.nativeImage);retained=new Database(bundle.proof.retainedBusinessImage);
    expect(verifyForwardRetiredResetRecovery(s.recoveryInput,bundle)).toMatchObject({allCandidateRowsVerified:true,retiredBaselineAndNativeVerified:true,releaseEligible:false});
    expect(retired.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId)).toEqual(s.native.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId));
    expect(retained.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId)).toEqual(s.native.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId));
    expect(bundle.proof.report.claims).toEqual(expect.arrayContaining([expect.objectContaining({id:original.claimId,action:stage==='completed'?'detach_completed':'retire_pending',reasons:expect.arrayContaining(['profile_unavailable'])})]));
    const row=db.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId) as Record<string,unknown>|undefined;
    if(stage==='completed'){
      expect(row).toMatchObject({id:original.claimId,stage:'completed',target_user_id:original.device.id,attempt_id:original.attemptId,app_id:'synthetic-reset-app',subject:'synthetic-reset-subject'});expect(row!.current_token_hash).not.toBe(original.device.tokenHash);
      expect(row).toEqual({...s.native.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(original.claimId) as Record<string,unknown>,current_token_hash:row!.current_token_hash});
      expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='reset-claimant'").get()).toEqual({epoch:original.originalEpoch+1});
      expect(db.prepare("SELECT response_status FROM request_results WHERE user_id='reset-claimant' AND request_key='original-retired-save'").get()).toEqual({response_status:410});
      expect([...forwardRows(db,'music_profile_receipts')]).toEqual([...forwardRows(s.native,'music_profile_receipts')]);
      const forged=new Database(bundle.boardDisposition.board.bytes);
      try{
        forged.prepare("UPDATE request_results SET response_status=200 WHERE request_key='original-retired-save'").run();const bytes=forged.serialize(),board={bytes,sha256:forwardHash(bytes)},value={...bundle,boardDisposition:{...bundle.boardDisposition,board,report:{...bundle.boardDisposition.report,derivedBoardSha256:board.sha256}},sources:{...bundle.sources,oldBoard:board}};
        expect(()=>verifyForwardRetiredResetRecovery(s.recoveryInput,value)).toThrow('Retired board original row relation differs');
      }finally{forged.close();}
    }else expect(row).toBeUndefined();
    if(original.attemptId){expect(db.prepare('SELECT * FROM login_attempts WHERE id=?').get(original.attemptId)).toEqual(s.native.prepare('SELECT * FROM login_attempts WHERE id=?').get(original.attemptId));expect(db.prepare("SELECT * FROM external_identities WHERE user_id='reset-claimant'").all()).toEqual(s.native.prepare("SELECT * FROM external_identities WHERE user_id='reset-claimant'").all());}
    expect(createMusicClaims(db,()=>new Date(s.recoveryInput.reconciledAt)).status(original.device,original.claimId)).toEqual({status:'none'});expect(getProfile(db,'reset-claimant')).toBeNull();
    for(const table of ['music_profile_audit','music_ownership_history','music_pin_history','music_field_history','music_contact_history','bot_outbox','bot_settings','bot_runtime'])expect([...forwardRows(db,table)],table).toEqual([...forwardRows(s.native,table)]);
    expect(()=>assertDatabaseUsable(db!)).toThrow('offline review');expect(s.db.serialize()).toEqual(s.before);
  }finally{retained?.close();retired?.close();db?.close();s.close();}
},120000);
