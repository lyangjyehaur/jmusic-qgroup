import { z } from 'zod';
import { ActivityCategory,CreateTimePoll } from '@qgroup/contracts';
import { LegacyDraftSource } from './legacy-draft-source';
const integerInput=z.union([z.number(),z.string()]);
export const EditablePollDefinition=z.object({client_intent:z.string().uuid().optional(),title:z.string(),category:ActivityCategory,location:z.string(),description:z.string(),timezone:z.string(),capacity:integerInput,minimum_participants:integerInput,fee_policy:z.string(),deadline:z.string(),bot_enabled:z.boolean(),time_mode:z.enum(['date','exact']),duration_hours:integerInput,options:z.array(z.string()),legacySource:LegacyDraftSource.optional()});
export const PollCreateRecord=z.object({value:EditablePollDefinition,dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:CreateTimePoll}).strict().optional()}).strict();
export function pollCreateInput(v:z.infer<typeof EditablePollDefinition>){
  const {duration_hours,legacySource,...rest}=v;void legacySource;
  const integer=(value:string|number)=>typeof value==='number'?value:/^\d+$/.test(value)?Number(value):NaN;
  return CreateTimePoll.parse({...rest,capacity:integer(v.capacity),minimum_participants:integer(v.minimum_participants),visibility:'public',...(v.time_mode==='exact'?{duration_hours:integer(duration_hours)}:{}),options:v.options.map(value=>v.time_mode==='date'?{date:value}:{starts_at:value})});
}
