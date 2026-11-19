import type {DB} from '@qgroup/database';
import {forwardRows,forwardEqual,forwardHash,forwardCanonical,type ForwardRow} from './forward-board-storage';
import {object} from './music-codec';
import type {ForwardProofSources} from './forward-proof-source';

export const reassignedMusicResult=JSON.stringify({code:'PROFILE_REASSIGNED',message:'成分關聯已變更，請核對目前成分；原操作不會重新保存'});
export type ProofDisposition={id:string;rowid:string;beforeSha256:string;action:'retain'|'retire_pending'|'detach_completed';reasons:string[];detachedTokenHash?:string};
export const proofRowDigest=(row:ForwardRow)=>forwardHash(forwardCanonical(row));
export function forwardOwnershipObservations(s:ForwardProofSources){
  const observed=new Map<string,Set<string>>(),byKey=new Map(s.music.keys.filter(row=>!row.erased).map(row=>[row.legacyKey,row.profileId])),owners=new Set<string>();
  const observe=(row:ForwardRow)=>{const id=byKey.get(String(row.qq));if(!id)return;const reasons=observed.get(id)??new Set<string>();reasons.add('old_'+String(row.__observed_table__));observed.set(id,reasons);for(const field of ['user_id','before_user_id','after_user_id'])if(typeof row[field]==='string'&&row[field]&&s.business.prepare('SELECT 1 FROM users WHERE id=?').get(row[field]))owners.add(String(row[field]));};
  for(const table of ['links','prelinks','link_overrides','link_audit']){const base=new Map([...forwardRows(s.original.baselineIdentity,table)].map(row=>[row.__forward_rowid__,row])),old=new Map([...forwardRows(s.original.oldIdentity,table)].map(row=>[row.__forward_rowid__,row]));for(const id of new Set([...base.keys(),...old.keys()])){const before=base.get(id),after=old.get(id);if(forwardEqual(before,after))continue;for(const row of [before,after])if(row)observe({...row,__observed_table__:table});}}
  const native=new Map([...forwardRows(s.original.board.native,'music_profiles')].map(row=>[String(row.id),row])),profiles=new Set<string>(),pinProfiles=new Set<string>(),receiptProfiles=new Set<string>();
  const nativeMembers=object(s.original.native.data.members,'native proof members'),members=object(s.music.data.members,'merged proof members');
  for(const mapping of s.music.keys){if(mapping.erased)continue;const row=s.business.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(mapping.profileId) as {user_id:string|null}|undefined,old=native.get(mapping.profileId);if(!row)throw Error('Forward proof profile missing');const ownershipChanged=old&&old.user_id!==row.user_id;
    if(observed.has(mapping.profileId)||ownershipChanged){profiles.add(mapping.profileId);receiptProfiles.add(mapping.profileId);for(const id of [old?.user_id,row.user_id])if(typeof id==='string'&&id)owners.add(id);}
    const before=nativeMembers[mapping.legacyKey],after=members[mapping.legacyKey];if(before&&object(before,'native member').pinHash!==object(after,'merged member').pinHash){profiles.add(mapping.profileId);pinProfiles.add(mapping.profileId);}
  }
  return {profiles,pinProfiles,receiptProfiles,owners,observed};
}
export function forwardClaimReasons(db:DB,row:ForwardRow,profiles:Set<string>,owners:Set<string>,now:string){
  const reasons=new Set<string>(),profile=db.prepare('SELECT user_id,revision,erased_at FROM music_profiles WHERE id=?').safeIntegers(true).get(row.profile_id) as {user_id:string|null;revision:bigint;erased_at:string|null}|undefined,target=row.target_user_id as string|null;
  if(profiles.has(String(row.profile_id)))reasons.add('profile_authority_changed');if(target&&owners.has(target))reasons.add('target_authority_changed');
  if(!profile||profile.erased_at!==null)reasons.add('profile_unavailable');
  const member=db.prepare('SELECT user_id FROM browser_sessions WHERE token_hash=?').get(row.current_token_hash) as {user_id:string}|undefined;
  const visitor=db.prepare('SELECT expires_at FROM visitor_sessions WHERE token_hash=?').get(row.current_token_hash) as {expires_at:string}|undefined;
  if(target){if(member?.user_id!==target)reasons.add('device_scope_changed');if(db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(target))reasons.add('account_closed');}
  else if(member||!visitor||!Number.isFinite(Date.parse(visitor.expires_at))||Date.parse(visitor.expires_at)<=Date.parse(now))reasons.add('device_scope_changed');
  const attempt=row.attempt_id?db.prepare('SELECT * FROM login_attempts WHERE id=?').get(row.attempt_id) as Record<string,unknown>|undefined:undefined;
  if(row.stage==='completed'){
    if(!target||profile?.user_id!==target)reasons.add('completed_owner_changed');
    if(!attempt||attempt.status!=='used'||attempt.provider!=='qq'||attempt.app_id!==row.app_id||attempt.openid!==row.subject||!db.prepare("SELECT 1 FROM external_identities WHERE provider='qq' AND client_id=? AND subject=? AND user_id=?").get(row.app_id,row.subject,target))reasons.add('completed_proof_unverifiable');
  }else{
    if(!Number.isFinite(Date.parse(String(row.expires_at)))||Date.parse(String(row.expires_at))<=Date.parse(now))reasons.add('claim_expired');
    if(profile?.user_id)reasons.add('profile_owned');if(profile&&profile.revision!==row.profile_revision)reasons.add('profile_revision_changed');
    const pin=db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(row.profile_id) as {pin_hash:string}|undefined;if(!pin||forwardHash('music-claim-pin:'+pin.pin_hash)!==row.pin_proof)reasons.add('pin_changed');
    if(target){const epoch=(db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').safeIntegers(true).get(target) as {epoch:bigint}|undefined)?.epoch??0n;if(epoch!==row.music_epoch)reasons.add('target_epoch_changed');if(db.prepare('SELECT 1 FROM music_profiles WHERE user_id=? AND erased_at IS NULL').get(target))reasons.add('target_has_profile');}
    if(row.stage==='authorized'){
      if(!target||!attempt||attempt.status!=='used'||attempt.provider!=='qq'||attempt.app_id!==row.app_id||attempt.openid!==row.subject||!db.prepare("SELECT 1 FROM external_identities WHERE provider='qq' AND client_id=? AND subject=? AND user_id=?").get(row.app_id,row.subject,target))reasons.add('authorization_unverifiable');
    }else if(row.attempt_id&&(!attempt||attempt.provider!=='qq'||!['pending','exchanging','verified'].includes(String(attempt.status))||attempt.token_hash!==row.current_token_hash||!Number.isFinite(Date.parse(String(attempt.expires_at)))||Date.parse(String(attempt.expires_at))<=Date.parse(now)))reasons.add('authorization_unverifiable');
  }
  return [...reasons].sort();
}
