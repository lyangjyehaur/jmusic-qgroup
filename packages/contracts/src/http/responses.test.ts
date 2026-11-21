import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createHttpClient, HttpProtocolError, HttpResponses, type HttpResult } from './client';

it('infers and validates the response from the fixed operation without accepting a caller-selected schema', async () => {
  const client = createHttpClient({ fetch: async () => new Response('{"nickname":"原文字","revision":3}') });
  const result = await client.requestContract('GET /api/v2/me/profile', {});
  expectTypeOf(result).toEqualTypeOf<{ nickname: string; revision: number }>();
  expect(result).toEqual({ nickname: '原文字', revision: 3 });
  const invalid = createHttpClient({ fetch: async () => new Response('{"nickname":7,"revision":3}') });
  await expect(invalid.requestContract('GET /api/v2/me/profile', {})).rejects.toBeInstanceOf(z.ZodError);
});
it('keeps nullable reads separate from successful profile writes in the inferred types', async () => {
  expectTypeOf<null>().toExtend<HttpResult<'GET /api/v2/me/music'>>();
  expectTypeOf<null>().not.toExtend<HttpResult<'PUT /api/v2/me/music'>>();
  const client = createHttpClient({ fetch: async () => new Response('null') });
  expect(await client.requestContract('GET /api/v2/me/music', {})).toBeNull();
});
it.each(['GET /api/v2/appearance/walls/:id/image', 'GET /api/v2/admin/music-export', 'GET /api/v2/unknown'])('rejects a non-JSON or unknown structured operation before transport (%s)', async key => {
  let calls = 0;const client = createHttpClient({ fetch: async () => { calls++;return new Response('{}'); } });
  await expect(client.requestContract(key as never, { params: { id: 'synthetic' } } as never)).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
it('retains the original unreadable-JSON cause and does not replay a structured operation', async () => {
  const original = new SyntaxError('original parse failure');let calls = 0;
  const client = createHttpClient({ fetch: async () => { calls++;const response = new Response('not JSON');response.json = async () => { throw original; };return response; } });
  const error = await client.requestContract('GET /api/v2/me/profile', {}).catch(error => error);
  expect(error).toBeInstanceOf(HttpProtocolError);expect(error.cause).toBe(original);expect(calls).toBe(1);
});
it('keeps success binding metadata immutable', () => {
  expect(Object.isFrozen(HttpResponses)).toBe(true);expect(Object.isFrozen(HttpResponses['GET /api/v2/me/profile'])).toBe(true);
  expect(Reflect.set(HttpResponses['GET /api/v2/me/profile'], 'schemaName', 'weaker')).toBe(false);
  expect(Object.isFrozen(HttpResponses['GET /api/v2/appearance/walls/:id/image'].mediaTypes)).toBe(true);
});
