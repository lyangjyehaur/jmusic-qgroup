import { DomainError } from './index';
import { musicText } from './music-text';
export const shoutTTL = 30 * 86400, shoutCooldown = 86400, shoutHistoryMax = 500;
export function shoutText(value: string) {
  // Match Python split/strip whitespace; reject excess instead of silently truncating user content.
  const clean=musicText(value);
  if(!clean)throw new DomainError('SHOUT_EMPTY','請輸入找搭子內容');
  if(Array.from(clean).length>140)throw new DomainError('SHOUT_TOO_LONG','找搭子內容最多 140 字');
  return clean;
}
