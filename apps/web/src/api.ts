import { z } from 'zod';
import { ApiFailure } from '@qgroup/contracts';
import { analyticsRequest } from './analytics';
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const method=init?.method??'GET',fullPath='/api/v2'+path;
  let response:Response;
  try { response = await fetch(fullPath, { credentials: 'same-origin', ...init }); }
  catch(error) { analyticsRequest(fullPath,method,0,'network_error');throw error; }
  let body:unknown;
  try { body=await response.json(); } catch(error) { analyticsRequest(fullPath,method,response.status,'parse_error');throw error; }
  if (!response.ok) {
    const failure = ApiFailure.safeParse(body);
    analyticsRequest(fullPath,method,response.status,'rejected');
    throw new ApiError(response.status, failure.success ? failure.data.code : 'UNKNOWN_ERROR', failure.success ? failure.data.message : '暫時無法讀取資料');
  }
  try { const result=schema.parse(body);analyticsRequest(fullPath,method,response.status,'success');return result; }
  catch(error) { analyticsRequest(fullPath,method,response.status,'parse_error');throw error; }
}
