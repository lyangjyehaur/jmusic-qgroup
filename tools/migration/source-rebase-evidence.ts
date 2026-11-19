import {z} from 'zod';
import type {DB} from '@qgroup/database';
import type {StoredIntent} from '../../apps/api/src/erasure-journal';
import {readRollbackIdentitySource,identitySeconds} from './rollback-identity-source';
import {forwardHash,forwardCanonical,forwardRows} from './forward-board-storage';

const integer=z.string().regex(/^(?:0|[1-9]\d*)$/).refine(value=>BigInt(value)<=9223372036854775807n);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const profile=z.string().regex(/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/);
const snapshot=z.object({id:integer,profileId:profile,sha256:digest}).strict();
const evidenceSchema=z.object({version:z.literal(1),kind:z.literal('forward_source_rebase'),sourcePins:z.record(z.string(),digest),rebasedAt:z.iso.datetime(),
  bindings:z.array(z.object({profileId:profile,legacyKey:z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/),mode:z.enum(['preserved','generated'])}).strict()),
  histories:z.object({music_ownership_history:z.object({cutoff:integer,rows:z.array(snapshot)}).strict(),music_profile_audit:z.object({cutoff:integer,rows:z.array(snapshot)}).strict()}).strict(),
  auditMappings:z.array(z.object({source:z.enum(['ownership','claim']),sourceId:integer,legacyId:integer}).strict())}).strict();
export type SourceRebaseEvidence=z.infer<typeof evidenceSchema>;
export const sourceRebaseDigest=(evidence:SourceRebaseEvidence)=>forwardHash('qgroup:forward-source-rebase:v1:'+JSON.stringify(evidence));
export const sourceRebaseRowDigest=(value:unknown)=>forwardHash(forwardCanonical(value));
/** ID/digest-only evidence, bound to its migration run. Native private history is
 * never copied into a second live archive. Parent verification still requires
 * every original pinned image; this local reader is not external custody proof. */
export function readSourceRebaseEvidence(db:DB,intents?:StoredIntent[]){
  const docs=db.prepare("SELECT position,payload_json FROM music_documents WHERE kind='source_rebase' ORDER BY position").all() as {position:number;payload_json:string}[];
  if(!docs.length){if(db.prepare("SELECT 1 FROM migration_runs WHERE json_extract(manifest_json,'$.kind')='forward_source_rebase'").get())throw Error('Missing source rebase evidence');return null;}
  if(docs.length!==1||docs[0]!.position!==0)throw Error('Ambiguous source rebase evidence');
  const evidence=evidenceSchema.parse(JSON.parse(docs[0]!.payload_json)),run=sourceRebaseDigest(evidence);
  const manifest={version:1,kind:'forward_source_rebase',evidenceSha256:forwardHash(docs[0]!.payload_json),sourcePins:evidence.sourcePins,rebasedAt:evidence.rebasedAt};
  const stored=db.prepare('SELECT manifest_json,created_at FROM migration_runs WHERE source_digest=?').get(run) as {manifest_json:string;created_at:string}|undefined;
  if(!stored||stored.manifest_json!==JSON.stringify(manifest)||stored.created_at!==evidence.rebasedAt)throw Error('Source rebase evidence is not bound to its run');
  const byId=new Map(evidence.bindings.map(row=>[row.profileId,row])),byKey=new Map(evidence.bindings.map(row=>[row.legacyKey,row]));
  if(byId.size!==evidence.bindings.length||byKey.size!==evidence.bindings.length)throw Error('Ambiguous source rebase bindings');
  for(const binding of evidence.bindings){
    if(binding.mode==='generated'&&binding.legacyKey!=='m_'+forwardHash('qgroup:rollback-music-key:v1:'+binding.profileId).slice(0,24))throw Error('Source rebase generated key differs');
    if(!db.prepare('SELECT 1 FROM music_profiles WHERE id=?').get(binding.profileId))throw Error('Missing source rebase profile tombstone');
    const aliases=db.prepare("SELECT legacy_key AS key FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS key FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(binding.profileId,binding.profileId) as {key:string}[];
    if(aliases.some(row=>row.key!==binding.legacyKey))throw Error('Source rebase profile alias differs');
  }
  const authorized=(id:string)=>intents?.some(intent=>'user_id' in intent?false:intent.version===2?intent.profiles.some(row=>row.id===id):intent.kind!=='account'&&intent.profileId===id)??false;
  for(const table of ['music_ownership_history','music_profile_audit'] as const){
    const history=evidence.histories[table],cutoff=BigInt(history.cutoff),snapshots=new Map(history.rows.map(row=>[row.id,row]));
    if(snapshots.size!==history.rows.length||history.rows.some(row=>BigInt(row.id)>cutoff||!byId.has(row.profileId)))throw Error('Invalid source rebase history cutoff');
    const sequence=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').safeIntegers(true).get(table) as {seq:bigint}|undefined;
    if((sequence?.seq??0n)<cutoff)throw Error('Source rebase history high-water rewound');
    const found=new Set<string>();
    for(const row of forwardRows(db,table))if(row.__forward_rowid__<=cutoff){const saved=snapshots.get(String(row.id));if(!saved||saved.profileId!==row.profile_id||saved.sha256!==sourceRebaseRowDigest(row))throw Error('Source rebase frozen history changed');found.add(String(row.id));}
    for(const saved of history.rows)if(!found.has(saved.id)){
      const tombstone=db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(saved.profileId) as {erased_at:string|null}|undefined,binding=byId.get(saved.profileId)!;
      if(!tombstone?.erased_at||!db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(binding.legacyKey)||intents&&!authorized(saved.profileId))throw Error('Source rebase missing history requires verified profile erasure');
    }
  }
  const original=readRollbackIdentitySource(db),used=new Set<string>(),ids=new Set<string>();
  for(const mapping of evidence.auditMappings){const namespace=mapping.source==='ownership'?'music_ownership_history':'music_profile_audit',row=evidence.histories[namespace].rows.find(row=>row.id===mapping.sourceId),key=mapping.source+':'+mapping.sourceId;
    if(!row||used.has(key)||ids.has(mapping.legacyId)||mapping.legacyId==='0'||BigInt(mapping.legacyId)>original.highWater)throw Error('Ambiguous source rebase audit mapping');used.add(key);ids.add(mapping.legacyId);
    const native=db.prepare(`SELECT * FROM ${namespace} WHERE id=?`).safeIntegers(true).get(BigInt(mapping.sourceId)) as Record<string,unknown>|undefined,legacy=original.rows.link_audit.find(item=>item.rowid===BigInt(mapping.legacyId));
    if(!native){if(legacy)throw Error('Erased source rebase audit was restored');continue;}
    const after=mapping.source==='claim'?JSON.parse(String(native.after_json)) as {action?:string;userId?:string|null}:null,before=mapping.source==='claim'?JSON.parse(String(native.before_json)) as {userId?:string|null}:null;
    if(mapping.source==='claim'&&after?.action!=='legacy_claim'||!legacy||legacy.value.qq!==byId.get(row.profileId)!.legacyKey||legacy.value.actor!==(mapping.source==='ownership'?native.actor_ref:'account:'+native.actor_id)||legacy.value.before_user_id!==(mapping.source==='ownership'?native.before_user_id??'':before?.userId??'')||legacy.value.after_user_id!==(mapping.source==='ownership'?native.after_user_id??'':after?.userId??'')||legacy.value.created!==identitySeconds(native.created_at))throw Error('Source rebase mapped legacy audit differs from native history');
  }
  return evidence;
}
