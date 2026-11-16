import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { activityState, parseAmount, parseWeight, splitCents } from './index';
describe('exact money and lifecycle', () => {
  it('matches legacy Python amount/weight parsing and largest remainder for 400 synthetic cases', () => {
    let seed = 42;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    const cases = Array.from({ length: 400 }, (_, i) => ({ cents: (i % 2 ? -1 : 1) * (next() % 1000000000), weights: Array.from({ length: 1 + next() % 25 }, () => (next() % 1000001 / 1000).toFixed(3)) }));
    const python = execFileSync('python3', ['-c', `import json,sys
from qgroup_core.settlements import amount,weight,split
cases=json.load(sys.stdin)
print(json.dumps({'splits':[split(c['cents'],[weight(w) for w in c['weights']]) for c in cases], 'amounts':[amount(v) for v in ['0','1.01','00001.2','9999999.99']]}))`], { input: JSON.stringify(cases), encoding: 'utf8' });
    const expected = JSON.parse(python) as { splits: number[][]; amounts: number[] };
    expect(cases.map(c => splitCents(BigInt(c.cents), c.weights.map(parseWeight)).map(Number))).toEqual(expected.splits);
    expect(['0', '1.01', '00001.2', '9999999.99'].map(v => Number(parseAmount(v)))).toEqual(expected.amounts);
    for (const c of cases) expect(splitCents(BigInt(c.cents), c.weights.map(parseWeight)).reduce((a, b) => a + b, 0n)).toBe(BigInt(c.cents));
  });
  it('rejects invalid decimal syntax; preserves tie order, zero and negative allocation', () => {
    for (const value of ['-1', '1e2', ' 1', '1\n', '1.001', '10000000', '.5']) expect(() => parseAmount(value)).toThrow();
    for (const value of ['1000.001', '-1', '1.0001', '1\n', 'NaN']) expect(() => parseWeight(value)).toThrow();
    expect(splitCents(-2n, [1n, 1n, 1n])).toEqual([-1n, -1n, 0n]);
    expect(splitCents(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(() => splitCents(1n, [0n])).toThrow();
    expect(() => splitCents(1n, [-1n])).toThrow();
  });
  it('never turns estimated passage of time into actual completion or registration', () => {
    const event = { lifecycle: 'scheduled', starts_at: '2026-01-01T00:00:00Z', deadline: '2025-12-31T00:00:00Z', duration_hours: 2, archived_at: null, status: 'open', registration_open: 1 };
    expect(activityState(event, new Date('2026-01-02T00:00:00Z'))).toEqual({ phase: 'ongoing', estimatedOver: true, registrationOpen: false });
    expect(activityState({ ...event, duration_hours: null }, new Date('2026-01-02T00:00:00Z')).estimatedOver).toBe(false);
    expect(activityState(event, new Date('2025-12-30T00:00:00Z')).registrationOpen).toBe(true);
    expect(activityState({ ...event, archived_at: 'now' }, new Date('2025-12-30T00:00:00Z')).registrationOpen).toBe(false);
  });
});
