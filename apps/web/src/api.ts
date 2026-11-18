import { z } from 'zod';
import { ApiFailure } from '@qgroup/contracts';
import { analyticsRequest } from './analytics';
import { displayError, withErrorText } from './language';
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export function apiFailureError(status:number,failure:z.infer<typeof ApiFailure>) {
  const error=new ApiError(status,failure.code,failure.message),pair=failure.messageDisplay;
  return pair?withErrorText(error,pair.hans,pair.hant):error;
}
export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const method=init?.method??'GET',fullPath='/api/v2'+path;
  let response:Response;
  try { response = await fetch(fullPath, { credentials: 'same-origin', ...init }); }
  catch(error) { analyticsRequest(fullPath,method,0,'network_error');throw error instanceof Error?displayError(error,'連線未完成，請先核對結果後重試。'):error; }
  let body:unknown;
  try { body=await response.json(); } catch(error) { analyticsRequest(fullPath,method,response.status,'parse_error');throw error instanceof Error?displayError(error,'伺服器回應無法讀取，請先核對結果後重試。'):error; }
  if (!response.ok) {
    const failure = ApiFailure.safeParse(body);
    analyticsRequest(fullPath,method,response.status,'rejected');
    if (failure.success) throw apiFailureError(response.status, failure.data);
    throw new ApiError(response.status, 'UNKNOWN_ERROR', '暫時無法讀取資料');
  }
  try { const result=schema.parse(body);analyticsRequest(fullPath,method,response.status,'success');return result; }
  catch(error) { analyticsRequest(fullPath,method,response.status,'parse_error');throw error instanceof z.ZodError?displayError(error,'回應資料格式不符，請先核對結果後重試。'):error; }
}
