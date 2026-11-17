import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { botStrip, pythonCasefold } from '@qgroup/domain';
import scripts from '../assets/wordlists/traditional_to_simplified.json';
import bundled from '../assets/sensitive_words.json';
export const ABBREVIATION_REPLACEMENT='[已遮蔽]';
type Span=[number,number];
const letters=/[\p{L}\p{N}]/u;
function normalized(text:string){
  const chars:string[]=[],starts:number[]=[],ends:number[]=[];let position=0;
  for(const char of text){for(const value of pythonCasefold(char.normalize('NFKC'))){const key=(scripts.map as Record<string,string>)[value]??value;if(letters.test(key)){chars.push(key);starts.push(position);ends.push(position+char.length);}}position+=char.length;}
  return {chars,starts,ends};
}
function words(value:unknown){
  if(!Array.isArray(value))throw Error('Sensitive words must be an array');const result=new Set<string>();
  for(const word of value){if(typeof word!=='string'||!botStrip(word))throw Error('Invalid sensitive word');const v=normalized(word).chars.join('');if(!v)throw Error('Invalid sensitive word');result.add(v);}
  return [...result].sort();
}
class Automaton {
  readonly edges:Map<string,number>[]=[new Map()];readonly fail:number[]=[0];readonly length:number[]=[0];
  constructor(values:string[]){
    for(const word of values){let state=0;const chars=Array.from(word);for(const char of chars){let child=this.edges[state]!.get(char);if(child===undefined){child=this.edges.length;this.edges[state]!.set(char,child);this.edges.push(new Map());this.fail.push(0);this.length.push(0);}state=child;}this.length[state]=chars.length;}
    const queue=[...this.edges[0]!.values()];for(let index=0;index<queue.length;index++){const state=queue[index]!;for(const [char,child] of this.edges[state]!){let fallback=this.fail[state]!;while(fallback&&!this.edges[fallback]!.has(char))fallback=this.fail[fallback]!;this.fail[child]=this.edges[fallback]!.get(char)??0;this.length[child]=Math.max(this.length[child]!,this.length[this.fail[child]!]!);queue.push(child);}}
  }
  *spans(chars:string[]):Generator<Span>{let state=0;for(let index=0;index<chars.length;index++){const char=chars[index]!;while(state&&!this.edges[state]!.has(char))state=this.fail[state]!;state=this.edges[state]!.get(char)??0;const length=this.length[state]!;if(length)yield [index+1-length,index+1];}}
}
function replace(text:string,spans:Span[]){const parts:string[]=[];let position=0;for(const [start,end] of spans){parts.push(text.slice(position,start),ABBREVIATION_REPLACEMENT);position=end;}return parts.join('')+text.slice(position);}
/** Sparse Aho–Corasick, retaining only the longest suffix per state. */
export class BotWordMask {
  readonly #denied:Automaton;readonly #allowed:Automaton;
  constructor(denied:unknown,allowed:unknown=[]){this.#denied=new Automaton(words(denied));this.#allowed=new Automaton(words(allowed));}
  #spans(text:string):Span[]{
    if(!this.#denied.edges[0]!.size)return [];
    const {chars,starts,ends}=normalized(text),allowed=[...this.#allowed.spans(chars)].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const protectedStarts:number[]=[],protectedEnds:number[]=[];let furthest=0;
    for(const [start,end] of allowed){protectedStarts.push(start);furthest=Math.max(furthest,end);protectedEnds.push(furthest);}
    const result:Span[]=[];
    for(const [start,end] of this.#denied.spans(chars)){
      let low=0,high=protectedStarts.length;while(low<high){const mid=(low+high)>>>1;if(protectedStarts[mid]!<=start)low=mid+1;else high=mid;}
      if(low&&protectedEnds[low-1]!>=end)continue;
      let a=starts[start]!;const b=ends[end-1]!;while(result.length&&a<result.at(-1)![1])a=Math.min(a,result.pop()![0]);result.push([a,b]);
    }
    return result;
  }
  mask(text:string){return replace(text,this.#spans(text));}
  maskParts(parts:readonly string[]){
    const spans=this.#spans(parts.join(''));if(!spans.length)return parts.join('');let position=0,index=0;const result:string[]=[];
    for(const part of parts){const end=position+part.length;while(index<spans.length&&spans[index]![1]<=position)index++;const intersects:Span[]=[];for(let i=index;i<spans.length&&spans[i]![0]<end;i++)intersects.push([Math.max(spans[i]![0],position)-position,Math.min(spans[i]![1],end)-position]);
      result.push([...part].some(char=>letters.test(char.normalize('NFKC')))?replace(part,intersects):part);position=end;}
    return result.join('');
  }
}
/** Explicit constructor; importing does not read files or build either automaton. */
export class BotMaskLoader {
  #key='';#mask?:BotWordMask;
  constructor(readonly options:{extraFile?:string;bundledFile?:string}={}){}
  load(){
    const paths=[...(this.options.bundledFile?[resolve(this.options.bundledFile)]:[]),...(this.options.extraFile?[resolve(this.options.extraFile)]:[])];
    const key=paths.map(path=>{const stat=statSync(path,{bigint:true});if(!stat.isFile())throw Error('Invalid word list file');return path+':'+stat.mtimeNs+':'+stat.ctimeNs+':'+stat.size;}).join('\n');
    if(this.#mask&&this.#key===key)return this.#mask;
    const base:unknown=this.options.bundledFile?JSON.parse(readFileSync(this.options.bundledFile,'utf8')):bundled;
    if(!base||typeof base!=='object'||Array.isArray(base)||!Array.isArray((base as {words:unknown}).words))throw Error('Invalid bundled dictionary');
    const {words:denied,allow_words:allowed=[]}=base as {words:unknown[];allow_words?:unknown};
    const extra:unknown=this.options.extraFile?JSON.parse(readFileSync(this.options.extraFile,'utf8')):[];
    if(!Array.isArray(extra))throw Error('Invalid extra word list');
    const mask=new BotWordMask([...denied,...extra],allowed);this.#key=key;this.#mask=mask;return mask;
  }
}
