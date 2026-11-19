import {z} from 'zod';
import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {quoted,schemaObjects} from './board-reconciliation';
import {mergeForwardBoard} from './forward-board-merge';
import {mergeForwardMusic} from './forward-music-merge';
import {copyForwardMusicInput,openForwardMusicSources,musicEqual,musicCanonical,type ForwardMusicInput} from './forward-music-sources';
import {normalizeForwardBusinessMusic,businessRow} from './forward-business-model';
import {forwardHash,forwardRows,forwardEqual,assertForwardImage} from './forward-board-storage';
import {object,parseJson} from './music-codec';
import {reconcileForwardBusiness} from './forward-business-reconciliation';

type RecordRow=Record<string,unknown>;
const rows=(db:DB,table:string,keys:string[])=>new Map([...forwardRows(db,table)].map(row=>[musicCanonical(keys.map(column=>row[column])),row]));
const changed=(a:RecordRow|undefined,b:RecordRow|undefined,columns:string[])=>columns.some(column=>!forwardEqual(a?.[column],b?.[column]));
function jsonDelta(previous:unknown,before:unknown,after:unknown){
  const raw=object(parseJson(String(previous)),'native source fields'),a=object(parseJson(String(before)),'baseline fields'),b=object(parseJson(String(after)),'merged fields');
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(!musicEqual(a[key],b[key])){if(Object.hasOwn(b,key))Object.defineProperty(raw,key,{value:b[key],enumerable:true,configurable:true,writable:true});else delete raw[key];}return JSON.stringify(raw);
}
/** Rebuild the actual native business graph on a disposable copy, with original
 * native-only records retained. Proof/source-epoch/media reconciliation is still
 * mandatory; the output remains unusable by every normal service startup. */
