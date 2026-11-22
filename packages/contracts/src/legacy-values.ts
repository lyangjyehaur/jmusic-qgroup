/** Python str.strip() excludes BOM; JavaScript trim()/\s would change original user content. */
export const originalString=(value:unknown)=>typeof value==='string'?value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,''):value;
export function originalCreationKey(intent:unknown,kind:'activity'|'poll',digest:(text:string)=>string){
 if(!intent)return undefined;
 if(!['string','number','boolean'].includes(typeof intent))throw Error('原建立識別格式尚未支援；原請求保留。');
 return digest((kind==='activity'?'create ':'create time-poll ')+String(intent));
}
