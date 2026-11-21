import { z } from 'zod';
import { createHttpClient, HttpApiError, HttpProtocolError, HttpScopeChangedError, type HttpContext, type HttpInput, type HttpJsonKey, type HttpResult, HttpOperations } from '@qgroup/contracts/http';
import { ApiError, apiFailureError } from './api-errors';
import { analyticsRequest } from './analytics';
import { displayError } from './language';

type Key = keyof typeof HttpOperations;
type Client = ReturnType<typeof createHttpClient>;

export const scopedHttp = (scope: string) => createWebHttpClient({ context: () => ({ scope }) });

/** Keep the UI's error and analytics boundaries around the shared transport.
 * Drafts, request identity, permission checks and recovery stay with the caller. */
export function createWebHttpClient(options: { fetch?: typeof fetch; context?: () => HttpContext } = {}) {
  async function run<T>(key: Key, job: (client: Client) => Promise<T>): Promise<T> {
    // Each request owns its observation, including concurrent list/review reads.
    let started = false, response: Response | undefined;
    const client = createHttpClient({ context: options.context, fetch: async (url, init) => {
      started = true;
      response = await (options.fetch ?? globalThis.fetch)(url, init);
      return response;
    } });
    const operation = HttpOperations[key];
    try {
      const value = await job(client);
      analyticsRequest(operation.path, operation.method, response!.status, 'success');
      return value;
    } catch (error) {
      if (started) analyticsRequest(operation.path, operation.method, response?.status ?? 0,
        error instanceof HttpApiError ? 'rejected' : response ? 'parse_error' : 'network_error');
      if (error instanceof HttpApiError) throw apiFailureError(error.status, error);
      if (error instanceof HttpScopeChangedError) throw displayError(new ApiError(409, error.code, error.message), '操作身分已變更，請核對原操作結果再繼續。');
      if (error instanceof Error) {
        if (!started) throw displayError(error, '操作資料無法驗證，請核對原操作後再繼續。');
        if (!response) throw displayError(error, '連線未完成，請先核對結果後重試。');
        if (error instanceof HttpProtocolError && error.reason === 'unreadable-json') {
          const original = 'cause' in error ? error.cause : error;
          throw original instanceof Error ? displayError(original, '伺服器回應無法讀取，請先核對結果後重試。') : original;
        }
        if (error instanceof z.ZodError) throw displayError(error, '回應資料格式不符，請先核對結果後重試。');
        throw displayError(error, '回應資料尚未核對，請先確認操作結果再重試。');
      }
      throw error;
    }
  }
  return {
    requestContract<K extends HttpJsonKey>(key: K, input: HttpInput<K>): Promise<HttpResult<K>> {
      return run(key, client => client.requestContract(key, input));
    },
    requestNarrowed<K extends HttpJsonKey,T extends HttpResult<K>>(key: K, input: HttpInput<K>, schema: z.ZodType<T>): Promise<T> {
      return run(key, client => client.requestNarrowed(key, input, schema));
    },
    request<K extends Key, T>(key: K, input: HttpInput<K>, schema: z.ZodType<T>): Promise<T> {
      return run(key, client => client.request(key, input, schema));
    },
    requestRaw<K extends Key>(key: K, input: HttpInput<K>): Promise<Response> {
      return run(key, client => client.requestRaw(key, input));
    },
  };
}
