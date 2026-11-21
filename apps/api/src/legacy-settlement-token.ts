import type { DB } from '@qgroup/database';
import type { EventRow } from './activity-arrangements';
import { canonicalSettlement, type Invoice } from './settlement-calculation';
import { originalJSON } from './legacy-local';
import { hash } from './security';
// JSON.parse source context is available in the pinned Node 22 runtime. Preserve
// Python's integer/float distinction in stored conditions, including 2 versus 2.0.
class OriginalNumber { constructor(readonly wire:string){} }
function parseStored(value:string):unknown {
  return JSON.parse(value, ((key:string,v:unknown,context?:{source:string})=>{
    void key; return typeof v==='number'&&context?.source?new OriginalNumber(context.source):v;
  }) as Parameters<typeof JSON.parse>[1]);
}
function numericJSON(value:unknown):string{
  if(value instanceof OriginalNumber){
    if(!/[.e]/i.test(value.wire))return BigInt(value.wire).toString();
    const n=Number(value.wire);if(!Number.isFinite(n))throw Error('Nonfinite original condition number');
    if(Object.is(n,-0))return '-0.0';
    const abs=Math.abs(n);
    if(abs>=1e16||abs!==0&&abs<1e-4)return n.toExponential().replace(/e([+-])(\d+)$/,(_,sign:string,digits:string)=>'e'+sign+digits.padStart(2,'0'));
    const wire=JSON.stringify(n);return !/[.e]/i.test(wire)?wire+'.0':wire;
  }
  if(typeof value==='bigint')return value.toString();
  if(Array.isArray(value))return '['+value.map(numericJSON).join(', ')+']';
  if(value&&typeof value==='object'){
    const compare=(a:string,b:string)=>{const aa=Array.from(a,c=>c.codePointAt(0)!),bb=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(aa.length,bb.length);i++)if(aa[i]!==bb[i])return aa[i]!-bb[i]!;return aa.length-bb.length;};
    return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>compare(a,b)).map(([k,v])=>originalJSON(k)+': '+numericJSON(v)).join(', ')+'}';
  }
  return originalJSON(value);
}
export function originalSettlementToken(db:DB,event:EventRow,snapshot:Invoice,version:number){
  const rows=db.prepare('SELECT version,snapshot_json FROM event_conditions WHERE event_id=?').all(event.id) as {version:number;snapshot_json:string}[];
  const conditions=new Map(rows.map(row=>[row.version,row.snapshot_json]));
  const people=snapshot.people.map(p=>{
    const raw=conditions.get(p.accepted_conditions_version!);
    if(!raw||!p.accepted_arrangement)return p;
    // Extra or changed fields are not silently included in a different proof.
    if(canonicalSettlement(JSON.parse(raw))!==canonicalSettlement(p.accepted_arrangement))throw Error('Original condition snapshot differs from the calculated view');
    return {...p,accepted_arrangement:parseStored(raw)};
  });
  return hash(numericJSON({snapshot:{...snapshot,people,journal_seq:BigInt(snapshot.journal_seq)},revision:event.revision,version}));
}
