import { z } from 'zod';
const Id = z.string().min(1).max(128),
  Version = z.string().regex(/^[a-f0-9]{64}$/);
export const RoomLabSource = z
  .object({
    eventId: Id.nullable(),
    title: z.string(),
    sourceVersion: Version,
    selfId: Id.nullable(),
    revision: z.number().int().nonnegative().nullable(),
    canAdopt: z.boolean(),
    currentRooms: z.object({
      kind: z.enum(['plan', 'actual']),
      version: z.number().int().positive(),
      rooms: z.array(z.object({ id: Id, name: z.string(), members: z.array(Id) }).strict()).max(50),
    }).strict().optional(),
    members: z.array(
      z.object({
        id: Id,
        name: z.string(),
        profileId: Id.nullable(),
        pickCount: z.number().int().nonnegative(),
        status: z.string(),
        isMe: z.boolean(),
        recommendation: z.number().int().min(0).max(100).nullable(),
      }),
    ),
  })
  .strict();
export const RoomLabMode = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('rooms'),
      value: z.number().int().min(1).max(40),
    })
    .strict(),
  z
    .object({
      mode: z.literal('capacity'),
      value: z.number().int().min(1).max(40),
    })
    .strict(),
  z
    .object({
      mode: z.literal('sizes'),
      sizes: z.array(z.number().int().min(1).max(40)).min(2).max(40),
    })
    .strict(),
]);
const Selected = z
  .array(Id)
  .min(2)
  .max(40)
  .refine((ids) => new Set(ids).size === ids.length, '成員不能重複');
export const RoomLabRoomInput = z
  .object({
    id: z.string().uuid(),
    capacity: z.number().int().min(1).max(40),
    members: z.array(Id).max(40),
  })
  .strict();
export const RoomLabCommand = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('analyze'),
      sourceVersion: Version,
      selected: Selected,
    })
    .strict(),
  z
    .object({
      command: z.literal('split'),
      sourceVersion: Version,
      selected: Selected,
      config: RoomLabMode,
      sameGender: z.boolean(),
    })
    .strict(),
  z
    .object({
      command: z.literal('recalc'),
      sourceVersion: Version,
      selected: Selected,
      rooms: z.array(RoomLabRoomInput).min(1).max(40),
    })
    .strict(),
]);
const Pair = z.object({
  a: Id,
  b: Id,
  aName: z.string(),
  bName: z.string(),
  score: z.number().int().min(0).max(100),
  raw: z.number().int().min(0).max(100),
  label: z.string(),
  shared: z.number().int().nonnegative(),
});
const Identity = z.object({ id: Id, name: z.string() });
export const RoomLabAnalysis = z
  .object({
    members: z.array(
      Identity.extend({
        count: z.number().int().nonnegative(),
        avg: z.number().int().min(0).max(100),
      }),
    ),
    memberMax: z.number().int(),
    memberMin: z.number().int(),
    pairs: z.array(Pair),
    avg: z.number().int(),
    min: z.number().int(),
    worst: Pair.nullable(),
    loner: Identity.extend({ avg: z.number().int() }).nullable(),
    common: z
      .array(
        z.object({
          id: Id,
          text: z.string(),
          kind: z.enum(['main', 'sub']),
          n: z.number().int(),
          count: z.number().int(),
        }),
      )
      .max(8),
    need: z.number().int().min(2),
  })
  .strict();
export const RoomLabResult = z
  .object({
    sourceVersion: Version,
    selected: Selected,
    analysis: RoomLabAnalysis.nullable(),
    rooms: z.array(RoomLabRoomInput.extend({ analysis: RoomLabAnalysis })),
    unassigned: z.array(Id).max(40),
    algorithm: z.literal('music-rooms-v1'),
  })
  .strict();

export const RoomSuggestionTransfer = z
  .object({
    scope: z.string(),
    eventId: Id,
    sourceVersion: Version,
    revision: z.number().int().nonnegative(),
    rooms: z.array(z.array(Id).max(40)).max(40),
  })
  .strict();
