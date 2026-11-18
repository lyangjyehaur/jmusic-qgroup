import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { DomainError, domainErrorDisplay, parseAmount } from '@qgroup/domain';
import { ApiFailure } from '@qgroup/contracts';
import { withApiError } from './error-display';
import { apiFailure } from './error-response';
import { apiFailureError, ApiError } from '../../web/src/api';
import { errorText } from '../../web/src/language';
import { createApp } from './app';
import { collectErrorDisplays, buildErrorDisplays } from '../../../tools/rebuild/build-error-displays';
afterEach(()=>vi.unstubAllGlobals());
it('annotates only explicitly declared system errors without changing identity, stack, status, code or canonical message',()=>{
  const original=new DomainError('NOT_FOUND','找不到活動或尚未公開',404),stack=original.stack;
  const marked=withApiError(new DomainError('NOT_FOUND','找不到活動或尚未公開',404));
  expect(domainErrorDisplay(original)).toBeUndefined();expect(apiFailure(original)).toEqual({code:original.code,message:original.message});
  expect(withApiError(original)).toBe(original);expect(original.stack).toBe(stack);expect(original).toBeInstanceOf(DomainError);
  expect(original.status).toBe(404);expect(original.message).toBe('找不到活動或尚未公開');expect(apiFailure(original)).toEqual(apiFailure(marked));
  const raw='后台發 · 帐号後臺';expect(apiFailure(new DomainError('NOT_FOUND',raw,404))).toEqual({code:'NOT_FOUND',message:raw});
});
it('keeps both current and older error response contracts usable with canonical client exceptions',()=>{
  const raw='后台發 · 帐号後臺',plain=apiFailureError(422,ApiFailure.parse({code:'OLD_API',message:raw}));
  expect(plain).toBeInstanceOf(ApiError);expect(plain.status).toBe(422);expect(plain.code).toBe('OLD_API');
  const payload=apiFailure(withApiError(new DomainError('NOT_FOUND','找不到活動或尚未公開',404))),marked=apiFailureError(404,ApiFailure.parse(payload));
  for(const [language,expected] of [['zh-Hans','找不到活动或尚未公开'],['zh-Hant','找不到活動或尚未公開']]){
    vi.stubGlobal('document',{documentElement:{lang:language}});expect(errorText(marked)).toBe(expected);expect(marked.message).toBe(payload.message);expect(errorText(plain)).toBe(raw);
  }
  expect(ApiFailure.safeParse({code:'BAD_PAIR',message:raw,messageDisplay:{hans:raw}}).success).toBe(false);
});
it('keeps shared domain validation canonical while providing independently compiled web displays',()=>{
  let error:DomainError|undefined;try{parseAmount('not-a-number');}catch(failure){error=failure as DomainError;}
  expect(error).toBeInstanceOf(DomainError);expect(error?.code).toBe('INVALID_AMOUNT');expect(error?.message).toBe('金額最多七位整數、兩位小數，不能為負數');
  vi.stubGlobal('document',{documentElement:{lang:'zh-Hans'}});expect(errorText(error!)).toBe('金额最多七位整数、两位小数，不能为负数');
  expect(apiFailure(error!).message).toBe(error?.message);
});
it('audits exact literal constructors and conditional messages while rejecting runtime or interpolated data',()=>{
  const source="withApiError(new DomainError('CODE',flag?'帳號不符':'資料已更新',status()))";
  expect(collectErrorDisplays(source,'sample.ts','withApiError')).toEqual({count:1,rows:{'["CODE","帳號不符"]':['帐号不符','帳號不符'],'["CODE","資料已更新"]':['资料已更新','資料已更新']}});
  for(const source of ["withApiError(error)","withApiError(new DomainError(code,'資料'))","withApiError(new DomainError('CODE',message))","withApiError(new DomainError('CODE','資料：'+user))","withApiError(new DomainError('CODE',`資料：${user}`))"])
    expect(()=>collectErrorDisplays(source,'sample.ts','withApiError')).toThrow();
  expect(collectErrorDisplays("new DomainError('CODE','帳號')",'sample.ts','withApiError').count).toBe(0);
  expect(()=>buildErrorDisplays(true)).not.toThrow();
});
it('returns both display scripts for actual system/API parsing failures while keeping machine and canonical fields unchanged',async()=>{
  const db=openDatabase(':memory:'),app=createApp({db,origin:'http://localhost:5080'});
  try{
    for(const language of ['zh-CN','zh-Hant-CN']){
      const missing=await app.inject({url:'/api/v2/activities/missing',headers:{'accept-language':language}});
      expect(missing.statusCode).toBe(404);expect(missing.json()).toEqual({code:'NOT_FOUND',message:'找不到活動或尚未公開',messageDisplay:{hans:'找不到活动或尚未公开',hant:'找不到活動或尚未公開'}});
      const invalid=await app.inject({url:'/api/v2/activities?period=unknown',headers:{'accept-language':language}});
      expect(invalid.statusCode).toBe(400);expect(invalid.json()).toMatchObject({code:'INVALID_INPUT',message:'輸入格式不符，請檢查欄位與確認項目',messageDisplay:{hans:'输入格式不符，请检查栏位与确认项目',hant:'輸入格式不符，請檢查欄位與確認項目'}});
      const malformed=await app.inject({method:'POST',url:'/api/v2/activities/drafts',payload:'{',headers:{'content-type':'application/json','accept-language':language}});
      expect(malformed.statusCode).toBe(400);expect(malformed.json()).toMatchObject({code:'INVALID_REQUEST',message:'請求格式不符',messageDisplay:{hans:'请求格式不符',hant:'請求格式不符'}});
    }
    db.exec('DROP TABLE music_selections');
    const failure=await app.inject('/api/v2/music/catalog');expect(failure.statusCode).toBe(500);
    expect(failure.json()).toMatchObject({code:'INTERNAL_ERROR',message:'暫時無法完成操作，請保留選擇後重試',messageDisplay:{hans:'暂时无法完成操作，请保留选择后重试',hant:'暫時無法完成操作，請保留選擇後重試'}});
    expect(failure.body).not.toMatch(/SQLITE|table|stack/);
  }finally{await app.close();db.close();}
});
