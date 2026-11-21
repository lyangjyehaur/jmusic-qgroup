import { expect, it } from 'vitest';
import { decodeLegacyDraft } from './legacy-local-import';
import { legacyRaw } from './legacy-local-record';
const scope = 'a'.repeat(64);
const source = (suffix = 'event:new', data: unknown = { fields: [{ name: 'id', value: '' }], dataset: {} }) => ({ key: 'draft:' + scope + ':' + suffix, data, at: 1234567 });

for (const [suffix, data] of [
  ['event:new', { fields: [{ name: 'id', value: '' }, { name: 'title', value: '原活動' }], dataset: { intent: 'original', revision: '7' } }],
  ['copy:listen', { react: 1, value: { id: '', title: '原複製', _intent: 'original', _revision: '', _lifecycle: '' }, revision: undefined }],
  ['time-poll:new', { fields: [], slots: [{ key: 'original-slot', date: '2099-12-20', time: '' }], intent: 'original' }],
  ['rooms:listen', { rooms: [{ id: 'original-room', person_ids: ['original-person'], payer_id: 'original-payer' }], revision: 7 }],
  ['invoice:listen', { fields: [], people: [], items: [{ id: 'original-item', receipt: 'iVBOR-original-bytes' }], event: { revision: 7, settlement: { version: 3 } } }],
  ['finance:listen:record:new', { fields: [], edit: { recordId: 'original-record', preview: undefined }, revision: 7 }],
] as const) it('restores ' + suffix + ' from the existing download wire without rewriting identity or content', () => {
  const original = source(suffix, data), raw = legacyRaw(original), decoded = decodeLegacyDraft(raw, scope);
  expect(decoded).toStrictEqual(original);
  expect(legacyRaw(decoded)).toBe(raw);
});

it('retains own special keys, property order, sparse positions, undefined and negative zero without changing prototypes', () => {
  const object = JSON.parse('{"__proto__":{"private":"original"},"constructor":"value","尾":"原文","A":null}');
  const sparse = new Array(4); sparse[1] = undefined; sparse[3] = -0;
  const original = source('event:new', { fields: [], dataset: { object, sparse, numbers: [1e-7, 1e21, Number.MAX_VALUE, -Number.MIN_VALUE] } });
  const decoded = decodeLegacyDraft(legacyRaw(original), scope);
  expect(decoded).toStrictEqual(original);
  const dataset = decoded.data.dataset as { object: object; sparse: unknown[] };
  expect(Object.keys(dataset.object)).toEqual(['__proto__', 'constructor', '尾', 'A']);
  expect(Object.getPrototypeOf(dataset.object)).toBe(Object.prototype);
  expect(Object.hasOwn(dataset.object, '__proto__')).toBe(true);
  expect(0 in dataset.sparse).toBe(false); expect(1 in dataset.sparse).toBe(true); expect(2 in dataset.sparse).toBe(false);
  expect(Object.is(dataset.sparse[3], -0)).toBe(true);
});
it('rejects another account, request rows, unsupported drafts and credential names before any restoration', () => {
  for (const original of [
    { ...source(), key: 'draft:' + 'b'.repeat(64) + ':event:new' },
    { ...source(), key: 'request:' + scope + ':' + 'c'.repeat(64) },
    source('future-editor'),
    source('event:new', { fields: [{ name: 'csrfToken', value: 'synthetic-private' }], dataset: {} }),
    source('event:new', { fields: [], dataset: { nested: { auth_pin: 'synthetic-private' } } }),
  ]) expect(() => decodeLegacyDraft(legacyRaw(original), scope)).toThrow();
});
it('rejects truncated, duplicate, ambiguous and noncanonical tagged values instead of partially decoding them', () => {
  const wire = (tree: unknown) => JSON.stringify({ format: 'kanban-local-v1-preserved', version: 1, source: tree });
  for (const raw of [
    legacyRaw(source()).slice(0, -1),
    wire(['object', [['key', ['string', source().key]], ['key', ['string', source().key]]]]),
    wire(['number', 'NaN']), wire(['number', '01']), wire(['number', '1.0']), wire(['hole']),
    wire(['null', 'discarded']), wire(['string', 'value', 'discarded']), wire(['future', {}]),
    JSON.stringify({ ...JSON.parse(legacyRaw(source())), mappings: [{ targetKey: 'forged' }] }),
    JSON.stringify(JSON.parse(legacyRaw(source())), null, 2),
  ]) expect(() => decodeLegacyDraft(raw, scope)).toThrow();
});
it('rejects excessive nesting without losing the original file', () => {
  let nested: unknown = ['string', 'original'];
  for (let i = 0; i < 130; i++) nested = ['array', [nested]];
  expect(() => decodeLegacyDraft(JSON.stringify({ format: 'kanban-local-v1-preserved', version: 1, source: nested }), scope)).toThrow(/保全檔格式/);
});
