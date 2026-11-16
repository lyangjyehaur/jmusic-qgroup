import { afterEach, describe, expect, it, vi } from 'vitest';
import { QQIdentity, qqProvider, safeAvatar, safeUnionId } from './qq-provider';
const environment = { REBUILD_QQ_APP_ID: '12345', REBUILD_QQ_APP_KEY: 'synthetic-secret' };
const token = 'b'.repeat(32); const subject = 'a'.repeat(32);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function upstream(identity: object = { client_id: '12345', openid: subject, unionid: 'union-id' }) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: token })).mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(json({ ret: 0, nickname: ' QQ 稱呼 ', figureurl_qq_2: 'http://q1.qlogo.cn/image' }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('isolated QQ adapter without real upstream requests', () => {
  it('does not read legacy credentials and rejects incomplete or unsafe configuration', () => {
    expect(qqProvider('https://example.test', { KANBAN_QQ_APP_ID: '12345', KANBAN_QQ_APP_KEY: 'legacy-secret' })).toBeUndefined();
    for (const env of [{ REBUILD_QQ_APP_ID: '12345' }, { ...environment, REBUILD_QQ_APP_ID: 'invalid' }]) expect(() => qqProvider('https://example.test', env)).toThrow('configuration');
    expect(() => qqProvider('http://public.example.test', environment)).toThrow('configuration');
    expect(() => qqProvider('https://example.test/path', environment)).toThrow('configuration');
    expect(qqProvider('http://127.0.0.1:5080', environment)).toBeDefined();
  });
  it('exchanges only against fixed HTTPS endpoints with bounded timeout and disabled redirects', async () => {
    const fetcher = upstream(); vi.stubGlobal('fetch', fetcher);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const provider = qqProvider('https://example.test', environment)!;
    const authorize = new URL(provider.authorize('synthetic-state'));
    expect(authorize.origin + authorize.pathname).toBe('https://graph.qq.com/oauth2.0/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://example.test/auth/qq/callback');
    expect(authorize.searchParams.get('scope')).toBe('get_user_info');
    expect(authorize.searchParams.has('client_secret')).toBe(false);
    expect(await provider.exchange('synthetic-code')).toEqual({ subject: subject.toUpperCase(), nickname: 'QQ 稱呼', avatarUrl: 'https://q1.qlogo.cn/image', unionId: 'union-id' });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(timeout).toHaveBeenCalledWith(8000);
    for (const [url, options] of fetcher.mock.calls) { expect(new URL(String(url)).origin).toBe('https://graph.qq.com'); expect(options?.redirect).toBe('error'); expect(options?.signal).toBeInstanceOf(AbortSignal); }
  });
  it('falls back when optional UnionID is unavailable and retains valid OpenID login', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: token })).mockResolvedValueOnce(json({ error: 100, error_description: 'not enabled' }))
      .mockResolvedValueOnce(json({ client_id: 12345, openid: subject })).mockResolvedValueOnce(json({ ret: 0, nickname: 'QQ', figureurl_qq_1: 'https://qlogo.cn/image' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await qqProvider('https://example.test', environment)!.exchange('code')).toMatchObject({ subject: subject.toUpperCase(), unionId: '' });
    expect(new URL(String(fetcher.mock.calls[2]![0])).searchParams.has('unionid')).toBe(false);
  });
  it('rejects mismatched client, invalid identifiers and broken profile without exposing payloads or credentials', async () => {
    for (const identity of [{ client_id: 'other', openid: subject }, { client_id: '12345', openid: 'invalid' }]) {
      const fetcher = upstream(identity); vi.stubGlobal('fetch', fetcher);
      await expect(qqProvider('https://example.test', environment)!.exchange('code')).rejects.toMatchObject({ code: 'QQ_INVALID_IDENTITY' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: token })).mockResolvedValueOnce(json({ client_id: '12345', openid: subject }))
      .mockResolvedValueOnce(json({ ret: 0, nickname: '', error_description: 'synthetic-secret' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(qqProvider('https://example.test', environment)!.exchange('code')).rejects.toMatchObject({ code: 'QQ_INVALID_PROFILE' });
  });
  it('bounds response bodies and masks redirects, timeout, network and upstream error text', async () => {
    for (const response of [new Response('redirect', { status: 302 }), new Response('x'.repeat(65537)), json({ error: 1, error_description: 'synthetic-secret' }), json({ access_token: 'invalid' })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      try { await qqProvider('https://example.test', environment)!.exchange('sensitive-code'); throw new Error('expected failure'); }
      catch (error) { expect(String(error)).not.toMatch(/synthetic-secret|sensitive-code|access_token|expected failure/); }
    }
    for (const error of [new DOMException('synthetic-secret', 'TimeoutError'), new Error('synthetic-secret sensitive-code')]) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
      await expect(qqProvider('https://example.test', environment)!.exchange('code')).rejects.toMatchObject({ code: 'QQ_UNAVAILABLE', status: 502 });
    }
  });
  it('sanitizes avatars and optional UnionID, and normalizes app-specific subjects', () => {
    expect(safeAvatar('http://q1.qlogo.cn/image')).toBe('https://q1.qlogo.cn/image');
    for (const url of ['https://qlogo.cn.evil.test/x', 'https://evil.test/qlogo.cn', 'https://u:p@qlogo.cn/x', 'https://qlogo.cn:8443/x', 'https://qlogo.cn/x#fragment', 'data:image/png,abc', 'https://qlogo.cn/white space']) expect(safeAvatar(url)).toBe('');
    for (const value of [' union', 'union ', 'x'.repeat(257), 'unicode字', '']) expect(safeUnionId(value)).toBe('');
    expect(safeUnionId('ID_01-test')).toBe('ID_01-test');
    expect(QQIdentity.parse({ subject, nickname: 'QQ' }).subject).toBe(subject.toUpperCase());
  });
});
