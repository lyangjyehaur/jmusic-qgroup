import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const directory = new URL('../../docs/unified-rebuild/', import.meta.url);
const matrix = readFileSync(new URL('01-capability-inventory.md', directory), 'utf8');
const expected = [...matrix.matchAll(/^\| ([A-Z]\d{2}) \|/gm)].map(match => match[1]);
const ledger = JSON.parse(readFileSync(new URL('capability-status.json', directory), 'utf8'));
const actual = ledger.capabilities.map(row => row.capability_id);
assert.equal(expected.length, 166); assert.equal(new Set(actual).size, 166);
assert.deepEqual(actual, expected, 'No removed, duplicated or reordered capability IDs');
const states = new Set(['planned', 'in_progress', 'awaiting_acceptance', 'passed', 'externally_blocked']);
for (const row of ledger.capabilities) {
  assert(states.has(row.state)); assert(row.new_entry && row.required_behavior);
  for (const field of ['implementation', 'behavior_evidence', 'data_evidence', 'permission_evidence', 'ux_evidence']) {
    assert(Array.isArray(row[field]));
    if (row.state === 'passed') assert(row[field].length > 0, `${row.capability_id}: missing ${field}`);
    for (const path of row[field]) assert(existsSync(new URL('../../' + path, import.meta.url)), `Missing evidence: ${path}`);
  }
  if (row.state !== 'passed') assert(row.remaining, 'Unfinished capabilities must describe remaining work');
}
const passed = ledger.capabilities.filter(row => row.state === 'passed').length;
assert.equal(ledger.release_eligible, passed === expected.length);
console.log(`Capability ledger: ${expected.length} IDs preserved; ${passed} fully accepted; release eligible: ${ledger.release_eligible}`);
