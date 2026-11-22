import { expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import formats from 'ajv-formats';
import { fileURLToPath } from 'node:url';
import { checkHttpOperations, sharedSchemaCatalog } from '../../../tools/rebuild/build-http-contracts';
import { assertHttpOpenAPI, httpOpenAPI } from '../../../tools/rebuild/http-openapi';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const rows = checkHttpOperations(root), catalog = sharedSchemaCatalog();
const document = () => httpOpenAPI(rows, catalog);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown) => value as ObjectValue;

it('generates a valid OpenAPI document for every actual v2 operation with request, query and success contracts', async () => {
  const spec = document();await expect(assertHttpOpenAPI(spec)).resolves.toBeUndefined();
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).map(object);
  expect(operations.map(item => item.operationId).sort()).toEqual(rows.map(row => row.id).sort());
  expect(operations).toHaveLength(203);expect(operations.filter(item => item.requestBody)).toHaveLength(93);
  expect(operations.filter(item => item['x-qgroup-query-schema'])).toHaveLength(48);
  expect(Object.keys(spec.components.schemas)).toHaveLength(461);
  const download = object(spec.paths['/api/v2/admin/music-export']!.get), response = object(object(download.responses)['200']);
  expect(response.content).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/Response_HttpMusicExport' } } });
  expect(response.headers).toMatchObject({ 'Content-Disposition': { required: true, 'x-qgroup-disposition': 'attachment' } });
  const image = object(spec.paths['/api/v2/me/payment-codes/{codeId}/image']!.get);
  expect(object(object(image.responses)['200']).content).toEqual({ 'image/png': { schema: { type: 'string', format: 'binary' } } });
});
it('retains recursive response schema roots and nullable reads when schemas are embedded into OpenAPI', () => {
  const spec = document(), ajv = new Ajv2020({ strict: false, allErrors: true });formats(ajv);
  ajv.addSchema(spec, 'urn:qgroup:test:openapi');
  const download = ajv.getSchema('urn:qgroup:test:openapi#/components/schemas/Response_HttpMusicExport')!;
  const value = { entries: {}, members: {}, settings: {}, shouts: [], shoutHistory: [], trend: [], extension: { text: '原文字', nested: [true, null, 3, { deeper: ['原值'] }] } };
  expect(download(value), JSON.stringify(download.errors)).toBe(true);
  expect(download({ ...value, trend: [{ t: 0, counts: { entry: 'wrong' } }] })).toBe(false);
  expect(ajv.getSchema('urn:qgroup:test:openapi#/components/schemas/Response_Profile')!(null)).toBe(true);
  expect(ajv.getSchema('urn:qgroup:test:openapi#/components/schemas/Response_HttpSavedProfile')!(null)).toBe(false);
});
it('does not reinterpret literal JSON values as references or confuse a property name with a schema keyword', async () => {
  const before = structuredClone(catalog), literal = { $ref: '#/original-user-value' };
  before.schemas['Fixture'] = {
    type: 'object', default: literal, const: literal, examples: [literal],
    properties: { default: { $ref: '#/$defs/item' } }, $defs: { item: { type: 'string' } },
  };
  const spec = httpOpenAPI(rows, before), fixture = object(spec.components.schemas['Fixture']);
  expect(fixture.default).toEqual(literal);expect(fixture.const).toEqual(literal);expect(fixture.examples).toEqual([literal]);
  expect(object(fixture.properties).default).toEqual({ $ref: '#/components/schemas/Fixture/$defs/item' });
  await expect(assertHttpOpenAPI(spec)).resolves.toBeUndefined();
  expect(before.schemas['Fixture']).toEqual({ type: 'object', default: literal, const: literal, examples: [literal], properties: { default: { $ref: '#/$defs/item' } }, $defs: { item: { type: 'string' } } });
});
it('binds existing path validators while keeping authorization and release acceptance incomplete', () => {
  const spec = document();
  expect(spec['x-qgroup-permission-bindings-complete']).toBe(false);
  expect(spec['x-qgroup-path-validation-bound']).toBe(true);expect(spec['x-qgroup-release-eligible']).toBe(false);
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).map(object);
  expect(operations.every(item => item['x-qgroup-permission-binding-complete'] === false && item['x-qgroup-server-domain-validation-required'] === true && item['x-qgroup-zod-validation-required'] === true)).toBe(true);
  expect(operations.filter(item => !Object.hasOwn(item, 'x-qgroup-access')).every(item => !Object.hasOwn(item, 'security'))).toBe(true);
});
it.each(['dangling reference', 'missing response description', 'missing request content'])('rejects a malformed generated document: %s', async mode => {
  const spec = document(), save = object(spec.paths['/api/v2/me/music']!.put);
  if (mode === 'dangling reference') object(object(object(save.requestBody).content)['application/json']).schema = { $ref: '#/components/schemas/Absent' };
  if (mode === 'missing response description') delete object(object(save.responses)['200']).description;
  if (mode === 'missing request content') delete object(save.requestBody).content;
  await expect(assertHttpOpenAPI(spec)).rejects.toThrow(Error);
});
it('rejects duplicate operations and missing response contracts before producing a document', () => {
  expect(() => httpOpenAPI([...rows, rows[0]!], catalog)).toThrow(Error);
  const incomplete = structuredClone(catalog);delete incomplete.responseSchemas['HttpMusicExport'];
  expect(() => httpOpenAPI(rows, incomplete)).toThrow(Error);
});
