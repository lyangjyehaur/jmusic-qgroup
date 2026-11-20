import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DB} from './index';

const sha=z.string().regex(/^[a-f0-9]{64}$/),profile=z.string().regex(/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/),legacyKey=z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/);
export const musicRetirementSchema=z.object({version:z.literal(1),kind:z.literal('legacy_reset_removed'),profileId:profile,legacyKey,runSha256:sha,retiredAt:z.iso.datetime(),
  originalProfileSha256:sha,occurrences:z.array(z.object({sequence:z.number().int().positive().safe(),memberSha256:sha,authorityRecordSha256:sha,completionSha256:sha}).strict()).min(1).max(1000)}).strict();
export type MusicRetirement=z.infer<typeof musicRetirementSchema>;
export const musicRetirementManifestSchema=z.object({version:z.literal(1),kind:z.literal('forward_reset_member_retirement'),sourcePins:z.record(z.string(),sha),retiredAt:z.iso.datetime(),
  profiles:z.array(musicRetirementSchema.omit({runSha256:true})).max(100000)}).strict();
export const musicRetirementDigest=(manifest:z.infer<typeof musicRetirementManifestSchema>)=>createHash('sha256').update('qgroup:forward-reset-member-retirement:v1:'+JSON.stringify(manifest)).digest('hex');
/** Current membership excludes reset removals; privacy erasure remains separate.
 * Alias is controlled code, never a request value. Raw history stays in storage. */
export function musicProfileActiveSQL(alias='p'){
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))throw Error('Invalid music profile SQL alias');
  return `${alias}.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM music_documents mr WHERE mr.kind='profile_retirement' AND json_extract(mr.payload_json,'$.profileId')=${alias}.id)`;
}
/** A local binding check, not source custody or activation permission. A removed
 * marker needs a real profile tombstone and erasure key, never an empty report. */
export function readMusicRetirements(db:DB){
  const documents=db.prepare("SELECT payload_json FROM music_documents WHERE kind='profile_retirement' ORDER BY position").all() as {payload_json:string}[],rows=documents.map(row=>musicRetirementSchema.parse(JSON.parse(row.payload_json))),byId=new Map(rows.map(row=>[row.profileId,row]));
  if(byId.size!==rows.length||new Set(rows.map(row=>row.legacyKey)).size!==rows.length)throw Error('Ambiguous music retirement');
  const found=new Set<string>();
  for(const run of db.prepare("SELECT source_digest,manifest_json,created_at FROM migration_runs WHERE json_extract(manifest_json,'$.kind')='forward_reset_member_retirement' ORDER BY rowid").all() as {source_digest:string;manifest_json:string;created_at:string}[]){
    const manifest=musicRetirementManifestSchema.parse(JSON.parse(run.manifest_json));if(musicRetirementDigest(manifest)!==run.source_digest||manifest.retiredAt!==run.created_at)throw Error('Music retirement run binding differs');
    for(const item of manifest.profiles){const row=byId.get(item.profileId),p=db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(item.profileId) as {user_id:string|null;erased_at:string|null}|undefined;
      if(!p)throw Error('Missing retired music profile');
      if(!row){if(!p.erased_at||!db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(item.legacyKey))throw Error('Missing music retirement requires verified erasure');continue;}
      const expected=musicRetirementSchema.parse({...item,runSha256:run.source_digest});
      if(found.has(item.profileId)||JSON.stringify(row)!==JSON.stringify(expected))throw Error('Music retirement evidence differs');
      if(p.user_id!==null||p.erased_at!==null)throw Error('Retired music ownership or erasure differs');found.add(item.profileId);
    }
  }
  if(found.size!==rows.length)throw Error('Unbound music retirement marker');return rows;
}
