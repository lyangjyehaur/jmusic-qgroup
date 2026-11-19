/** Preserve every selected source's order. Independent additions have no
 * authoritative cross-source timestamp order; use native then old discovery
 * order without inferring chronology. Opposed concurrent orders reject. */
export function mergeForwardOrder(base:string[],native:string[],old:string[],present:ReadonlySet<string>){
  const filter=(list:string[])=>list.filter(id=>present.has(id)),b=filter(base),n=filter(native),o=filter(old),same=(a:string[],b:string[])=>JSON.stringify(a)===JSON.stringify(b);
  const selected=same(o,b)?[n]:same(n,b)?[o]:[n,o],discovery=[...new Set([...b,...n,...o])],edges=new Map(discovery.map(id=>[id,new Set<string>()])),incoming=new Map(discovery.map(id=>[id,0]));
  for(const list of selected)for(let i=1;i<list.length;i++){const before=list[i-1]!,after=list[i]!;if(!edges.get(before)!.has(after)){edges.get(before)!.add(after);incoming.set(after,incoming.get(after)!+1);}}
  const result:string[]=[];
  while(result.length<discovery.length){const next=discovery.find(id=>incoming.get(id)===0);if(next===undefined)throw Error('Forward music source order conflict');result.push(next);incoming.set(next,-1);for(const target of edges.get(next)!)incoming.set(target,incoming.get(target)!-1);}
  if(result.length!==present.size)throw Error('Incomplete forward music source order');return result;
}
