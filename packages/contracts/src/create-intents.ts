import { z } from 'zod';
// Original React authoring used eight random bytes; preserve its durable intent.
export const CreateIntent=z.union([z.string().uuid(),z.string().regex(/^[a-f0-9]{16}$/)]);
export const ViewCreateIntent=z.object({kind:z.enum(['activity','poll']),intent:CreateIntent}).strict();
export const CreateIntentResult=z.discriminatedUnion('state',[
  z.object({state:z.literal('missing')}).strict(),
  z.object({state:z.literal('existing'),kind:z.enum(['activity','poll']),id:z.string().min(1).max(80),revision:z.number().int().nonnegative(),route:z.enum(['draft','arrangements','poll']),canEdit:z.boolean()}).strict(),
]);
