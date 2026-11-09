'use strict';
// IndexedDB stores images without the small synchronous localStorage quota.
const BoardStore=(()=>{
  let opening;
  function database() {
    if(!opening)opening=new Promise((resolve,reject)=>{
      const r=indexedDB.open('kanban-local-v1',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('entries',{keyPath:'key'});
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error("無法保存到瀏覽器，請檢查存儲空間或隱私設置"));
      r.onblocked=()=>reject(new Error("瀏覽器存儲暫時被佔用，請關閉舊頁面後重試"));
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function operation(mode,run) {
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('entries',mode),request=run(tx.objectStore('entries'));let result;
      request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(new Error("本機保存失敗，請檢查瀏覽器存儲空間；當前內容尚未安全保存"));
    });
  }
  const get=key=>operation('readonly',s=>s.get(key));
  const put=(key,value)=>operation('readwrite',s=>s.put({key,...value}));
  const remove=key=>operation('readwrite',s=>s.delete(key));
  const list=prefix=>operation('readonly',s=>s.getAll(IDBKeyRange.bound(prefix,prefix+'\uffff')));
  return {get,put,remove,list};
})();
