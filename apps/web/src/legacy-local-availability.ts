import { deviceDraftEpoch } from './draft-store';
import { describeLegacy,legacyBlocks } from './legacy-local-record';
import { preserveLegacy } from './legacy-local-store';
/** Check immediately before creating a new pending operation, without trapping a saved retry. */
export async function requireLegacyAvailable(scope:string,path:string){
  const inventory=await preserveLegacy(scope),epoch=await deviceDraftEpoch();
  const mapped=new Set(inventory.mappings.filter(m=>m.deviceEpoch===epoch).map(m=>m.id));
  if(inventory.rows.some(row=>!mapped.has(row.id)&&legacyBlocks(describeLegacy(row.source,scope),path)))throw Error('有後續舊看板原稿或請求，尚未送出；請先到「舊看板本機紀錄」核對。');
}
