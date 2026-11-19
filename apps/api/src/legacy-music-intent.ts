import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parseJson} from '../../../packages/runtime/src/strict-json';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
// The original Python reader has a four-digit, positive year range. Keep both
// validators on the same range rather than accepting JS-only extended dates.
const recordedIso=z.iso.datetime().refine(value=>!value.startsWith('0000-'));
const origin=z.object({authoritySha256:sha,checkpointSha256:sha,recordSequence:z.number().int().positive().safe(),recordSha256:sha,suffixSha256:sha,rowIndex:z.number().int().nonnegative().safe(),sourceRebaseSha256:sha.nullable()}).strict();
const core=z.object({version:z.literal(3),kind:z.literal('legacy_music'),profileId:z.string().regex(/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/),legacyKey:z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/),createdAt:recordedIso,originalErasedAtJson:z.string().min(1).max(128),origin}).strict();
type Core=z.infer<typeof core>;
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
export const legacyMusicMarker=(value:Core)=>'legacy-music:'+createHash('sha256').update('qgroup:imported-legacy-music:v1:'+canonical(core.parse(value))).digest('hex');
/** Imported original-service intent, not a native user request. The original
 * authority record/bytes remain externally retained; this deterministic marker
 * has no secret, account owner or manufactured native privacy receipt. */
export const ImportedLegacyMusicIntent=core.extend({markerId:z.string().regex(/^legacy-music:[a-f0-9]{64}$/)}).strict().superRefine((entry,ctx)=>{
  const {markerId,...value}=entry;
  const checked=core.safeParse(value);
  if(!checked.success)return;
  if(markerId!==legacyMusicMarker(checked.data))ctx.addIssue({code:'custom',message:'Legacy music marker differs from original import scope'});
  try{
    const raw=parseJson(entry.originalErasedAtJson);
    const stamp=typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw*1000<253402300800000?new Date(raw*1000).toISOString():typeof raw==='string'&&recordedIso.safeParse(raw).success?raw:null;
    if(stamp!==entry.createdAt||JSON.stringify(raw)!==entry.originalErasedAtJson)throw Error();
  }catch{ctx.addIssue({code:'custom',message:'Legacy music timestamp differs from original recorded value'});}
});
export type ImportedLegacyMusic=z.infer<typeof ImportedLegacyMusicIntent>;
export const importedLegacyMusicIntent=(value:Core):ImportedLegacyMusic=>ImportedLegacyMusicIntent.parse({...value,markerId:legacyMusicMarker(value)});
