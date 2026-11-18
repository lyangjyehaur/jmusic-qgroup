import { z } from 'zod';
export const ViewFinanceOrigin=z.object({kind:z.enum(['record','report']),id:z.string().regex(/^[a-f0-9]{16}$/)}).strict();
export const FinanceOriginResult=z.discriminatedUnion('state',[z.object({state:z.literal('missing')}),z.object({state:z.literal('existing'),id:z.string(),kind:z.enum(['record','report']),status:z.enum(['recorded','pending','accepted','rejected','withdrawn'])})]);
