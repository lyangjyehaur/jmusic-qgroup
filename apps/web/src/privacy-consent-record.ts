import { z } from 'zod';
import { AcceptPrivacy } from '@qgroup/contracts';
// Accept historical versions here so a pending original can always be recovered.
export const PendingPrivacyConsent = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), key: z.string().uuid(), input: AcceptPrivacy }).strict();
export function parsePrivacyConsent(raw: string, scope: string) {
  return PendingPrivacyConsent.refine(value => value.scope === scope).nullable().parse(JSON.parse(raw));
}
