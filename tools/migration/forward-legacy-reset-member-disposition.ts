import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {z} from 'zod';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {assertForwardIdentity,musicBytes} from './forward-music-sources';
import {assertForwardImage,forwardHash,type PinnedForwardBytes} from './forward-board-storage';
import {object} from './music-codec';
import {readForwardLegacyResetVault} from './forward-legacy-reset-vault';
import type {LegacyResetIdentityMemberInput} from './forward-legacy-reset-identity-members';

const sha=z.string().regex(/^[a-f0-9]{64}$/),key=z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/),memberKeys=z.array(key).max(100000);
const reference=z.object({bytes:z.string().max(90*1024*1024),sha256:sha}).strict();
const dispositionSchema=z.array(z.object({key,disposition:z.literal('retained_history_only'),
  occurrences:z.array(z.object({sequence:z.number().int().positive().safe(),member:reference,persistedSha256:sha,loadedSha256:sha,completionSourceSha256:sha,authorityRecordSha256:sha,completionSha256:sha}).strict()).min(1).max(1000),
  identityRows:z.array(z.object({table:z.enum(['sessions','links','used_oauth','prelinks','login_attempts','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents']),rowid:z.string().regex(/^-?(?:0|[1-9]\d*)$/)}).strict()).max(100000),
}).strict()).max(100000);
const reportSchema=z.object({version:z.literal(1),authoritySha256:sha,vaultManifestSha256:sha,checkpointSha256:sha,originalMusicSha256:sha,originalIdentitySha256:sha,projectedMusicSha256:sha,
  unloadedResetKeys:memberKeys,recoveredOrCurrentKeys:memberKeys,authorityErasedKeys:memberKeys,retainedHistoryKeys:memberKeys,
  retainedOccurrences:z.number().int().nonnegative().safe(),originalSourcesAndIdentityRetained:z.literal(true),originalMemberValuesTypesAndOrderVerified:z.literal(true),
  currentMembershipUnchanged:z.literal(true),authenticationActive:z.literal(false),nativeDispositionApplied:z.literal(false),latestSourceAncestryVerified:z.literal(false),releaseEligible:z.literal(false)}).strict();
