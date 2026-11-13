'use strict';
const BoardClient=(()=>{
  let scope='',active=new Map();
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
  const prefix=()=>`request:${scope}:`;
  const setIdentity=value=>{scope=value||'';};
  const finish=entry=>['/api/events','/api/time-polls'].includes(entry.path)?BoardStore.put(entry.key,{...entry,status:'done',at:Date.now()}):BoardStore.remove(entry.key);
  async function transport(path,method='GET',data,key,identity=scope) {
    const headers={'X-Kanban-Version':'2'};
    if(identity)headers['X-Kanban-Identity']=identity;
    if(key)headers['Idempotency-Key']=key;
    if(data!==undefined)headers['Content-Type']='application/json';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    let status=0,outcome='network_error';
    try {
      const response=await fetch(path,{method,credentials:'same-origin',headers,body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal});
      status=response.status;outcome=response.ok?'success':'rejected';
      let result;try{result=await response.json();}catch{outcome='invalid_response';throw new Error(data===undefined||path.endsWith('/preview')?"响应无法读取，请重试":"服务器响应无法确认，请先检查待确认操作");}
      if(!response.ok)throw Object.assign(new Error(result.error||"操作失败，请稍后重试"),{status:response.status});
      return result;
    }catch(problem){
      if(problem.name==='AbortError'||problem instanceof TypeError)throw new Error(data===undefined?"网络暂时无法连接，请重试":"操作结果尚未确认，请在消息中的「待确认操作」检查；重试会先查询原结果");
      throw problem;
    }finally{
      clearTimeout(timer);
      try{globalThis.BoardAnalytics?.request(path,method,status,outcome);}catch{}
    }
  }
  async function settle(entry,retry=false) {
    if(!scope||entry.scope!==scope)throw new Error("此操作属于其他浏览器身份，请刷新页面");
    const found=await transport('/api/requests/'+entry.requestKey);
    if(found.committed){await finish(entry);return found;}
    if(!retry)return found;
    try {
      const result=await transport(entry.path,entry.method,entry.data,entry.requestKey,entry.scope);
      await finish(entry);
      return {committed:true,result};
    }catch(problem){
      if(problem.status&&problem.status<500)await BoardStore.remove(entry.key);
      throw problem;
    }
  }
  async function request(path,method='GET',data) {
    if(data===undefined)return transport(path,method,undefined,undefined,path==='/api/me'?'':scope);
    if(!scope)throw new Error("尚未确认浏览器身份，请刷新页面");
    // Previews do not mutate data and their tokens must never be replayed as a new decision.
    if(path.endsWith('/preview'))return transport(path,method,data,random());
    const identity=scope,body=JSON.stringify(data);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(method+' '+path+' '+body));
    const fingerprint=prefix()+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    if(active.has(fingerprint))return active.get(fingerprint);
    const work=(async()=>{
      let entry=await BoardStore.get(fingerprint);
      if(scope!==identity)throw new Error("浏览器身份已改变，请刷新页面");
      if(entry)return (await settle(entry,true)).result;
      const createKey=['/api/events','/api/time-polls'].includes(path)&&data.client_intent?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode((path==='/api/events'?'create ':'create time-poll ')+data.client_intent))),v=>v.toString(16).padStart(2,'0')).join(''):random();
      entry={key:fingerprint,scope:identity,requestKey:createKey,path,method,data,status:'pending',at:Date.now()};
      // Persist the exact ID, timestamp, revision and payload BEFORE sending the write.
      await BoardStore.put(fingerprint,entry);
      try {
        const result=await transport(path,method,data,entry.requestKey,identity);
        await finish(entry);return result;
      }catch(problem){if(problem.status&&problem.status<500)await BoardStore.remove(fingerprint);throw problem;}
    })();
    active.set(fingerprint,work);try{return await work;}finally{active.delete(fingerprint);}
  }
  const pending=async()=>(await BoardStore.list(prefix())).filter(v=>v.status==='pending');
  const recover=async(key,retry=false)=>{
    const entry=await BoardStore.get(key);if(!entry)throw new Error("操作凭证已不存在");
    return settle(entry,retry);
  };
  const hasPending=async(eventId)=> (await pending()).some(v=>v.path===`/api/events/${eventId}`||v.path===`/api/events/${eventId}/finance`||v.path===`/api/events/${eventId}/settlement/detailed`||(eventId==='new'&&v.path==='/api/events'));
  return {request,setIdentity,pending,recover,hasPending};
})();
