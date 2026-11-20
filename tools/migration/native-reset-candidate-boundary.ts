import type {DB} from '@qgroup/database';
import type {StoredIntent} from '../../apps/api/src/erasure-journal';
import {forwardEqual,forwardRows} from './forward-board-storage';
import {assertNativeResetEntryBoundary} from './native-reset-entry-boundary';
import {assertNativeResetProfileBoundary} from './native-reset-profile-boundary';

/** Physical owner counters are monotone, including when no live profile
 * remains. Never replace them with a count or a JavaScript rounded number. */
export function nativeOwnerEpochs(db:DB){
  const rows=db.prepare('SELECT user_id,epoch,typeof(user_id) AS owner_type,typeof(epoch) AS epoch_type FROM music_account_epochs').safeIntegers(true).all() as {user_id:string;epoch:bigint;owner_type:string;epoch_type:string}[];
  const epochs=new Map<string,bigint>();
  for(const row of rows){
    if(row.owner_type!=='text'||!row.user_id||row.epoch_type!=='integer'||typeof row.epoch!=='bigint'||row.epoch<0n||epochs.has(row.user_id))throw Error('Native reset owner epoch is not a unique nonnegative integer');
    epochs.set(row.user_id,row.epoch);
  }return epochs;
}

/** Minimum ancestry constraints from a verified completed reset. This does
 * not establish stopped-source custody or resolve exact identical key reuse. */
export function assertNativeResetPrivateBoundary(before:DB,completed:DB,current:DB,intents:StoredIntent[],completedLength:number,profileIds:string[],entryIds:string[]){
  const floor=nativeOwnerEpochs(completed),actual=nativeOwnerEpochs(current);
  for(const [owner,epoch] of floor)if((actual.get(owner)??-1n)<epoch)throw Error('Native reset candidate owner epoch rewound below completion');
  const stamps=new Map<string,string>();
  for(const id of profileIds){const row=completed.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(id) as {erased_at:string};stamps.set(id,row.erased_at);}
  // Journal order, rather than wall-clock time, defines the latest applied
  // erasure. An older timestamp in a later genuine intent remains exact.
  for(const intent of intents.slice(completedLength)){
    if(!('version' in intent))continue;
    if(intent.version===1){if(intent.kind!=='account'&&intent.profileId&&stamps.has(intent.profileId))stamps.set(intent.profileId,intent.createdAt);}
    else if(intent.version===2){for(const profile of intent.profiles)if(stamps.has(profile.id))stamps.set(profile.id,intent.createdAt);}
    else if(stamps.has(intent.profileId))stamps.set(intent.profileId,intent.createdAt);
  }
  const originalProfiles=new Map([...forwardRows(completed,'music_profiles')].filter(r=>stamps.has(String(r.id))).map(r=>[String(r.id),r])),currentProfiles=new Map([...forwardRows(current,'music_profiles')].map(r=>[String(r.id),r]));
  for(const [id,row] of originalProfiles){const expected={...row,erased_at:stamps.get(id)};if(!forwardEqual(expected,currentProfiles.get(id)))throw Error('Native reset original tombstone generation changed');}
  const ids=new Set(entryIds),originalEntries=new Map([...forwardRows(before,'music_entries')].filter(r=>ids.has(String(r.id))).map(r=>[String(r.id),r]));
  for(const row of forwardRows(current,'music_entries'))if(ids.has(String(row.id))&&!forwardEqual(row,originalEntries.get(String(row.id))))throw Error('Native reset original entry identity was reused; generation evidence required');
  assertNativeResetEntryBoundary(before,current,profileIds,entryIds);
  assertNativeResetProfileBoundary(before,completed,current,profileIds);
}