const script=`import base64,json,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_music_identity_members import prepare_identity_members
from tools.migration.rollback_music_reset_member_disposition import encode_retained_reset_members,verify_reset_member_disposition
value=json.loads(sys.stdin.buffer.read())
if value['mode']=='startup':print(json.dumps(dict(bytes=base64.b64encode(prepare_identity_members(base64.b64decode(value['music'],validate=True),base64.b64decode(value['identity'],validate=True),set(value['erased']))).decode())))
elif value['mode']=='extract':print(json.dumps([base64.b64encode(member).decode() for row in value['resets'] for member in encode_retained_reset_members(base64.b64decode(row['source'],validate=True),row['keys'])]))
else:print(json.dumps(verify_reset_member_disposition(value)))
`;
function call(payload:unknown){try{return JSON.parse(execFileSync('python3',['-I','-c',script,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify(payload),encoding:'utf8',timeout:30000,maxBuffer:192*1024*1024,stdio:['pipe','pipe','pipe']}));}catch{throw Error('Original reset member disposition relation failed; retain every private source');}}
const pin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
const encoded=(source:PinnedForwardBytes)=>({bytes:source.bytes.toString('base64'),sha256:source.sha256});
function checked(source:PinnedForwardBytes,maximum:number){if(!source||!Buffer.isBuffer(source.bytes)||source.bytes.length>maximum||!sha.safeParse(source.sha256).success||forwardHash(source.bytes)!==source.sha256)throw Error('Reset member disposition source pin differs');return pin(source.bytes);}
function held(input:LegacyResetIdentityMemberInput,boundary?:()=>void){
  const s={vault:{...input.vault},music:checked(input.music,64*1024*1024),identity:checked(input.identity,512*1024*1024)};
  assertForwardImage(s.identity.bytes);const db=new Database(s.identity.bytes);try{assertForwardIdentity(db);}finally{db.close();}
  const authority=readRollbackErasureAuthority(s.vault.authorityRoot,s.vault.manifestSha256),tree=pinRollbackTree(s.vault.vaultRoot),vault=readForwardLegacyResetVault(s.vault);
  if(!vault.sources.resets.length||!vault.vaultEvidence.allRecordedResetCompletionsPresent)throw Error('Reset member disposition requires every original reset completion');
  const erased=[...new Set(authority.ledgers.music.toString().split('\n').filter(row=>row.trim()).map(row=>key.parse((JSON.parse(row) as {qq:string}).qq)))];
  const resets=vault.sources.resets.map(row=>{const completion=vault.completionSources.find(value=>value.sequence===row.sequence)!;return {sequence:row.sequence,persisted:pin(row.persisted.bytes),loaded:pin(row.loaded.bytes),completion:pin(completion.bytes),authorityRecordSha256:completion.authorityRecordSha256,completionSha256:completion.completionSha256};});
  if(s.music.bytes.length+s.identity.bytes.length+resets.reduce((sum,row)=>sum+row.persisted.bytes.length+row.loaded.bytes.length+row.completion.bytes.length,0)>128*1024*1024)throw Error('Reset member disposition exceeds retained source capacity');
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset member disposition boundary must be synchronous');for(const name of Object.keys(s.vault) as (keyof typeof s.vault)[])if(input.vault[name]!==s.vault[name])throw Error('Reset member disposition vault changed');for(const name of ['music','identity'] as const)if(input[name].sha256!==s[name].sha256||!Buffer.isBuffer(input[name].bytes)||!input[name].bytes.equals(s[name].bytes))throw Error('Reset member disposition source changed');tree.assertUnchanged();authority.assertUnchanged();};
  guard();return {s,resets,erased,checkpointSha256:authority.manifest.checkpointSha256,guard};
}
type ResetSources=ReturnType<typeof held>['resets'];
export type LegacyResetMemberDispositionBundle={projectedMusic:PinnedForwardBytes;retainedMusic:PinnedForwardBytes;retainedIdentity:PinnedForwardBytes;retainedResets:ResetSources;dispositions:z.infer<typeof dispositionSchema>;report:z.infer<typeof reportSchema>};
function serializedResets(resets:ResetSources){return resets.map(row=>({...row,persisted:encoded(checked(row.persisted,64*1024*1024)),loaded:encoded(checked(row.loaded,64*1024*1024)),completion:encoded(checked(row.completion,64*1024*1024))}));}
function relation(h:ReturnType<typeof held>,bundle:Omit<LegacyResetMemberDispositionBundle,'report'>){
  const report=reportSchema.parse(call({mode:'verify',authoritySha256:h.s.vault.manifestSha256,vaultManifestSha256:h.s.vault.vaultManifestSha256,checkpointSha256:h.checkpointSha256,music:encoded(h.s.music),identity:encoded(h.s.identity),erased:h.erased,
    projectedMusic:encoded(checked(bundle.projectedMusic,64*1024*1024)),retainedMusic:encoded(checked(bundle.retainedMusic,64*1024*1024)),retainedIdentity:encoded(checked(bundle.retainedIdentity,512*1024*1024)),
    resets:serializedResets(h.resets),retainedResets:serializedResets(bundle.retainedResets),dispositions:dispositionSchema.parse(bundle.dispositions)}));
  h.guard();return report;
}
/** Private recovery artifact only. Lost payloads stay outside current membership;
 * every original snapshot and surviving identity row remains independently pinned.
 * Native disposition, source ancestry and activation are separate requirements. */
