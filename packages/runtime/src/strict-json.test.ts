import { describe, expect, it } from 'vitest';
import { jsonObjectKeys, jsonObjectFromEntries, stringifyJson, parseJson, type ObjectValue } from './strict-json';

describe('source JSON discovery order', () => {
  it('retains nested numeric member and term keys in their actual source order', () => {
    const value = parseJson('{"members":{"9000":{},"1000":{},"m_native":{}},"entries":{"20":{},"3":{}}}') as ObjectValue;
    expect(Object.keys(value.members!)).toEqual(['1000', '9000', 'm_native']);
    expect(jsonObjectKeys(value.members as ObjectValue)).toEqual(['9000', '1000', 'm_native']);
    expect(jsonObjectKeys(value.entries as ObjectValue)).toEqual(['20', '3']);
    expect(JSON.stringify(value)).toBe('{"members":{"1000":{},"9000":{},"m_native":{}},"entries":{"3":{},"20":{}}}');
    expect(structuredClone(value)).toEqual(value);
  });
  it('retains independent source orders inside arrays without attaching serialized metadata', () => {
    const values = parseJson('[{"9":1,"2":2},{"2":3,"9":4}]') as ObjectValue[];
    expect(values.map(jsonObjectKeys)).toEqual([['9', '2'], ['2', '9']]);
    expect(Object.getOwnPropertySymbols(values[0]!)).toEqual([]);
    expect(jsonObjectKeys({ '2': 2, '9': 1 })).toEqual(['2', '9']);
  });
  it('filters removed source keys and appends subsequent additions without resurrecting data', () => {
    const value = parseJson('{"9000":1,"1000":2,"old":3}') as ObjectValue;
    delete value['1000']; value['2000'] = 4; value.new = 5;
    expect(jsonObjectKeys(value)).toEqual(['9000', 'old', '2000', 'new']);
    expect(jsonObjectKeys(parseJson('{}') as ObjectValue)).toEqual([]);
  });
  it('still rejects duplicate decoded keys and unsafe numbers without changing prototype behavior', () => {
    expect(() => parseJson('{"9000":1,"\\u0039000":2}')).toThrow('Duplicate JSON object key');
    expect(() => parseJson('{"9":9007199254740993}')).toThrow('Unsafe JSON number');
    const value = parseJson('{"__proto__":{"9":1,"2":2},"constructor":false}') as ObjectValue;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(jsonObjectKeys(value.__proto__ as ObjectValue)).toEqual(['9', '2']);
    expect(jsonObjectKeys(value)).toEqual(['__proto__', 'constructor']);
  });
  it('writes recorded orders through a formatted JSON roundtrip including nested dictionaries, escapes and deletions', () => {
    const value = parseJson('{"members":{"9000":{"name":"行\\n文𠀀"},"1000":{},"m_native":{}},"entries":{"20":{},"3":{}}}') as ObjectValue;
    delete (value.members as ObjectValue).m_native;
    const encoded = stringifyJson(value, 2), decoded = parseJson(encoded) as ObjectValue;
    expect(JSON.parse(encoded)).toEqual(value);
    expect(jsonObjectKeys(decoded.members as ObjectValue)).toEqual(['9000', '1000']);
    expect(jsonObjectKeys(decoded.entries as ObjectValue)).toEqual(['20', '3']);
    expect(encoded).toContain('\n  "members": {\n    "9000":');
    expect(stringifyJson(decoded)).toBe('{"members":{"9000":{"name":"行\\n文𠀀"},"1000":{}},"entries":{"20":{},"3":{}}}');
  });
  it('writes newly constructed numeric records in pair order while retaining normal duplicate and prototype-key values', () => {
    const value = jsonObjectFromEntries([['9000', 1], ['__proto__', 2], ['1000', 3], ['9000', 4]]);
    expect(jsonObjectKeys(value)).toEqual(['9000', '__proto__', '1000']);
    expect(stringifyJson(value)).toBe('{"9000":4,"__proto__":2,"1000":3}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(JSON.parse(stringifyJson(value))).toEqual(value);
  });
  it('preserves ordinary plain JSON formatting and omitted values and rejects cycles without rejecting shared values', () => {
    const item = { name: '原文', none: undefined }, value = { zero: 0, flag: false, empty: {}, items: [item, undefined, null, item] };
    expect(stringifyJson(value)).toBe(JSON.stringify(value));
    expect(stringifyJson(value, 2)).toBe(JSON.stringify(value, null, 2));
    expect(stringifyJson(value, 20)).toBe(JSON.stringify(value, null, 10));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => stringifyJson(cycle)).toThrow('Circular JSON data');
    expect(() => stringifyJson(undefined)).toThrow('Missing JSON data');
  });
});
