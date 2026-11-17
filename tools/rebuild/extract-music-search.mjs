import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Preserve the existing pronunciation dictionary as data, without loading legacy scripts at runtime.
const root = new URL('../../', import.meta.url);
const initialsSource = readFileSync(new URL('music_site/public/initials.js', root), 'utf8');
const fullSource = readFileSync(new URL('music_site/public/pinyin.js', root), 'utf8');
const initials = JSON.parse(initialsSource.match(/window\.PY_INITIALS\s*=\s*("[a-z ]+")/)[1]);
const full = fullSource.match(/window\.PY_FULL\s*=\s*'([a-z ]+)'/)[1];
const base = Number(initialsSource.match(/window\.PY_BASE\s*=\s*(0x[0-9a-f]+)/i)[1]);
assert.equal(base, 0x4e00);
assert.equal(initials.length, 0xa000 - base);
assert.equal(full.split(' ').length, initials.length);
const target = new URL('packages/domain/src/music-search-data.json', root);
const output = JSON.stringify({ base, initials, full }) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), output);
else writeFileSync(target, output);
console.log('Music pronunciation dictionary: 20,992 source characters preserved');
