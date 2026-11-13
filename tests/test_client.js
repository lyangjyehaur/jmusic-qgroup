'use strict';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync('public/client.js','utf8')+'\nthis.client=BoardClient;';
let entries=new Map(),committed=new Map(),sent=[],analytics=[],failAfterCommit=false,readFailure=false,writeStatus=200,quota=false;
const copy=v=>v===undefined?undefined:structuredClone(v);
const store={get:async k=>copy(entries.get(k)),put:async(k,v)=>{if(quota)throw new Error('quota');entries.set(k,copy({key:k,...v}));},remove:async k=>entries.delete(k),list:async p=>copy([...entries.values()].filter(v=>v.key.startsWith(p)))};
const response=(status,body)=>({status,ok:status<400,json:async()=>body});
async function fetchFake(path,options){
  const scope=options.headers['X-Kanban-Identity'],key=options.headers['Idempotency-Key'];
  if(path.startsWith('/api/requests/')){if(readFailure)return response(404,{error:'无权访问'});const result=committed.get(scope+path.split('/').pop());return response(200,result?{committed:true,result}:{committed:false});}
  if(options.method==='GET')return response(200,{ok:true});
  sent.push({path,key,scope,data:JSON.parse(options.body)});
  if(writeStatus!==200)return response(writeStatus,{error:'版本冲突'});
  const result={id:'event-1',revision:2};committed.set(scope+key,result);
  if(failAfterCommit){failAfterCommit=false;throw new TypeError('offline');}
  return response(200,result);
}
function page(scope){const box={BoardAnalytics:{request:(...args)=>analytics.push(args)},BoardStore:store,fetch:fetchFake,crypto:webcrypto,TextEncoder,Uint8Array,AbortController,TypeError,setTimeout,clearTimeout};vm.createContext(box);vm.runInContext(source,box);box.client.setIdentity(scope);return box.client;}
(async()=>{
  let a=page('alice');failAfterCommit=true;
  const payload={id:'fixed-record-id',base_revision:1,transaction:{occurred_at:'2026-11-08T12:00:00Z',amount:'20.00'}};
  await assert.rejects(a.request('/api/events/abc/finance','POST',payload),/未能|尚未确认/);
  assert.equal((await a.pending()).length,1);
  assert.deepEqual((await a.pending())[0].data,payload);
  const originalKey=sent[0].key;
  // Refresh: query the committed result before resending. No duplicate transaction.
  a=page('alice');assert.equal((await a.request('/api/events/abc/finance','POST',payload)).id,'event-1');assert.equal(sent.length,1);assert.equal((await a.pending()).length,0);
  // A different identity cannot see or replay an old pending operation.
  failAfterCommit=true;await assert.rejects(a.request('/api/events/abc/finance','POST',{...payload,id:'second'}));
  const pending=(await a.pending())[0],b=page('bob');assert.equal((await b.pending()).length,0);await assert.rejects(b.recover(pending.key,true),/其他/);
  // Explicit safe retry of an uncommitted request preserves its full payload and key.
  committed.delete('alice'+pending.requestKey);const n=sent.length;
  assert.equal((await a.recover(pending.key)).committed,false);assert.equal(sent.length,n);
  assert.equal((await a.recover(pending.key,true)).committed,true);assert.equal(sent.at(-1).key,pending.requestKey);assert.deepEqual(sent.at(-1).data,pending.data);
  // Access failure during query must never fall through to a write.
  failAfterCommit=true;await assert.rejects(a.request('/api/events/abc/finance','POST',{...payload,id:'third'}));readFailure=true;const before=sent.length;
  await assert.rejects(a.request('/api/events/abc/finance','POST',{...payload,id:'third'}),/无权/);assert.equal(sent.length,before);readFailure=false;
  // Server rejection leaves no ambiguous operation and is never auto-rebased.
  writeStatus=409;await assert.rejects(a.request('/api/events/abc/finance','POST',{...payload,id:'conflict'}),/版本/);assert.equal((await a.pending()).some(v=>v.data.id==='conflict'),false);writeStatus=200;
  // Do not send if recovery credentials cannot be persisted.
  quota=true;const count=sent.length;await assert.rejects(a.request('/api/events','POST',{client_intent:'unique'}),/quota/);assert.equal(sent.length,count);quota=false;
  // Concurrent identical submissions share a single in-flight promise.
  const c=page('carol'),at=sent.length;await Promise.all([c.request('/api/events','POST',{client_intent:'one'}),c.request('/api/events','POST',{client_intent:'one'})]);assert.equal(sent.length,at+1);
  // A completed create survives the crash window before the draft is cleared.
  const d=page('carol');await d.request('/api/events','POST',{client_intent:'one'});assert.equal(sent.length,at+1);
  await d.request('/api/events','POST',{client_intent:'two'});assert.equal(sent.length,at+2);assert.notEqual(originalKey,sent.at(-1).key);
  // Poll creation recovers after a lost response and has its own stable namespace.
  const pollClient=page('poll-owner'),pollStart=sent.length;
  failAfterCommit=true;
  await assert.rejects(pollClient.request('/api/time-polls','POST',{client_intent:'poll-draft'}));
  const pollReload=page('poll-owner');
  await pollReload.request('/api/time-polls','POST',{client_intent:'poll-draft'});
  await pollReload.request('/api/time-polls','POST',{client_intent:'poll-draft'});
  assert.equal(sent.length,pollStart+1);
  const pollKey=sent.at(-1).key;
  await pollReload.request('/api/events','POST',{client_intent:'poll-draft'});
  assert.notEqual(sent.at(-1).key,pollKey);
  // Two tabs restoring the same creation draft must use the same server key.
  const e=page('eve'),f=page('eve');await Promise.all([e.request('/api/events','POST',{client_intent:'shared-draft'}),f.request('/api/events','POST',{client_intent:'shared-draft'})]);const shared=sent.filter(v=>v.data.client_intent==='shared-draft');assert.equal(new Set(shared.map(v=>v.key)).size,1);const stable=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('create shared-draft'))).toString('hex');assert.equal(shared[0].key,stable);
  // Repeating the same input after a completed operation is a fresh intent (A → B → A).
  const profile=page('profile'),start=sent.length;
  await profile.request('/api/profile','POST',{nickname:'A'});await profile.request('/api/profile','POST',{nickname:'B'});await profile.request('/api/profile','POST',{nickname:'A'});
  assert.equal(sent.length,start+3);assert.notEqual(sent[start].key,sent[start+2].key);
  assert.ok(analytics.some(([,method,status,outcome])=>method==='POST'&&status===0&&outcome==='network_error'));
  assert.ok(analytics.some(([,method,status,outcome])=>method==='POST'&&status===409&&outcome==='rejected'));
  assert.ok(analytics.some(([path,method,status,outcome])=>path==='/api/profile'&&method==='POST'&&status===200&&outcome==='success'));
  assert.ok(analytics.every(entry=>entry.length===4)); // No request bodies enter analytics.
  console.log('Client recovery assertions passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
