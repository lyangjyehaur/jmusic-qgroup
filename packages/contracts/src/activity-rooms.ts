import { z } from 'zod';
export const RoomOverviewPerson = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  is_me: z.boolean(),
  managed_guest: z.boolean(),
  missing: z.boolean(),
});
export const ActivityRoomOverview = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int(),
  kind: z.enum(['none', 'plan', 'actual']),
  version: z.number().int().nonnegative(),
  created_at: z.string().nullable(),
  historical: z.boolean(),
  can_manage: z.boolean(),
  my_room_id: z.string().nullable(),
  has_self: z.boolean(),
  self_waiting: z.boolean(),
  rooms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      payer_name: z.string(),
      people: z.array(RoomOverviewPerson),
    }),
  ),
  unassigned: z.array(RoomOverviewPerson),
});
export const RoomPlanHistory = z.object({
  id: z.string(),
  title: z.string(),
  revisions: z.array(
    z.object({
      version: z.number().int().positive(),
      created_at: z.string(),
      room_count: z.number().int().nonnegative(),
    }),
  ),
  next_before: z.number().int().positive().nullable(),
});