export function reconstructForwardBusiness(input:ForwardMusicInput,reconstructedAt:string,assertBoundary?:()=>void){
  z.iso.datetime().parse(reconstructedAt);const held=copyForwardMusicInput(input),s=openForwardMusicSources(held),opened:DB[]=[];
  const open=(bytes:Buffer)=>{const db=new Database(bytes);opened.push(db);return db;};
  const guard=()=>{const value:unknown=assertBoundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Forward business boundary must be synchronous');for(const key of Object.keys(held) as (keyof ForwardMusicInput)[])if(input[key].sha256!==held[key].sha256||!input[key].bytes.equals(held[key].bytes))throw Error('Forward business source changed');};
  try{
    guard();const board=mergeForwardBoard(held),music=mergeForwardMusic(held),candidate=open(board.nativeImage),identity=open(music.identityImage),base=normalizeForwardBusinessMusic(candidate,s.native,s.nativeIdentity);opened.push(base);const next=normalizeForwardBusinessMusic(candidate,music.music,identity);opened.push(next);
    const pins=Object.fromEntries(Object.entries(held).map(([key,item])=>[key,item.sha256])),run=forwardHash('qgroup:forward-business:v1:'+musicCanonical(pins)),profiles=new Set<string>(),ownershipUsers=new Set<string>(),counts:Record<string,number>={};
    candidate.pragma('foreign_keys=OFF');candidate.transaction(()=>{
      const triggers=schemaObjects(candidate).filter(row=>row.type==='trigger');for(const trigger of triggers)candidate.exec(`DROP TRIGGER ${quoted(trigger.name)}`);
      const insertNew=(table:string,columns:string[],values:unknown[])=>{
        const maximum=(candidate.prepare(`SELECT max(rowid) AS n FROM ${quoted(table)}`).safeIntegers(true).get() as {n:bigint|null}).n??0n,high=maximum>0n?maximum:0n;
        if(high===9223372036854775807n)throw Error('Forward business rowid capacity exhausted');
        candidate.prepare(`INSERT INTO ${quoted(table)}(rowid,${columns.map(quoted).join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(high+1n,...values);
      };
      const selectionRebases=new Set<string>();for(const row of next.prepare('SELECT id FROM music_profiles').all() as {id:string}[]){const choices=(db:DB)=>(db.prepare('SELECT entry_id FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id) as {entry_id:string}[]).map(value=>value.entry_id);if(!musicEqual(choices(base),choices(next)))selectionRebases.add(row.id);}
      // All changed UNIQUE values are released before inserting their final
      // values, while retaining the original native rowids on existing rows.
      const updates:{table:string;keys:string[];columns:string[];before:RecordRow|undefined;after:RecordRow|undefined}[]=[];
      for(const [table,keys,columns] of [
        ['music_entries',['id'],['name','kind']],
        ['music_entry_details',['entry_id'],['category','aliases_json','created_by','created_at_json','updated_at_json']],
        ['music_selections',['profile_id','entry_id'],['level','position']],
        ['music_shouts',['id'],['profile_id','legacy_key','name','body','created_at','archived_at']],
      ] as [string,string[],string[]][]){const a=rows(base,table,keys),b=rows(next,table,keys);for(const key of new Set([...a.keys(),...b.keys()])){const before=a.get(key),after=b.get(key),current=after?businessRow(candidate,table,keys,keys.map(column=>after[column])):undefined,positionChange=table==='music_selections'&&after&&selectionRebases.has(String(after.profile_id))&&!forwardEqual(current?.position,after.position);if(!before||!after||changed(before,after,columns)||positionChange){updates.push({table,keys,columns,before,after});counts[table]=(counts[table]??0)+1;if(table==='music_selections')profiles.add(String((after??before)!.profile_id));}}}
      const aProfiles=rows(base,'music_profiles',['id']),bProfiles=rows(next,'music_profiles',['id']);
      for(const [key,after] of bProfiles){const before=aProfiles.get(key),id=String(after.id);if(before&&!forwardEqual(before.user_id,after.user_id)){candidate.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(id);profiles.add(id);}
        if(!forwardEqual(before?.user_id,after.user_id))for(const user of [before?.user_id,after.user_id])if(typeof user==='string'&&user)ownershipUsers.add(user);
      }
      for(const [key,after] of bProfiles)if(!aProfiles.has(key)){insertNew('music_profiles',['id','user_id','revision','updated_at','erased_at'],[after.id,after.user_id,0n,reconstructedAt,null]);profiles.add(String(after.id));}
      for(const [key,after] of bProfiles){const before=aProfiles.get(key);if(before&&!forwardEqual(before.user_id,after.user_id))candidate.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run(after.user_id,after.id);}
      for(const [table,columns] of [
        ['music_profile_fields',['name','note','note_at','gender','gender_public']],
        ['music_profile_contacts',['contact_qq','source']],
        ['music_legacy_profiles',['legacy_key','name','consent','pin_hash','contact_qq','fields_json','created_entries_json','ownership_source']],
      ] as [string,string[]][]){const a=rows(base,table,['profile_id']),b=rows(next,table,['profile_id']);for(const [key,afterRaw] of b){const before=a.get(key);if(before&&!changed(before,afterRaw,columns))continue;const after={...afterRaw},id=String(after.profile_id),current=businessRow(candidate,table,['profile_id'],[id]);profiles.add(id);
          if(table==='music_legacy_profiles'&&current&&before&&after.fields_json!==before.fields_json)after.fields_json=jsonDelta(current.fields_json,before.fields_json,after.fields_json);
          if(current&&before)for(const column of columns)if(forwardEqual(before[column],afterRaw[column]))after[column]=current[column];
          const names=table==='music_legacy_profiles'?columns:[...columns,'revision','updated_at'];if(table!=='music_legacy_profiles'){const revision=current?.revision as bigint|undefined;if(revision!==undefined&&revision>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Forward business revision capacity exhausted');after.revision=revision===undefined?0n:revision+1n;after.updated_at=reconstructedAt;}
          // These values have cross-row UNIQUE constraints; defer replacement.
          updates.push({table,keys:['profile_id'],columns:names,before:undefined,after:{...current,...after}});counts[table]=(counts[table]??0)+1;
        }}
      // Replace only changed rows; unchanged native rows, storage classes and
      // rowids stay byte-for-byte logical equivalents of the pinned source.
      const highWater=new Map<string,bigint>();for(const item of updates)if(!highWater.has(item.table))highWater.set(item.table,[...forwardRows(candidate,item.table)].map(row=>row.__forward_rowid__).reduce((a,b)=>a>b?a:b,0n));
      const originals=new Map<string,RecordRow>();for(const item of updates){const key=musicCanonical([item.table,...item.keys.map(column=>(item.after??item.before)![column])]),values=item.keys.map(column=>(item.after??item.before)![column]),current=businessRow(candidate,item.table,item.keys,values);if(current)originals.set(key,current);candidate.prepare(`DELETE FROM ${quoted(item.table)} WHERE ${item.keys.map(column=>quoted(column)+'=?').join(' AND ')}`).run(...values);}
      for(const item of updates){if(!item.after)continue;const key=musicCanonical([item.table,...item.keys.map(column=>item.after![column])]),current=originals.get(key),values={...current,...item.after};
        if(item.before&&current)for(const column of item.columns)if(forwardEqual(item.before[column],item.after[column])&&!(item.table==='music_selections'&&column==='position'&&selectionRebases.has(String(item.after.profile_id))))values[column]=current[column];
        if(item.table==='music_shouts')values.ordinal=current?.ordinal??((candidate.prepare('SELECT max(ordinal) AS n FROM music_shouts').safeIntegers(true).get() as {n:bigint|null}).n??-1n)+1n;
        const columns=(candidate.prepare(`PRAGMA table_xinfo(${quoted(item.table)})`).all() as {name:string}[]).map(row=>row.name),insertColumns=['rowid',...columns];let rowid=current?.__rowid__ as bigint|undefined;if(rowid===undefined){const high=highWater.get(item.table)!;if(high===9223372036854775807n)throw Error('Forward business rowid capacity exhausted');rowid=high+1n;highWater.set(item.table,rowid);}candidate.prepare(`INSERT INTO ${quoted(item.table)}(${insertColumns.map(quoted).join(',')}) VALUES(${insertColumns.map(()=>'?').join(',')})`).run(...insertColumns.map(column=>column==='rowid'?rowid:values[column]));
      }
      for(const id of profiles){const current=businessRow(candidate,'music_profiles',['id'],[id]),original=businessRow(s.board.native,'music_profiles',['id'],[id]);if(original){const revision=original.revision as bigint;if(revision>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Forward business revision capacity exhausted');candidate.prepare('UPDATE music_profiles SET revision=?,updated_at=? WHERE id=?').run(revision+1n,reconstructedAt,id);}if(!current)throw Error('Forward business profile missing');}
      for(const user of ownershipUsers){const previous=businessRow(candidate,'music_account_epochs',['user_id'],[user]);if(previous&&(previous.epoch as bigint)>=BigInt(Number.MAX_SAFE_INTEGER))throw Error('Forward account epoch capacity exhausted');if(previous)candidate.prepare('UPDATE music_account_epochs SET epoch=epoch+1 WHERE user_id=?').run(user);else insertNew('music_account_epochs',['user_id','epoch'],[user,1n]);}
      const available=[...forwardRows(s.board.native,'music_claim_attempts')],binding=new Map<bigint,typeof available[number]>();
      for(const row of forwardRows(s.nativeIdentity,'login_attempts')){const index=available.findIndex(item=>item.bucket===row.bucket&&Number(item.created)===Number(row.created));if(index<0)throw Error('Forward native claim source differs');binding.set(row.__forward_rowid__,available.splice(index,1)[0]!);}if(available.length)throw Error('Forward native claim source is incomplete');
      const selected=new Map([...forwardRows(identity,'login_attempts')].map(row=>[row.__forward_rowid__,row]));
      for(const [id,original] of binding){const after=selected.get(id);if(!after)candidate.prepare('DELETE FROM music_claim_attempts WHERE rowid=?').run(original.__forward_rowid__);else if(original.bucket!==after.bucket||Number(original.created)!==Number(after.created))candidate.prepare('UPDATE music_claim_attempts SET bucket=?,created=? WHERE rowid=?').run(after.bucket,after.created,original.__forward_rowid__);}
      let claimHigh=([...forwardRows(s.board.native,'music_claim_attempts')].map(row=>row.__forward_rowid__).reduce((a,b)=>a>b?a:b,0n));
      for(const [id,row] of selected)if(!binding.has(id)){if(claimHigh===9223372036854775807n)throw Error('Forward claim rowid capacity exhausted');candidate.prepare('INSERT INTO music_claim_attempts(rowid,bucket,created) VALUES(?,?,?)').run(++claimHigh,row.bucket,row.created);}
      // An old catalog deletion must also remove the direct creation reference;
      // all native catalog action history and private source evidence are kept.
      candidate.exec('DELETE FROM music_entry_creations WHERE entry_id NOT IN (SELECT id FROM music_entries)');
      const baseMembers=object(s.native.data.members,'base members'),newMembers=object(music.music.data.members,'merged members');
      for(const mapping of music.music.keys){if(mapping.erased)continue;const b=baseMembers[mapping.legacyKey],n=newMembers[mapping.legacyKey];if(!n)throw Error('Forward business member missing');const before=b?object(b,'base member'):null,after=object(n,'merged member');
        if(!musicEqual(before?.lastShoutAt,after.lastShoutAt)){const value=Number(after.lastShoutAt??0);if(!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)throw Error('Unrepresentable forward author throttle');if(businessRow(candidate,'music_shout_authors',['profile_id'],[mapping.profileId]))candidate.prepare('UPDATE music_shout_authors SET last_post_at=? WHERE profile_id=?').run(value,mapping.profileId);else insertNew('music_shout_authors',['profile_id','last_post_at'],[mapping.profileId,value]);}
        if(!musicEqual(before?.created??[],after.created??[])){const kept=new Set((after.created??[]) as string[]);for(const row of candidate.prepare('SELECT entry_id FROM music_entry_creations WHERE profile_id=?').all(mapping.profileId) as {entry_id:string}[])if(!kept.has(row.entry_id))candidate.prepare('DELETE FROM music_entry_creations WHERE profile_id=? AND entry_id=?').run(mapping.profileId,row.entry_id);}
      }
      const ordered=[...(music.music.data.shoutHistory as {id:string}[]),...(music.music.data.shouts as {id:string}[])].map(row=>row.id);let reordered=false;
      for(const kind of ['shouts','shoutHistory']){const wanted=(music.music.data[kind] as {id:string}[]).map(row=>row.id),actual=(candidate.prepare(`SELECT id FROM music_shouts WHERE archived_at IS ${kind==='shouts'?'NULL':'NOT NULL'} ORDER BY ordinal,rowid`).all() as {id:string}[]).map(row=>row.id);if(JSON.stringify(wanted)!==JSON.stringify(actual))reordered=true;}
      if(reordered)ordered.forEach((id,ordinal)=>candidate.prepare('UPDATE music_shouts SET ordinal=? WHERE id=?').run(ordinal,id));
      const oldTrend=s.native.data.trend as unknown[],newTrend=music.music.data.trend as unknown[];if(newTrend.length<oldTrend.length||oldTrend.some((point,index)=>!musicEqual(point,newTrend[index])))throw Error('Forward trend history replacement requires structured reset authority');
      let position=(candidate.prepare("SELECT max(position) AS n FROM music_documents WHERE kind='trend_sample'").safeIntegers(true).get() as {n:bigint|null}).n??-1n;for(const point of newTrend.slice(oldTrend.length)){if(position===9223372036854775807n)throw Error('Forward trend position capacity exhausted');insertNew('music_documents',['kind','position','payload_json'],['trend_sample',++position,JSON.stringify(point)]);}
      // Original private documents/maps/history stay intact. The external,
      // pinned merged source pair accompanies this candidate until full rebase.
      const manifest={version:1,kind:'forward_business',sourcePins:pins,mergedMusicSha256:forwardHash(musicCanonical(music.music)),mergedIdentitySha256:forwardHash(music.identityImage),reconstructedAt},summary={tables:counts,changedProfiles:profiles.size,ownershipEpochs:ownershipUsers.size,proofReconciliationRequired:true,sourceRebaseRequired:true,releaseEligible:false};
      if(candidate.prepare('SELECT 1 FROM migration_runs WHERE source_digest=?').get(run))throw Error('Forward business run already exists in source');insertNew('migration_runs',['source_digest','manifest_json','report_json','created_at'],[run,JSON.stringify(manifest),JSON.stringify(summary),reconstructedAt]);candidate.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();
      for(const trigger of triggers)candidate.exec(trigger.sql!);
    }).immediate();candidate.pragma('foreign_keys=ON');
    const reconciliation=reconcileForwardBusiness(held,candidate,music.music,music.identityImage,reconstructedAt,run);guard();const nativeImage=candidate.serialize();assertForwardImage(nativeImage);
    return {nativeImage,nativeJournal:Buffer.from(held.nativeJournal.bytes),musicSources:music.music,identitySources:music.identityImage,report:{version:1 as const,sourcePins:pins,sourceDigest:run,nativeImageSha256:forwardHash(nativeImage),reconstructedAt,changedProfiles:profiles.size,ownershipEpochs:ownershipUsers.size,reconciliation,businessCandidateOnly:true as const,proofReconciliationRequired:true as const,sourceRebaseRequired:true as const,recoveryRequired:true as const,rollbackEligible:false as const,releaseEligible:false as const,remaining:['original_source_rebase_and_pending_proof_receipt_reconciliation','complete_authority_backed_account_reset_repair','media_browser_and_stopped_source_capture','authority_epoch_custody_and_fixed_service_acceptance']}};
  }finally{for(const db of opened.reverse())db.close();s.close();}
}
