import { z } from 'zod';
import { RoomPlanInput,SaveRoomPlan } from '@qgroup/contracts';
import { LegacyDraftSource } from './legacy-draft-source';
export const RoomEditorValue = z
  .object({
    legacySource: LegacyDraftSource.optional(),
    revision: z.number().int().nonnegative(),
    rooms: z.array(RoomPlanInput.extend({ name: z.string(), payer_id: z.string() })).max(50),
    reason: z.string(),
    music_source_version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const RoomEditorRecord=z.object({value:RoomEditorValue,baseline:RoomEditorValue.optional(),dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:SaveRoomPlan}).strict().optional()}).strict();
export function roomPlanInput(value:z.infer<typeof RoomEditorValue>){const {legacySource,...input}=value;void legacySource;return input;}
