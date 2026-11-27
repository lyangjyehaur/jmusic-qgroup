import { musicProfileActiveSQL, type DB } from '@qgroup/database';
import { safeAvatar } from './qq-provider';

/** Use the configured QQ application's linked identity, never a self-reported number. */
export function musicAvatars(db: DB, clientId?: string): Map<string, string> {
  if (!clientId) return new Map();
  const rows = db.prepare(`SELECT p.id,ep.avatar_url FROM music_profiles p
    JOIN external_identities ei ON ei.user_id=p.user_id AND ei.provider='qq' AND ei.client_id=?
    JOIN external_profiles ep ON ep.user_id=ei.user_id AND ep.provider=ei.provider AND ep.client_id=ei.client_id
    WHERE ${musicProfileActiveSQL('p')}`).all(clientId) as { id: string; avatar_url: string }[];
  return new Map(rows.flatMap(row => {
    const url = safeAvatar(row.avatar_url ?? '');
    return url ? [[row.id, url] as const] : [];
  }));
}

export function withMusicAvatar<T extends { id: string }>(identity: T, avatars: Map<string, string>): T & { avatarUrl?: string } {
  const avatarUrl = avatars.get(identity.id);
  return avatarUrl ? { ...identity, avatarUrl } : identity;
}
