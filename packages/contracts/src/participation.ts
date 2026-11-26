import { z } from 'zod';

export const ParticipationQuery = z.object({
  period: z.string().regex(/^(all|[0-9]{4}(?:-(?:0[1-9]|1[0-2]))?)$/).default('all'),
  category: z.string().trim().min(1).max(80).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict();
const Count = z.number().int().min(0);
const Options = z.object({ periods: z.array(z.string()), categories: z.array(z.string()) });
const LastParticipation = z.object({ lastParticipatedAt: z.string().nullable(), timezone: z.string().nullable() });
export const ParticipationMember = LastParticipation.extend({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), avatarUrl: z.string().default(''), count: Count });
export const ParticipationRecord = z.object({ id: z.string(), title: z.string(), category: z.string(), startsAt: z.string(), timezone: z.string().nullable(), estimatedOver: z.boolean(), archived: z.boolean(), visibility: z.enum(['public', 'invitation']) });
export const ParticipationOverview = Options.extend({
  activityCount: Count, participationCount: Count, memberCount: Count, unclaimedCount: Count,
  members: z.array(ParticipationMember), page: z.number().int().positive(), hasMore: z.boolean(),
});
export const ParticipationRecords = LastParticipation.extend({ name: z.string(), count: Count, records: z.array(ParticipationRecord), page: z.number().int().positive(), hasMore: z.boolean() });
export const MyParticipation = ParticipationRecords.merge(Options);
