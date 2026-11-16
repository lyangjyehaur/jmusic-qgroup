import { z } from 'zod';
import { ApiFailure } from '@qgroup/contracts';
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/v2' + path, { credentials: 'same-origin', ...init });
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = ApiFailure.safeParse(body);
    throw new ApiError(response.status, failure.success ? failure.data.code : 'UNKNOWN_ERROR', failure.success ? failure.data.message : '暫時無法讀取資料');
  }
  return schema.parse(body);
}
