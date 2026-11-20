import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {musicProfileActiveSQL,readMusicRetirements,type DB} from '@qgroup/database';
import {erasureRequestId, type StoredIntent} from '../../apps/api/src/erasure-journal';
import type {RollbackMusic} from './rollback-music';
import type {IdentityAuditMapping} from './rollback-identity';
import {identitySchema} from './identity-schema';
import {identityTables,identitySeconds,quoteIdentity,readRollbackIdentitySource} from './rollback-identity-source';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import {readSourceRebaseEvidence} from './source-rebase-evidence';

function reject():never{throw Error('Rollback identity reconciliation failed; retain the complete latest source');}
function encode(value:unknown):unknown{if(typeof value==='bigint')return {integer:value.toString()};if(Array.isArray(value))return value.map(encode);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,encode(item)]));return value;}
const canonical=(value:unknown)=>JSON.stringify(encode(value));
const equal=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
/** Independent semantic and source-row verifier. Uses the structural reader
 * only to decode preserved evidence, never the identity or music projector. */
export function verifyRollbackIdentity(source:DB,copy:DB,music:RollbackMusic,intents:StoredIntent[],mappings:IdentityAuditMapping[]){
  if(!source.inTransaction)throw Error('Rollback identity verification requires a held source transaction');
  verifyRollbackMusic(source,music,intents);
  const reference=new Database(':memory:');
  try{
    reference.exec(identitySchema);const schema=(db:DB)=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();equal(schema(copy),schema(reference));
    for(const name of ['user_version','application_id','encoding'])equal(copy.pragma(name,{simple:true}),reference.pragma(name,{simple:true}));
    if(copy.pragma('integrity_check',{simple:true})!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)reject();
    const rebased=readSourceRebaseEvidence(source,intents),original=readRollbackIdentitySource(source),byId=new Map(music.keys.map(row=>[row.profileId,row])),byKey=new Map(music.keys.map(row=>[row.legacyKey,row]));
    const originalKeys=new Set(Object.values(original.rows).flatMap(rows=>rows.flatMap(row=>typeof row.value.qq==='string'?[row.value.qq]:[])));
    for(const key of music.keys)if(key.mode==='generated'&&originalKeys.has(key.legacyKey)&&!rebased?.bindings.some(row=>row.profileId===key.profileId&&row.legacyKey===key.legacyKey&&row.mode==='generated'))reject();
    const rows=Object.fromEntries(identityTables.map(table=>[table,copy.prepare(`SELECT rowid AS original_rowid,* FROM ${quoteIdentity(table)} ORDER BY rowid`).safeIntegers(true).all() as Record<string,string|number|bigint>[]]));
    for(const table of identityTables){
      const columns=copy.prepare(`PRAGMA table_xinfo(${quoteIdentity(table)})`).all() as {name:string}[];
      equal(columns,reference.prepare(`PRAGMA table_xinfo(${quoteIdentity(table)})`).all());
      for(const row of copy.prepare(`SELECT ${columns.map((column,index)=>`typeof(${quoteIdentity(column.name)}) AS s${index}`).join(',')} FROM ${quoteIdentity(table)}`).all() as Record<string,string>[]){
        for(const [index,column] of columns.entries()){
          const storage=row['s'+index];
          if(['created','updated','expires','pending_until'].includes(column.name)){if(storage!=='real')reject();}
          else if(['id','revision'].includes(column.name)){if(storage!=='integer')reject();}
          else if(storage!=='text')reject();
        }
      }
    }
    equal(rows.sessions,[]);equal(rows.entry_intents,[]);
    const retired=new Set(readMusicRetirements(source).map(row=>row.profileId));
    const profiles=source.prepare(`SELECT p.id,p.user_id FROM music_profiles p WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid`).all() as {id:string;user_id:string|null}[];
    const live=new Map(profiles.map(row=>[byId.get(row.id)!.legacyKey,row]));
    const expectedOwners=profiles.filter(row=>row.user_id!==null).map(row=>[byId.get(row.id)!.legacyKey,row.user_id]).sort();
    equal([...new Map([...rows.links!,...rows.prelinks!].map(row=>[row.qq,row.user_id])).entries()].sort(),expectedOwners);
    const checkRow=(table:typeof identityTables[number],actual:Record<string,string|number|bigint>,expected:Record<string,string|number|bigint>,old?:typeof original.rows.links[number])=>{
      const {original_rowid:rowid,...body}=actual;equal(body,expected);
      if(old)equal(rowid,old.rowid);else if(typeof rowid!=='bigint'||rowid<=(original.reserved.get(table)??0n))reject();
    };
    const changes=source.prepare('SELECT * FROM music_ownership_history WHERE (? IS NULL OR id>?) ORDER BY id').safeIntegers(true).all(rebased?BigInt(rebased.histories.music_ownership_history.cutoff):null,rebased?BigInt(rebased.histories.music_ownership_history.cutoff):null) as {id:bigint;profile_id:string;revision:bigint;actor_ref:string;before_user_id:string|null;after_user_id:string|null;created_at:string}[];
    const claims=source.prepare("SELECT * FROM music_profile_audit WHERE json_extract(after_json,'$.action')='legacy_claim' AND (? IS NULL OR id>?) ORDER BY id").safeIntegers(true).all(rebased?BigInt(rebased.histories.music_profile_audit.cutoff):null,rebased?BigInt(rebased.histories.music_profile_audit.cutoff):null) as {id:bigint;profile_id:string;revision:bigint;actor_id:string;before_json:string;after_json:string;created_at:string}[];
    const revisions=new Set<string>();for(const row of [...changes,...claims]){const key=row.profile_id+':'+row.revision;if(revisions.has(key))reject();revisions.add(key);}
    for(const row of rows.links!){
      const profile=live.get(String(row.qq))??reject(),old=original.rows.links.find(item=>item.value.qq===row.qq),prelink=original.rows.prelinks.find(item=>item.value.qq===row.qq);
      equal(row.user_id,profile.user_id);
      if(!source.prepare("SELECT 1 FROM external_identities WHERE provider='qq' AND client_id=? AND subject=? AND user_id=?").get(row.app_id,row.openid,row.user_id))reject();
      if(old&&old.value.user_id===profile.user_id)checkRow('links',row,old.value,old);
      else{
        const claim=claims.filter(item=>item.profile_id===profile.id&&item.actor_id===profile.user_id).at(-1)??reject();
        const proofs=source.prepare(`SELECT i.app_id,i.subject FROM music_claim_intents i JOIN login_attempts a ON a.id=i.attempt_id WHERE i.profile_id=? AND i.target_user_id=? AND i.stage='completed'
          AND a.status='used' AND a.app_id=i.app_id AND a.openid=i.subject`).all(profile.id,profile.user_id) as {app_id:string;subject:string}[];if(proofs.length!==1)reject();
        checkRow('links',row,{qq:row.qq!,app_id:proofs[0]!.app_id,openid:proofs[0]!.subject,user_id:profile.user_id!,created:identitySeconds(claim.created_at),source:'legacy_pin_and_qq_oauth'},old);
      }
      if(prelink&&prelink.value.user_id===profile.user_id){const projected=rows.prelinks!.find(item=>item.qq===row.qq)??reject();checkRow('prelinks',projected,prelink.value,prelink);}
    }
    for(const profile of profiles){
      const key=byId.get(profile.id)!.legacyKey,link=rows.links!.find(row=>row.qq===key),prelink=rows.prelinks!.find(row=>row.qq===key),oldLink=original.rows.links.find(row=>row.value.qq===key),oldPre=original.rows.prelinks.find(row=>row.value.qq===key);
      if(link&&prelink&&(!oldPre||oldPre.value.user_id!==profile.user_id))reject();
      const latest=changes.filter(row=>row.profile_id===profile.id).at(-1),claim=claims.filter(row=>row.profile_id===profile.id).at(-1);
      if(latest&&claim&&latest.revision===claim.revision)reject();
      if(profile.user_id&&!link){
        if(!prelink)reject();
        if(oldPre&&oldPre.value.user_id===profile.user_id)checkRow('prelinks',prelink,oldPre.value,oldPre);
        else{const creation=source.prepare("SELECT created_at FROM music_profile_audit WHERE profile_id=? AND revision=1 AND before_json='null' AND actor_id=?").get(profile.id,profile.user_id) as {created_at:string}|undefined;
          const stamp=latest&&latest.after_user_id===profile.user_id?identitySeconds(latest.created_at):creation?identitySeconds(creation.created_at):reject();checkRow('prelinks',prelink,{qq:key,user_id:profile.user_id,created:stamp},oldPre);}
        if(oldLink&&oldLink.value.user_id===profile.user_id)reject();
        if(claim&&claim.actor_id===profile.user_id&&(!latest||claim.revision>latest.revision))reject();
      }
      const override=rows.link_overrides!.find(row=>row.qq===key),oldOverride=original.rows.link_overrides.find(row=>row.value.qq===key);
      if(latest){if(!override)reject();checkRow('link_overrides',override,{qq:key,user_id:profile.user_id??'',revision:(oldOverride?.value.revision as bigint|undefined??0n)+BigInt(changes.filter(row=>row.profile_id===profile.id).length),updated:identitySeconds(latest.created_at)},oldOverride);}
      else if(oldOverride){
        if(!override)reject();if(oldOverride.value.user_id===(profile.user_id??''))checkRow('link_overrides',override,oldOverride.value,oldOverride);
        else{const closed=source.prepare('SELECT created_at FROM privacy_requests WHERE user_id=?').get(oldOverride.value.user_id) as {created_at:string}|undefined;if(profile.user_id||!closed)reject();checkRow('link_overrides',override,{...oldOverride.value,user_id:'',revision:(oldOverride.value.revision as bigint)+1n,updated:identitySeconds(closed.created_at)},oldOverride);}
      }else if(!profile.user_id&&(oldLink||oldPre)){
        const closed=source.prepare('SELECT created_at FROM privacy_requests WHERE user_id=?').get((oldLink??oldPre)!.value.user_id) as {created_at:string}|undefined;if(!closed||!override)reject();checkRow('link_overrides',override,{qq:key,user_id:'',revision:1n,updated:identitySeconds(closed.created_at)});
      }else if(override)reject();
      const native=rows.native_profiles!.find(row=>row.qq===key),oldNative=original.rows.native_profiles.find(row=>row.value.qq===key);
      if(oldNative||byId.get(profile.id)!.mode==='generated'){if(!native)reject();checkRow('native_profiles',native,{qq:key,payload:JSON.stringify((music.data.members as Record<string,unknown>)[key])},oldNative);}else if(native)reject();
    }
    for(const table of ['link_overrides','native_profiles'] as const)if(rows[table]!.some(row=>!live.has(String(row.qq))))reject();
    const contacts=source.prepare(`SELECT c.* FROM music_profile_contacts c JOIN music_profiles p ON p.id=c.profile_id WHERE p.erased_at IS NULL ORDER BY c.rowid`).all() as {profile_id:string;contact_qq:string;source:string;updated_at:string}[];
    const expectedContacts=new Set<string>();
    for(const row of contacts){const key=byId.get(row.profile_id)!.legacyKey,old=original.rows.profile_contacts.find(item=>item.value.qq===key),actual=rows.profile_contacts!.find(item=>item.qq===key);
      if(/^\d{4,12}$/.test(key)&&row.contact_qq!==key)reject();
      if(old||row.source==='self_reported'||retired.has(row.profile_id)){expectedContacts.add(key);if(!actual)reject();checkRow('profile_contacts',actual,old&&old.value.number===row.contact_qq?old.value:{qq:key,number:row.contact_qq,updated:identitySeconds(row.updated_at)},old);}else if(actual)reject();
    }
    const erased=new Set((source.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]).map(row=>row.legacy_key));
    for(const old of original.rows.profile_contacts)if(!byKey.has(String(old.value.qq))&&!erased.has(String(old.value.qq))){expectedContacts.add(String(old.value.qq));checkRow('profile_contacts',rows.profile_contacts!.find(item=>item.qq===old.value.qq)??reject(),old.value,old);}
    equal(rows.profile_contacts!.map(row=>row.qq).sort(),[...expectedContacts].sort());
    const expectedUsed=new Map(original.rows.used_oauth.map(row=>[String(row.value.attempt),row.value]));
    for(const row of source.prepare("SELECT id,created_at FROM login_attempts WHERE provider='qq' AND status='used' ORDER BY rowid").all() as {id:string;created_at:string}[])if(!expectedUsed.has(row.id))expectedUsed.set(row.id,{attempt:row.id,created:identitySeconds(row.created_at)});
    equal(rows.used_oauth!.map(({original_rowid:_id,...row})=>row).sort((a,b)=>String(a.attempt).localeCompare(String(b.attempt))),[...expectedUsed.values()].sort((a,b)=>String(a.attempt).localeCompare(String(b.attempt))));
    for(const row of rows.used_oauth!){const old=original.rows.used_oauth.find(item=>item.value.attempt===row.attempt);checkRow('used_oauth',row,expectedUsed.get(String(row.attempt))!,old);}
    equal(rows.login_attempts!.map(row=>[row.bucket,Number(row.created)]).sort(),(source.prepare('SELECT bucket,created FROM music_claim_attempts').all() as {bucket:string;created:number}[]).map(row=>[row.bucket,row.created]).sort());
    const available=[...original.rows.login_attempts];for(const row of rows.login_attempts!){const index=available.findIndex(item=>item.value.bucket===row.bucket&&Number(item.value.created)===Number(row.created)),old=index<0?undefined:available.splice(index,1)[0];checkRow('login_attempts',row,old?.value??{bucket:row.bucket!,created:row.created!},old);}
    let high=original.highWater;const expectedMappings:IdentityAuditMapping[]=structuredClone(rebased?.auditMappings??[]);
    const expectedAudits:Record<string,string|number|bigint>[]=original.rows.link_audit.map(row=>({original_rowid:row.rowid,...row.value}));
    const audit=(kind:'ownership'|'claim',id:bigint,profile:string,actor:string,before:string|null,after:string|null,created:string)=>{const key=byId.get(profile)??reject();if(key.erased||retired.has(profile))return;high++;expectedAudits.push({original_rowid:high,id:high,qq:key.legacyKey,actor,before_user_id:before??'',after_user_id:after??'',created:identitySeconds(created)});expectedMappings.push({source:kind,sourceId:id.toString(),legacyId:high.toString()});};
    const events=[...changes.map(row=>({source:'ownership' as const,id:row.id,profile:row.profile_id,revision:row.revision,actor:row.actor_ref,before:row.before_user_id,after:row.after_user_id,created:row.created_at})),
      ...claims.map(row=>({source:'claim' as const,id:row.id,profile:row.profile_id,revision:row.revision,actor:'account:'+row.actor_id,before:(JSON.parse(row.before_json) as {userId:string|null}).userId,after:(JSON.parse(row.after_json) as {userId:string|null}).userId,created:row.created_at}))];
    events.sort((a,b)=>a.profile<b.profile?-1:a.profile>b.profile?1:a.revision<b.revision?-1:a.revision>b.revision?1:a.source<b.source?-1:a.source>b.source?1:a.id<b.id?-1:1);
    for(const row of events)audit(row.source,row.id,row.profile,row.actor,row.before,row.after,row.created);
    equal(rows.link_audit,expectedAudits.sort((a,b)=>(a.original_rowid as bigint)<(b.original_rowid as bigint)?-1:1));equal(mappings,expectedMappings);
    equal(copy.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all(),high||original.evidence?.sqliteSequence.length?[{name:'link_audit',seq:high}]:[]);
    equal((source.prepare('SELECT request_id FROM erasure_applied').all() as {request_id:string}[]).map(row=>row.request_id).sort(),[...new Set(intents.map(row=>erasureRequestId(row)))].sort());
    const counts=Object.fromEntries(identityTables.map(table=>[table,rows[table]!.length]));
    return {version:1 as const,tables:counts,rowsDigest:createHash('sha256').update(canonical(rows)).digest('hex'),auditMappings:mappings,highWater:high.toString(),
      authentication:{sessions:'invalidated' as const,entryIntents:'invalidated' as const,orphanLinks:'inactive_checkpoint_only' as const},rollbackEligible:false as const,
      remaining:['latest_erasure_package','media_history','browser_requests','package_manifest','fixed_old_web_music_bot_rehearsal']};
  }finally{reference.close();}
}
