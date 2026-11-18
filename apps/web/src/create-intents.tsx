import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from 'yahha-ui';
import { CreateIntentResult } from '@qgroup/contracts';
import { api } from './api';
import { authHeaders } from './auth';
import type { Member } from './member-access';
import { Notice, sessionQuery } from './shared';
import { deviceDraftEpoch } from './draft-store';

/** Read the current target without retiring the local draft or replaying a create. */
export function CreateIntentLookup({viewer,kind,intent,disabled=false,validate}:{viewer:Member;kind:'activity'|'poll';intent:string;disabled?:boolean;validate?:()=>Promise<void>}) {
  const client=useQueryClient(),active=useRef(false);
  const [epoch]=useState(()=>validate?Promise.resolve(undefined):deviceDraftEpoch().catch(()=>undefined));
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[result,setResult]=useState<ReturnType<typeof CreateIntentResult.parse>|null>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function current() {
    const fresh=await client.fetchQuery({...sessionQuery,staleTime:0});
    if(!fresh.authenticated||fresh.scope!==viewer.scope)throw Error('帳號已變更，請重新讀取目前帳號。');
    await validate?.();
    if(!validate){const before=await epoch;if(before===undefined)throw Error('無法核對本機原稿世代；請重新載入頁面。');if(await deviceDraftEpoch()!==before)throw Error('此原稿已因登出清除，請重新載入頁面。');}
    return fresh;
  }
  async function check() {
    if(busy||disabled)return;
    setBusy(true);setMessage('');setResult(null);
    try {
      const fresh=await current();if(!active.current)return;
      const found=await api('/me/create-intents/view',CreateIntentResult,{method:'POST',headers:authHeaders(fresh),body:JSON.stringify({kind,intent})});
      await current();if(!active.current)return;
      setResult(found);setMessage(found.state==='missing'?uiText("尚未查到回執，不能據此認定未建立；原稿保留。"):kind==='poll'?uiText("原投票已建立，建立後不能改寫候選；本機後續編輯仍保留。"):uiText("原活動已建立；本機後續編輯仍保留，請開啟原活動核對。"));
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法查詢原結果，請保留原稿。"));}
    finally{if(active.current)setBusy(false);}
  }
  const target=result?.state==='existing'?result:null;
  const path=target?(target.kind==='poll'?'/time-polls/'+encodeURIComponent(target.id):'/activities/'+encodeURIComponent(target.id)+(target.canEdit?(target.route==='draft'?'/edit':'/arrangements'):'')):'';
  return <div className="page-actions"><Button variant="secondary" disabled={disabled||busy} onClick={()=>void check()}>核對原{kind==='activity'?'活動':'投票'}建立識別</Button>{message&&<Notice>{message}</Notice>}{target&&<Link to={path}>開啟原{kind==='activity'?'活動':'投票'}，保留本機原稿</Link>}</div>;
}
