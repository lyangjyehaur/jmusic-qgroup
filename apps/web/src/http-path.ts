import { HttpOperations, type HttpContext, type HttpInput } from '@qgroup/contracts/http';

type Key = keyof typeof HttpOperations;
const operations = (Object.keys(HttpOperations) as Key[]).sort((a, b) =>
  (HttpOperations[a].path.match(/:/g)?.length ?? 0) - (HttpOperations[b].path.match(/:/g)?.length ?? 0) ||
  HttpOperations[b].path.length - HttpOperations[a].path.length);
const allowedHeaders = new Set(['accept', 'content-type', 'x-account-scope', 'x-csrf-token', 'x-admin-csrf', 'x-admin-scope', 'idempotency-key']);

/** Temporary path boundary for existing callers. The shared client remains
 * responsible for validating the resolved route, body, query and identity.
 * New calls should use its fixed operation keys and HttpInput types directly. */
export function resolveHttpPath(path: string, method = 'GET') {
  if (!path.startsWith('/api/v2/') || /[#\x00-\x20\\]/.test(path)) throw new TypeError('Invalid HTTP path');
  const split = path.indexOf('?'), pathname = split < 0 ? path : path.slice(0, split), parts = pathname.split('/');
  const query = new URLSearchParams(split < 0 ? '' : path.slice(split + 1));
  for (const key of operations) {
    const operation = HttpOperations[key], expected = operation.path.split('/');
    if (operation.method !== method.toUpperCase() || expected.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < expected.length; index++) {
      const segment = expected[index]!, actual = parts[index]!;
      if (segment.startsWith(':')) {
        let decoded: string;
        try { decoded = decodeURIComponent(actual); } catch { throw new TypeError('Invalid HTTP route encoding'); }
        if (!decoded || decoded === '.' || decoded === '..') throw new TypeError('Invalid HTTP route parameter');
        params[segment.slice(1)] = decoded;
      } else if (actual !== segment) { matches = false; break; }
    }
    if (!matches) continue;
    // Fastify presents repeated query fields as arrays. Validated schemas must
    // reject those; ignored queries retain their original ignored semantics.
    if (operation.query && [...query.keys()].some(name => query.getAll(name).length > 1)) throw new TypeError('Repeated HTTP query parameter');
    return { key, params, query: Object.fromEntries(query) };
  }
  throw new TypeError('Unknown HTTP operation');
}

export function resolveApiRequest(path: string, init?: RequestInit) {
  if (Object.keys(init ?? {}).some(name => !['method', 'headers', 'body', 'signal', 'cache'].includes(name))) throw new TypeError('Unexpected API request option');
  if (init?.cache !== undefined && init.cache !== 'no-store') throw new TypeError('Invalid HTTP cache option');
  const resolved = resolveHttpPath('/api/v2' + path, init?.method), headers = new Headers(init?.headers);
  if ([...headers.keys()].some(name => !allowedHeaders.has(name))) throw new TypeError('Unexpected API request header');
  const mediaType = headers.get('content-type');
  if (mediaType && mediaType.toLowerCase() !== 'application/json') throw new TypeError('API requests require JSON');
  const accept = headers.get('accept');
  if (accept && accept !== 'application/json') throw new TypeError('API responses require JSON');
  const context: HttpContext = {}, fields = {
    scope: 'x-account-scope', csrf: 'x-csrf-token', adminCsrf: 'x-admin-csrf', adminScope: 'x-admin-scope',
  } as const;
  for (const [field, header] of Object.entries(fields)) {
    const value = headers.get(header);
    if (value !== null) context[field as keyof typeof fields] = value;
  }
  const input: Record<string, unknown> = { params: resolved.params, query: resolved.query };
  if (init?.signal) input.signal = init.signal;
  if (init?.cache) input.cache = init.cache;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string') throw new TypeError('API request body must be serialized JSON');
    input.body = JSON.parse(init.body);
  }
  const requestId = headers.get('idempotency-key');
  if (requestId !== null) {
    input.requestId = requestId;
    input.requestScope = context.scope;
  }
  // One dynamic boundary, validated by createHttpClient before fetch. This
  // assertion does not claim static operation/input typing for the old callers.
  return { key: resolved.key, input: input as HttpInput<Key>, context };
}
