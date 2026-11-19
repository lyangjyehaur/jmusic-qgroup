import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { readVerifiedErasureJournal,type ErasureJournal } from '../../apps/api/src/erasure-journal';
import { assertRollbackSource } from './rollback-source';
import { identitySchema } from './identity-schema';
import { identityColumns,identitySeconds,identityTables,quoteIdentity,readRollbackIdentitySource,type IdentityRow } from './rollback-identity-source';
import { verifyRollbackMusic } from './rollback-music-reconciliation';
import type { RollbackMusic } from './rollback-music';
import { verifyRollbackIdentity } from './rollback-identity-reconciliation';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

export type IdentityAuditMapping={source:'ownership'|'claim';sourceId:string;legacyId:string};
/** Private old identity component; current music output is rechecked against
 * this held source. No proof activation, provider lookup, worker or file write. */
export function projectRollbackIdentity(source:DB,journal:ErasureJournal,music:RollbackMusic){
  if(source.inTransaction)throw Error('Rollback identity requires a standalone source transaction');
  const copy=new Database(':memory:');
  try{
    const report=source.transaction(()=>{
      assertRollbackSource(source);const intents=readVerifiedErasureJournal(source,journal);verifyRollbackMusic(source,music,intents);
      const rebased=readSourceRebaseEvidence(source,intents),original=readRollbackIdentitySource(source),map=new Map(music.keys.map(row=>[row.profileId,row])),byKey=new Map(music.keys.map(row=>[row.legacyKey,row]));
      const sourceKeys=new Set(Object.values(original.rows).flatMap(rows=>rows.flatMap(row=>typeof row.value.qq==='string'?[row.value.qq]:[])));
      for(const key of music.keys)if(key.mode==='generated'&&sourceKeys.has(key.legacyKey)&&!rebased?.bindings.some(row=>row.profileId===key.profileId&&row.legacyKey===key.legacyKey&&row.mode==='generated'))throw Error('Generated rollback key collides with original identity');
      const rows=Object.fromEntries(identityTables.map(table=>[table,[] as IdentityRow[]])) as typeof original.rows;
      const next=new Map(original.reserved),allocate=(table:string)=>{const value=(next.get(table)??0n)+1n;if(value>9223372036854775807n)throw Error('Rollback identity rowid capacity exhausted');next.set(table,value);return value;};
      const append=(table:typeof identityTables[number],value:IdentityRow['value'],previous?:IdentityRow)=>rows[table].push({rowid:previous?.rowid??allocate(table),value});
      const profiles=source.prepare('SELECT id,user_id,erased_at FROM music_profiles ORDER BY rowid').all() as {id:string;user_id:string|null;erased_at:string|null}[];
      const erased=new Set([...music.keys.filter(row=>row.erased).map(row=>row.legacyKey),...(source.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]).map(row=>row.legacy_key)]);
      const changes=source.prepare('SELECT * FROM music_ownership_history WHERE (? IS NULL OR id>?) ORDER BY id').safeIntegers(true).all(rebased?BigInt(rebased.histories.music_ownership_history.cutoff):null,rebased?BigInt(rebased.histories.music_ownership_history.cutoff):null) as {id:bigint;profile_id:string;revision:bigint;actor_ref:string;before_user_id:string|null;after_user_id:string|null;created_at:string}[];
      const claims=source.prepare("SELECT * FROM music_profile_audit WHERE json_extract(after_json,'$.action')='legacy_claim' AND (? IS NULL OR id>?) ORDER BY id").safeIntegers(true).all(rebased?BigInt(rebased.histories.music_profile_audit.cutoff):null,rebased?BigInt(rebased.histories.music_profile_audit.cutoff):null) as {id:bigint;profile_id:string;revision:bigint;actor_id:string;before_json:string;after_json:string;created_at:string}[];
      const revisions=new Set<string>();for(const row of [...changes,...claims]){const key=row.profile_id+':'+row.revision;if(revisions.has(key))throw Error('Ambiguous rollback ownership revision');revisions.add(key);}
      for(const profile of profiles){
        if(profile.erased_at!==null)continue;const key=map.get(profile.id)!.legacyKey;
        const link=original.rows.links.find(row=>row.value.qq===key),prelink=original.rows.prelinks.find(row=>row.value.qq===key),override=original.rows.link_overrides.find(row=>row.value.qq===key);
        const latestChange=changes.filter(row=>row.profile_id===profile.id).at(-1),latestClaim=claims.filter(row=>row.profile_id===profile.id).at(-1);
        if(latestChange&&latestClaim&&latestChange.revision===latestClaim.revision)throw Error('Ambiguous rollback ownership revision');
        const prior=link??prelink;
        let stamp:number|bigint|undefined;
        if(profile.user_id){
          if(source.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(profile.user_id))throw Error('Closed rollback identity owner');
          if(link&&link.value.user_id===profile.user_id){
            if(!source.prepare("SELECT 1 FROM external_identities WHERE provider='qq' AND client_id=? AND subject=? AND user_id=?").get(link.value.app_id,link.value.openid,profile.user_id))throw Error('Rollback QQ link differs from current identity');
            append('links',link.value,link);stamp=link.value.created as number|bigint;
          }else if(latestClaim&&latestClaim.actor_id===profile.user_id&&(!latestChange||latestClaim.revision>latestChange.revision)){
            const proof=source.prepare(`SELECT i.app_id,i.subject,i.attempt_id FROM music_claim_intents i JOIN login_attempts a ON a.id=i.attempt_id
              JOIN external_identities e ON e.provider='qq' AND e.client_id=i.app_id AND e.subject=i.subject AND e.user_id=i.target_user_id
              WHERE i.profile_id=? AND i.target_user_id=? AND i.stage='completed' AND a.status='used' AND a.app_id=i.app_id AND a.openid=i.subject`).all(profile.id,profile.user_id) as {app_id:string;subject:string;attempt_id:string}[];
            if(proof.length!==1)throw Error('Missing rollback completed QQ claim proof');stamp=identitySeconds(latestClaim.created_at);
            append('links',{qq:key,app_id:proof[0]!.app_id,openid:proof[0]!.subject,user_id:profile.user_id,created:stamp,source:'legacy_pin_and_qq_oauth'},link);
          }else if(prelink&&prelink.value.user_id===profile.user_id){append('prelinks',prelink.value,prelink);stamp=prelink.value.created as number|bigint;}
          else{
            if(latestChange&&latestChange.after_user_id===profile.user_id)stamp=identitySeconds(latestChange.created_at);
            else{
              const creation=source.prepare("SELECT created_at FROM music_profile_audit WHERE profile_id=? AND revision=1 AND before_json='null' AND actor_id=?").get(profile.id,profile.user_id) as {created_at:string}|undefined;
              if(!creation)throw Error('Missing rollback identity ownership provenance');stamp=identitySeconds(creation.created_at);
            }
            append('prelinks',{qq:key,user_id:profile.user_id,created:stamp},prelink);
          }
          if(link&&rows.links.some(row=>row.value.qq===key)&&prelink&&prelink.value.user_id===profile.user_id)append('prelinks',prelink.value,prelink);
        }
        if(latestChange){
          append('link_overrides',{qq:key,user_id:profile.user_id??'',revision:(override?.value.revision as bigint|undefined??0n)+BigInt(changes.filter(row=>row.profile_id===profile.id).length),updated:identitySeconds(latestChange.created_at)},override);
        }else if(override){
          if(override.value.user_id===(profile.user_id??''))append('link_overrides',override.value,override);
          else{
            const closure=source.prepare('SELECT created_at FROM privacy_requests WHERE user_id=?').get(override.value.user_id) as {created_at:string}|undefined;
            if(profile.user_id||!closure)throw Error('Rollback override differs from current owner');
            append('link_overrides',{...override.value,user_id:'',revision:(override.value.revision as bigint)+1n,updated:identitySeconds(closure.created_at)},override);
          }
        }else if(!profile.user_id&&prior){
          const closure=source.prepare('SELECT created_at FROM privacy_requests WHERE user_id=?').get(prior.value.user_id) as {created_at:string}|undefined;
          if(!closure)throw Error('Missing rollback identity detachment provenance');
          append('link_overrides',{qq:key,user_id:'',revision:1n,updated:identitySeconds(closure.created_at)});
        }
        const native=original.rows.native_profiles.find(row=>row.value.qq===key);
        if(native||map.get(profile.id)!.mode==='generated')append('native_profiles',{qq:key,payload:JSON.stringify((music.data.members as Record<string,unknown>)[key])},native);
      }
      // Unknown/orphan authentication is kept only in the full source checkpoint.
      // Orphan contacts continue reserving aliases without granting ownership.
      for(const contact of original.rows.profile_contacts)if(!byKey.has(String(contact.value.qq))&&!erased.has(String(contact.value.qq)))append('profile_contacts',contact.value,contact);
      for(const row of source.prepare(`SELECT c.*,p.erased_at FROM music_profile_contacts c JOIN music_profiles p ON p.id=c.profile_id ORDER BY c.rowid`).all() as {profile_id:string;contact_qq:string;source:string;updated_at:string;erased_at:string|null}[]){
        if(row.erased_at!==null)continue;const key=map.get(row.profile_id)!.legacyKey,previous=original.rows.profile_contacts.find(item=>item.value.qq===key);
        if(/^[0-9]{4,12}$/.test(key)&&row.contact_qq!==key)throw Error('Legacy numeric rollback contact cannot change');
        if(previous&&previous.value.number===row.contact_qq)append('profile_contacts',previous.value,previous);
        else if(previous||row.source==='self_reported')append('profile_contacts',{qq:key,number:row.contact_qq,updated:identitySeconds(row.updated_at)},previous);
      }
      for(const row of original.rows.used_oauth)append('used_oauth',row.value,row);
      for(const row of source.prepare("SELECT id,created_at FROM login_attempts WHERE provider='qq' AND status='used' ORDER BY rowid").all() as {id:string;created_at:string}[]){
        if(!rows.used_oauth.some(item=>item.value.attempt===row.id))append('used_oauth',{attempt:row.id,created:identitySeconds(row.created_at)});
      }
      const available=[...original.rows.login_attempts];
      for(const row of source.prepare('SELECT bucket,created FROM music_claim_attempts ORDER BY rowid').all() as {bucket:string;created:number}[]){
        const index=available.findIndex(item=>item.value.bucket===row.bucket&&Number(item.value.created)===row.created),previous=index<0?undefined:available.splice(index,1)[0];
        append('login_attempts',previous?.value??row,previous);
      }
      let auditId=original.highWater;for(const row of original.rows.link_audit){if(erased.has(String(row.value.qq)))throw Error('Erased rollback audit requires recovery');append('link_audit',row.value,row);}
      const auditMappings:IdentityAuditMapping[]=structuredClone(rebased?.auditMappings??[]);
      const audit=(kind:'ownership'|'claim',id:bigint,profileId:string,actor:string,before:string|null,after:string|null,created:string)=>{
        if(map.get(profileId)?.erased)return;const key=map.get(profileId)?.legacyKey;if(!key)throw Error('Unmapped rollback audit profile');if(auditId===9223372036854775807n)throw Error('Rollback identity audit capacity exhausted');auditId++;
        rows.link_audit.push({rowid:auditId,value:{id:auditId,qq:key,actor,before_user_id:before??'',after_user_id:after??'',created:identitySeconds(created)}});auditMappings.push({source:kind,sourceId:id.toString(),legacyId:auditId.toString()});
      };
      const pending=[...changes.map(row=>({kind:'ownership' as const,id:row.id,profile:row.profile_id,revision:row.revision,actor:row.actor_ref,before:row.before_user_id,after:row.after_user_id,created:row.created_at})),
        ...claims.map(row=>({kind:'claim' as const,id:row.id,profile:row.profile_id,revision:row.revision,actor:'account:'+row.actor_id,before:(JSON.parse(row.before_json) as {userId:string|null}).userId,after:(JSON.parse(row.after_json) as {userId:string|null}).userId,created:row.created_at}))];
      // Namespaces have no shared legacy audit counter. Group by profile, then
      // its authoritative revision, retaining timestamps and reversible IDs.
      pending.sort((a,b)=>a.profile<b.profile?-1:a.profile>b.profile?1:a.revision<b.revision?-1:a.revision>b.revision?1:a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:1);
      for(const row of pending)audit(row.kind,row.id,row.profile,row.actor,row.before,row.after,row.created);
      copy.exec(identitySchema);
      copy.transaction(()=>{
        for(const table of identityTables){const insert=copy.prepare(`INSERT INTO ${quoteIdentity(table)}(rowid,${identityColumns[table].map(quoteIdentity).join(',')}) VALUES(${Array(identityColumns[table].length+1).fill('?').join(',')})`);for(const row of rows[table])insert.run(row.rowid,...identityColumns[table].map(column=>row.value[column]));}
        copy.exec('DELETE FROM sqlite_sequence');if(auditId||original.evidence?.sqliteSequence.length)copy.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',?)").run(auditId);
      })();
      return verifyRollbackIdentity(source,copy,music,intents,auditMappings);
    }).immediate();
    return {db:copy,report};
  }catch(error){copy.close();throw error;}
}
