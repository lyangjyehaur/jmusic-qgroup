import type { BotWordMask } from './word-mask';
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
/** Only the renderer creates field boundaries; candidate punctuation cannot. */
export class AbbreviationText {
  readonly sections:readonly string[];
  constructor(sections:readonly string[]){this.sections=sections.filter(Boolean);}
  toString(){return this.sections.join('');}
  sectionEnds(){let size=0;return this.sections.map(section=>size+=Buffer.byteLength(section));}
  static remaining(data:Uint8Array,offset:number,ends?:unknown){
    if(ends===undefined)return new AbbreviationText([decoder.decode(data)]);
    if(!Array.isArray(ends)||!ends.length||ends.at(-1)!==offset+data.byteLength||ends.some((end,index)=>!Number.isSafeInteger(end)||end<=(index?ends[index-1]:0)))throw Error('Invalid result boundaries');
    let start=0;const sections:string[]=[];for(const end of ends){if(end>offset)sections.push(decoder.decode(data.subarray(Math.max(start-offset,0),end-offset)));start=end;}return new AbbreviationText(sections);
  }
}
export function maskAbbreviationText(text:string|AbbreviationText,mask:BotWordMask){
  return new AbbreviationText((text instanceof AbbreviationText?text.sections:[text]).map(section=>mask.maskParts(section.split(/([、\n])/))));
}
