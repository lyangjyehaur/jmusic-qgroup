/** Tagged tree retains undefined fields, property order, -0 and embedded image strings.
 * Real BoardStore captures are plain structured values. Unsupported types remain in source. */
export function encodeLegacy(value:unknown):unknown{
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
  if(typeof value==='number'&&Number.isFinite(value))return ['number',Object.is(value,-0)?'-0':String(value)];
  if(Array.isArray(value))return ['array',Array.from({length:value.length},(_,i)=>i in value?encodeLegacy(value[i]):['hole'])];
  if(typeof value==='object'&&value&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))return ['object',Object.entries(value).map(([key,item])=>[key,encodeLegacy(item)])];
  throw Error('舊紀錄包含未支援的資料類型；原儲存保留，不能轉換或發布。');
}
export function legacyRaw(value:unknown){return JSON.stringify({format:'kanban-local-v1-preserved',version:1,source:encodeLegacy(value)});}
