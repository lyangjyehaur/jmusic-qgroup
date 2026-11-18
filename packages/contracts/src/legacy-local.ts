import { z } from 'zod';
export const LegacyRequestCheck=z.object({requestKey:z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),method:z.enum(['POST','PUT','PATCH','DELETE']),path:z.string().regex(/^\/api\/[A-Za-z0-9_/-]{1,400}$/),data:z.record(z.string(),z.unknown())}).strict();
export const LegacyRequestReceipt=z.object({committed:z.boolean(),target:z.object({kind:z.enum(['activity','poll']),id:z.string().min(1).max(80)}).strict().optional()}).strict();
