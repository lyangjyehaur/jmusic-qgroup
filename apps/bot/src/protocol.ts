import { createHash } from 'node:crypto';
export const MARKDOWN_REJECTION_CODES = new Set([
  22006, 304036, 304061, 40034008, 40034009, 40034011, 40034124, 40034127,
]);
export const AUTH_CODES = new Set([11241, 11242]);
const RATE_LIMIT_CODES = new Set([40034100, 304049, 304050, 100001]);
const HARD_REJECT_CODES = new Set([
  304061,
  40054010,
  40054007,
  40054005,
  40034005,
  40034128,
  40034024,
  100007,
  100016,
  10004,
  ...MARKDOWN_REJECTION_CODES,
]);
const AUTHORIZATION_CODES = new Set([
  40034105, 40034101, 40054003, 40054016, 40054002, 304064, 304031, 1100104,
]);
export type APIObject = Record<string, unknown>;
const ERROR_HINT: Record<number, string> = {
  40034105: '無主動訊息權限：請群主在「群內 bot 權限頁」開『機器人主動在群聊內發言』',
  40034100: '主動訊息超過頻控（60/30 qpm、單關係 20 qpm、每群每天 1000 條）',
  40034101: '機器人不是群成員',
  40054003: '機器人不是群成員',
  40054010: '不允許發送 URL：消息 URL 白名單未報備該網域',
  40054005: '訊息被去重，msg_seq 要遞增',
  40054002: '機器人被禁言',
  40034005: 'msg_id 已過期（被動回覆 5 分鐘內有效）',
  40034128: '被動回覆時間或次數超限（每則最多 5 次）',
  40054007: '訊息長度超限',
  40054016: '機器人已下線',
  40064004: '撤回逾時（僅 2 分鐘內可撤回）',
  304061: '訊息內容無效',
  304064: '訂閱訊息未授權',
  304031: '私信已關閉',
  1100104: '該群已失效或不存在',
  50055001: '平台側異常，稍後重試',
};
export const apiErrorHint = (code: number | null) =>
  code === null ? '請對照官方錯誤碼表' : (ERROR_HINT[code] ?? '請對照官方錯誤碼表');
export function object(value: unknown): value is APIObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function apiCode(data: unknown): number | null {
  if (!object(data)) return null;
  const values = [data.code, data.err_code];
  return (
    (values.find((value) => Number.isSafeInteger(value) && value !== 0) as number | undefined) ??
    (values.some((value) => Number.isSafeInteger(value)) ? 0 : null)
  );
}
export function classifyAPIError(code: number | null, status = 200, data: unknown = null) {
  if (object(data) && data._unconfirmed_http) return 'unconfirmed' as const;
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) return 'rate_limit' as const;
  if (code !== null && HARD_REJECT_CODES.has(code)) return 'permanent' as const;
  if (code !== null && AUTHORIZATION_CODES.has(code)) return 'authorization' as const;
  return 'transient' as const;
}
export function reference(value: unknown) {
  return value === null || value === undefined || value === ''
    ? null
    : createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}
export function platformTrace(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
export function endpoint(url: string) {
  try {
    return new URL(url, 'https://placeholder.invalid').pathname
      .replace(/(\/v2\/(?:groups|users)\/)[^/]+/g, '$1:target')
      .replace(/(\/interactions\/)[^/]+/g, '$1:interaction');
  } catch {
    return '/invalid';
  }
}
export function validPlatformId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
/** Reviewed against the official QQ close-code table on 2026-11-17. */
export function gatewayCloseAction(code: number): 'stop' | 'identify' | 'resume' {
  if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)) return 'stop';
  if ([4006, 4007].includes(code) || (code >= 4900 && code <= 4913)) return 'identify';
  return 'resume';
}
