import { performance } from 'node:perf_hooks';
import { musicCircles, type MatchEntry } from '../../packages/domain/src/index';

// Synthetic CPU samples only. No database, accounts, network or delivery work.
const entries: MatchEntry[] = Array.from({ length: 2000 }, (_, i) => ({ id: 'e' + i, name: '詞' + i, kind: i < 200 ? 'main' : 'sub', count: 0 }));
const samples = [100, 300, 1000].map(size => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const members = Array.from({ length: size }, (_, i) => ({ id: 'm' + i, name: '人' + i,
    selections: [...new Set(Array.from({ length: 20 }, () => Math.floor(random() * entries.length)))].map(n => ({ entryId: 'e' + n, level: 3 })) }));
  const start = performance.now(), result = musicCircles(members, entries);
  return { members: size, entries: entries.length, picksPerMemberMax: 20, minLink: 40, milliseconds: Math.round(performance.now() - start),
    clusters: result.clusters.length, singles: result.singles };
});
process.stdout.write(JSON.stringify({ synthetic: true, node: process.version, platform: process.platform, arch: process.arch, samples }, null, 2) + '\n');
