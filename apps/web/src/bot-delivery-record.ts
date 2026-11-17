import { z } from 'zod';
import { BotDeliveryId, RetryBotDelivery } from '@qgroup/contracts';

export const PendingBotDelivery = z.object({ id: BotDeliveryId, key: z.string().uuid(), input: RetryBotDelivery }).strict();
export type PendingBotDelivery = z.infer<typeof PendingBotDelivery>;

/** Only the original scoped activity/poll route is eligible; payloads cannot supply a URL. */
export function botDeliveryDraftRoute(key: string, scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) return null;
  const prefix = 'qgroup:rebuild:activity-draft:bot-delivery:v1:' + scope + ':';
  if (!key.startsWith(prefix)) return null;
  const path = key.slice(prefix.length), match = /^\/(activities|time-polls)\/([^/?#]+)\/bot-deliveries$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]!);
    if (!id || id.length > 80 || id === '.' || id === '..' || encodeURIComponent(id) !== match[2]) return null;
    return { path, id, entity: match[1] === 'activities' ? 'activity' as const : 'poll' as const };
  } catch { return null; }
}