export function prepareForwardLegacyResetMemberDisposition(input:LegacyResetIdentityMemberInput,boundary?:()=>void):LegacyResetMemberDispositionBundle{
  const h=held(input,boundary),raw=z.object({bytes:z.string().max(90*1024*1024)}).strict().parse(call({mode:'startup',music:h.s.music.bytes.toString('base64'),identity:h.s.identity.bytes.toString('base64'),erased:h.erased})),bytes=Buffer.from(raw.bytes,'base64');if(bytes.toString('base64')!==raw.bytes)throw Error('Reset member startup encoding differs');
  const projectedMusic=pin(bytes),current=object(object(musicBytes(bytes),'reset member startup').members,'reset member current members'),erased=new Set(h.erased),occurrences:{key:string;reset:ResetSources[number]}[]=[];
  for(const reset of h.resets){const persisted=object(object(musicBytes(reset.persisted.bytes),'reset persisted').members,'reset persisted members'),loaded=object(object(musicBytes(reset.loaded.bytes),'reset loaded').members,'reset loaded members');for(const memberKey of Object.keys(persisted))if(!Object.hasOwn(loaded,memberKey)&&!Object.hasOwn(current,memberKey)&&!erased.has(memberKey))occurrences.push({key:key.parse(memberKey),reset});}
  if(occurrences.length>100000)throw Error('Reset member disposition occurrence capacity exceeded');
  const extracts=z.array(z.string().max(90*1024*1024)).max(100000).parse(call({mode:'extract',resets:h.resets.map(reset=>({source:reset.persisted.bytes.toString('base64'),keys:occurrences.filter(row=>row.reset===reset).map(row=>row.key)}))}));if(extracts.length!==occurrences.length||extracts.reduce((sum,row)=>sum+row.length,0)>90*1024*1024)throw Error('Reset member extraction inventory or capacity differs');
  const rows=new Map<string,z.infer<typeof dispositionSchema>[number]>(),db=new Database(h.s.identity.bytes);
  try{for(const [index,{key:memberKey,reset}] of occurrences.entries()){
    let row=rows.get(memberKey);if(!row){row={key:memberKey,disposition:'retained_history_only',occurrences:[],identityRows:[]};rows.set(memberKey,row);for(const table of ['sessions','links','used_oauth','prelinks','login_attempts','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents'] as const){if(!(db.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).some(column=>column.name==='qq'))continue;for(const item of db.prepare(`SELECT rowid AS id FROM "${table}" WHERE qq=? ORDER BY rowid`).safeIntegers(true).all(memberKey) as {id:bigint}[])row.identityRows.push({table,rowid:String(item.id)});}}
    const raw=extracts[index]!,memberBytes=Buffer.from(raw,'base64');if(memberBytes.toString('base64')!==raw)throw Error('Retained reset member encoding differs');
    row.occurrences.push({sequence:reset.sequence,member:encoded(pin(memberBytes)),persistedSha256:reset.persisted.sha256,loadedSha256:reset.loaded.sha256,completionSourceSha256:reset.completion.sha256,authorityRecordSha256:reset.authorityRecordSha256,completionSha256:reset.completionSha256});
  }}finally{db.close();}
  const bundle={projectedMusic,retainedMusic:pin(h.s.music.bytes),retainedIdentity:pin(h.s.identity.bytes),retainedResets:h.resets,dispositions:[...rows.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
  const report=relation(h,bundle);h.guard();return {...bundle,report};
}
/** Does not rerun the writer or Store. Originals determine every source byte,
 * missing member, historical field, credential reference and disposition. */
export function verifyForwardLegacyResetMemberDisposition(input:LegacyResetIdentityMemberInput,bundle:LegacyResetMemberDispositionBundle,boundary?:()=>void){
  const fingerprint=()=>JSON.stringify({...bundle,projectedMusic:encoded(bundle.projectedMusic),retainedMusic:encoded(bundle.retainedMusic),retainedIdentity:encoded(bundle.retainedIdentity),retainedResets:serializedResets(bundle.retainedResets)}),original=fingerprint();
  const h=held(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset member disposition boundary must be synchronous');if(fingerprint()!==original)throw Error('Reset member disposition output changed');});
  const report=relation(h,bundle);if(JSON.stringify(reportSchema.parse(bundle.report))!==JSON.stringify(report))throw Error('Reset member disposition report differs');h.guard();return report;
}
