import { z } from 'zod';
const percent = z.number().int().min(0).max(100), count = z.number().int().nonnegative();
export const MusicMatchStats = z.object({
  score: percent, ratio: percent, sharedCount: count, sharedDomain: count, sharedSub: count, nicheShared: count,
  lowData: z.boolean(), mineCovered: z.boolean(), theirsCovered: z.boolean(), mineCount: count, theirsCount: count,
  domainRatio: percent.nullable(), subRatio: percent.nullable(), bothTop: count, label: z.string(), matchPercent: percent,
});
export const MusicComparePick = z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']), count, level: z.number().int().min(1).max(4) });
export const MusicSharedPick = MusicComparePick.extend({ level: z.number().int().min(0).max(4), myLevel: z.number().int().min(1).max(4), theirLevel: z.number().int().min(1).max(4) });
export const MusicMatchIdentity = z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().optional(), contactQQ: z.string(), contactSource: z.enum(['legacy', 'self_reported', '']), gender: z.string(), note: z.string() });
export const MusicComparison = z.object({ me: MusicMatchIdentity, other: MusicMatchIdentity, stats: MusicMatchStats,
  shared: z.array(MusicSharedPick), mine: z.array(MusicComparePick), theirs: z.array(MusicComparePick), onlyMine: z.array(MusicComparePick), onlyTheirs: z.array(MusicComparePick) });
export const MusicMatches = z.object({ me: MusicMatchIdentity, mine: z.array(MusicComparePick), sort: z.enum(['rare', 'familiar']),
  matches: z.array(z.object({ member: MusicMatchIdentity, stats: MusicMatchStats.extend({ evidenceScore: percent, famScore: z.number().nonnegative(), myTopShared: count }), shared: z.array(MusicSharedPick), onlyTheirs: z.array(MusicComparePick) })),
  sparseMatches: z.array(z.object({ member: MusicMatchIdentity, stats: MusicMatchStats.extend({ evidenceScore: percent, famScore: z.number().nonnegative(), myTopShared: count }), shared: z.array(MusicSharedPick), onlyTheirs: z.array(MusicComparePick) })),
});
