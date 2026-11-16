import { z } from 'zod';
import { DomainError } from '@qgroup/domain';

const identifier = z.string().regex(/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{36})$/);
export const QQIdentity = z.object({ subject: identifier.transform(v => v.toUpperCase()), nickname: z.string().trim().min(1).max(200), avatarUrl: z.string().default(''), unionId: z.string().default('') }).strict();
export type QQIdentityValue = z.infer<typeof QQIdentity>;
export interface QQProvider { clientId: string; authorize(state: string): string; exchange(code: string): Promise<QQIdentityValue> }
export function safeAvatar(value: string) {
  try {
    if (value.length > 2048 || /[\x00-\x20]/.test(value)) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || !(url.hostname === 'qlogo.cn' || url.hostname.endsWith('.qlogo.cn'))) return '';
    url.protocol = 'https:'; return url.href;
  } catch { return ''; }
}
export function safeUnionId(value: string) { return /^[A-Za-z0-9_-]{1,256}$/.test(value) && value.trim() === value ? value : ''; }
/** Configuration is isolated from the current website; never read its credentials implicitly. */
export function qqProvider(origin: string, environment: NodeJS.ProcessEnv = process.env): QQProvider | undefined {
  const clientId = environment.REBUILD_QQ_APP_ID?.trim();
  const key = environment.REBUILD_QQ_APP_KEY?.trim();
  if (!clientId && !key) return undefined;
  const site = new URL(origin);
  if (!clientId || !/^\d+$/.test(clientId) || !key || site.origin !== origin || (site.protocol !== 'https:' && !(site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname)))) throw new Error('Invalid REBUILD QQ OAuth configuration');
  const redirect = origin + '/auth/qq/callback';
  async function graph(path: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
    // Redirects, unbounded bodies and remote error text must never carry credentials onward.
    try {
      const response = await fetch('https://graph.qq.com' + path + '?' + new URLSearchParams(parameters), { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65536) throw new Error(); chunks.push(next.value); }
      } finally { await reader.cancel(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || 'error' in body || ('ret' in body && body.ret !== 0)) throw new Error();
      return body as Record<string, unknown>;
    } catch { throw new DomainError('QQ_UNAVAILABLE', 'QQ 授權暫時無法完成，請稍後重新登入', 502); }
  }
  return {
    clientId,
    authorize: state => 'https://graph.qq.com/oauth2.0/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state, scope: 'get_user_info' }),
    async exchange(code) {
      const token = await graph('/oauth2.0/token', { grant_type: 'authorization_code', client_id: clientId, client_secret: key, code, redirect_uri: redirect, fmt: 'json' });
      const access = identifier.safeParse(token.access_token);
      if (!access.success) throw new DomainError('QQ_INVALID_IDENTITY', 'QQ 授權身份無效，請重新登入', 502);
      let identity: Record<string, unknown>;
      try { identity = await graph('/oauth2.0/me', { access_token: access.data, fmt: 'json', unionid: '1' }); }
      catch { identity = await graph('/oauth2.0/me', { access_token: access.data, fmt: 'json' }); }
      if (String(identity.client_id) !== clientId || !identifier.safeParse(identity.openid).success) throw new DomainError('QQ_INVALID_IDENTITY', 'QQ 授權身份不符，請重新登入', 502);
      const profile = await graph('/user/get_user_info', { access_token: access.data, oauth_consumer_key: clientId, openid: String(identity.openid) });
      const parsed = QQIdentity.safeParse({ subject: identity.openid, nickname: profile.nickname, avatarUrl: typeof profile.figureurl_qq_2 === 'string' ? safeAvatar(profile.figureurl_qq_2) : typeof profile.figureurl_qq_1 === 'string' ? safeAvatar(profile.figureurl_qq_1) : '', unionId: typeof identity.unionid === 'string' ? safeUnionId(identity.unionid) : '' });
      if (!parsed.success || profile.ret !== 0) throw new DomainError('QQ_INVALID_PROFILE', 'QQ 資料暫時無法讀取，請重新登入', 502);
      return parsed.data;
    },
  };
}
