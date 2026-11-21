import type { HttpOperationSource } from './build-http-contracts';
import { hasSchema,registerSchema,unregisterSchema,validate,type Validator } from '@hyperjump/json-schema/draft-2020-12';
import { z } from 'zod';
import officialSchema from './schemas/openapi-3.1.json';
import { httpAccessDescription,httpSecuritySchemes } from './http-access';

type Catalog = { schemas: Record<string, unknown>; responseSchemas: Record<string, unknown> };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an object schema');
  return value as ObjectValue;
};
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const schemaPath = (name: string) => '#/components/schemas/' + pointer(name);
const reference = (name: string) => ({ $ref: schemaPath(name) });
const literals = new Set(['const', 'default', 'enum', 'examples']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);

/** Zod emits document-local recursive references. Each schema is embedded in
 * the OpenAPI document, so its local references must retain their own root. */
function mapSchemaReferences(value: unknown, mapReference: (value: string) => string): unknown {
  if (Array.isArray(value)) return value.map(item => mapSchemaReferences(item, mapReference));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === '$ref' && typeof item === 'string' ? mapReference(item) : literals.has(key) ? item
      : schemaMaps.has(key) ? Object.fromEntries(Object.entries(object(item)).map(([name, schema]) => [name, mapSchemaReferences(schema, mapReference)]))
      : mapSchemaReferences(item, mapReference),
  ]));
  return value;
}

if (hasSchema(officialSchema.$id)) unregisterSchema(officialSchema.$id);
registerSchema(officialSchema);
let validation: Promise<Validator> | undefined;
export async function assertHttpOpenAPI(document: unknown) {
  const validateDocument = await (validation ??= validate(officialSchema.$id));
  if (!validateDocument(z.json().parse(document)).valid) throw Error('Invalid OpenAPI 3.1 document');
  const checkReference = (reference: string) => {
    if (!reference.startsWith('#/')) throw Error('Unsupported external OpenAPI reference');
    let value: unknown = document;
    for (const part of decodeURIComponent(reference.slice(2)).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Unresolved OpenAPI reference');
      value = (value as ObjectValue)[key];
    }
    return reference;
  };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') checkReference(item);
      else if (key === 'schemas') for (const schema of Object.values(object(item))) mapSchemaReferences(schema, checkReference);
      else if (key === 'schema') mapSchemaReferences(item, checkReference);
      else if (!['example', 'value'].includes(key)) visit(item);
    }
  };
  visit(document);
}

export function httpOpenAPI(rows: HttpOperationSource[], catalog: Catalog) {
  if (!rows.length) throw Error('No HTTP operations');
  const schemas: ObjectValue = {};
  const add = (name: string, value: unknown) => {
    if (Object.hasOwn(schemas, name)) throw Error('Duplicate OpenAPI schema');
    schemas[name] = mapSchemaReferences(value, ref => ref.startsWith('#') ? schemaPath(name) + ref.slice(1) : ref);
  };
  for (const [name, schema] of Object.entries(catalog.schemas)) add(name, schema);
  for (const [name, schema] of Object.entries(catalog.responseSchemas)) add('Response_' + name, schema);
  const paths: Record<string, Record<string, unknown>> = {};
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw Error('Duplicate HTTP operation');
    ids.add(row.id);
    const path = row.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const item = paths[path] ??= {}, method = row.method.toLowerCase();
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || Object.hasOwn(item, method)) throw Error('Duplicate or unsupported OpenAPI operation');
    const parameters: ObjectValue[] = [...row.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => ({
      name: match[1]!, in: 'path', required: true, schema: { type: 'string' }, 'x-qgroup-server-validation-required': true,
    }));
    if (row.query) {
      const query = object(catalog.schemas[row.query]);
      if (query.type !== 'object') throw Error('Query schema must describe an object');
      const required = query.required ?? [];
      if (!Array.isArray(required)) throw Error('Invalid required query properties');
      for (const name of Object.keys(object(query.properties))) parameters.push({
        name, in: 'query', required: required.includes(name), style: 'form', explode: true,
        schema: { $ref: schemaPath(row.query) + '/properties/' + pointer(name) },
      });
    }
    const response = row.response, success: ObjectValue = { description: 'OK' };
    if (response.kind === 'json' || response.kind === 'download') {
      const name = 'Response_' + response.schema;
      if (!Object.hasOwn(schemas, name)) throw Error('Missing response schema');
      success.content = { 'application/json': { schema: reference(name) } };
      if (response.kind === 'download') success.headers = {
        'Content-Disposition': { required: true, schema: { type: 'string' }, 'x-qgroup-disposition': response.disposition },
      };
    } else success.content = Object.fromEntries(response.mediaTypes.map(media => [media, { schema: { type: 'string', format: 'binary' } }]));
    if (!Object.hasOwn(schemas, 'ApiFailure')) throw Error('Missing error response schema');
    const operation: ObjectValue = {
      operationId: row.id, parameters,
      responses: { '200': success, default: { description: 'Request rejected or unavailable', content: { 'application/json': { schema: reference('ApiFailure') } } } },
      'x-qgroup-source': { file: row.file, line: row.line },
      'x-qgroup-zod-validation-required': true,
      'x-qgroup-server-domain-validation-required': true,
      'x-qgroup-permission-binding-complete': false,
      ...(row.access ? httpAccessDescription(row.access) : {}),
    };
    if (row.body) {
      if (!Object.hasOwn(schemas, row.body)) throw Error('Missing request schema');
      operation.requestBody = { required: true, content: { 'application/json': { schema: reference(row.body) } } };
    }
    if (row.query) operation['x-qgroup-query-schema'] = reference(row.query);
    item[method] = operation;
  }
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: '群聚 API', version: '2' }, paths, components: { schemas, securitySchemes: httpSecuritySchemes },
    'x-qgroup-erasure-recovery-gate-required': true,
    'x-qgroup-boundary-reviewed-operations': rows.filter(row=>row.access).length,
    'x-qgroup-boundary-coverage-complete': rows.every(row=>row.access?.boundaryReviewed),
    'x-qgroup-permission-bindings-complete': false,
    'x-qgroup-path-validation-bound': false,
    'x-qgroup-release-eligible': false,
  };
}
