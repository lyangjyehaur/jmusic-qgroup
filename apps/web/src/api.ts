import { z } from 'zod';
import { displayError } from './language';
import { createWebHttpClient } from './http';
import { resolveApiRequest } from './http-path';
export { ApiError, apiFailureError } from './api-errors';

function request(path: string, init?: RequestInit) {
  try { return resolveApiRequest(path, init); }
  catch (error) {
    throw error instanceof Error ? displayError(error, '操作資料無法驗證，請核對原操作後再繼續。') : error;
  }
}

/** Existing path callers share the same transport as fixed operation callers.
 * Callers retain their drafts, request IDs, result schemas and recovery flows. */
export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const resolved = request(path, init);
  return createWebHttpClient({ context: () => resolved.context }).request(resolved.key, resolved.input, schema);
}

/** Keep successful attachment bodies as streams; the caller checks MIME and
 * authority before creating a visible image or a downloadable object URL. */
export async function apiRaw(path: string, init?: RequestInit): Promise<Response> {
  const resolved = request(path, init);
  return createWebHttpClient({ context: () => resolved.context }).requestRaw(resolved.key, resolved.input);
}
