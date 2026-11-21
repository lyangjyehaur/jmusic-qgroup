import { expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import type { Json } from '../../../database/src/legacy-music-codec';
import { fixture } from '../../../../apps/api/testsupport/fixture';
import { exportMusic } from '../../../../apps/api/src/music-export';
import { exportLegacyMusic } from '../../../../apps/api/src/legacy-music-export';
import { HttpMusicExport } from './music-export';

const member = { qq: '38888', pinHash: '', boardUserId: '', contactQQ: '', selection: [], created: [] };
const empty = { entries: {}, members: {}, settings: {}, shouts: [], shoutHistory: [], trend: [] };
it('accepts the current exporter without dropping projected identities or unknown user fields', () => {
  const db = openDatabase(':memory:');
  try {
    fixture(db);
    const value = exportMusic(db);
    expect(HttpMusicExport.parse(value)).toEqual(value);
    const extended = { ...value, members: { ...value.members, '38888': { ...member, userExtension: { original: '使用者原文字', values: [true, null, 4] } } } };
    expect(HttpMusicExport.parse(extended)).toEqual(extended);
  } finally { db.close(); }
});
it('accepts the historical exporter with original selection scalars, optional IDs and nullable times', () => {
  const db = openDatabase(':memory:');
  try {
    fixture(db);
    const selections: Json[] = ['e', { entryId: 'e', level: '4' }, { id: 'e', level: null }, { level: false }, {}];
    const historical = {
      entries: { e: { id: 'e', text: '原詞條', aliases: ['原別名'], createdAt: 'legacy time' } },
      members: { '38888': { qq: '38888', selection: selections, created: ['e'], createdAt: null, noteAt: 'original time' } },
      trend: [{ t: 0, counts: { e: 1.5 } }],
    };
    const value = exportLegacyMusic(historical, db, [], new Set());
    expect(HttpMusicExport.parse(value)).toEqual(value);
    expect((value.members as Record<string, { selection: unknown[] }>)['38888']!.selection).toEqual(historical.members['38888'].selection);
  } finally { db.close(); }
});
it.each(['entries', 'members', 'settings', 'shouts', 'shoutHistory', 'trend'])('rejects a download missing the required %s section', field => {
  const value: Record<string, unknown> = { ...empty };delete value[field];
  expect(HttpMusicExport.safeParse(value).success).toBe(false);
});
it.each([
  ['entry key', { ...empty, entries: { e: { id: 'different', text: '原詞條' } } }],
  ['member key', { ...empty, members: { '38888': { ...member, qq: 'different' } } }],
  ['selection type', { ...empty, members: { '38888': { ...member, selection: [7] } } }],
  ['contact type', { ...empty, members: { '38888': { ...member, contactQQ: 7 } } }],
  ['inactive administrative hash', { ...empty, settings: { adminPasswordHash: 'synthetic' } }],
  ['trend count', { ...empty, trend: [{ t: 0, counts: { e: 'wrong' } }] }],
])('rejects an invalid download representation: %s', (_name, value) => {
  expect(HttpMusicExport.safeParse(value).success).toBe(false);
});
