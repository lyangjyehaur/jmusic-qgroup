import { z } from 'zod';
import { AdminMusicErasureInput, AdminMusicErasureResult, EraseData, ErasureResult } from '@qgroup/contracts';
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const adminPath = z.string().refine(path => path === '/admin/music-reset' || /^\/admin\/music\/[^/]+\/erase$/.test(path) && (() => {
  try { const id = path.split('/')[3]!; return encodeURIComponent(decodeURIComponent(id)) === id && decodeURIComponent(id).length <= 80; } catch { return false; }
})());
export const MemberErasure = z.object({ kind: z.literal('member'), scope, input: EraseData, result: ErasureResult.strict().nullable(), cleaned: z.boolean() }).strict().superRefine((value, ctx) => {
  if (value.result && (value.result.requestId !== value.input.requestId || value.result.target !== value.input.target) || value.cleaned && !value.result) ctx.addIssue({ code: 'custom', message: '刪除回執不符原操作' });
});
export const AdminErasure = z.object({ kind: z.literal('admin'), scope, authority: scope, path: adminPath, input: AdminMusicErasureInput, result: AdminMusicErasureResult.strict().nullable() }).strict().superRefine((value, ctx) => {
  const reset = value.path === '/admin/music-reset';
  if (value.input.confirm !== (reset ? 'RESET' : 'DELETE') || value.result && (value.result.requestId !== value.input.requestId || value.result.command !== (reset ? 'reset_music' : 'delete_profile'))) ctx.addIssue({ code: 'custom', message: '刪除回執不符原操作' });
});
export const ErasureRecord = z.union([MemberErasure, AdminErasure]);
export type ErasureValue = z.infer<typeof ErasureRecord>;
export type MemberErasureValue = z.infer<typeof MemberErasure>;
export type AdminErasureValue = z.infer<typeof AdminErasure>;
export const erasureKey = (value: ErasureValue) => value.kind === 'member' ? 'member' : 'admin:' + value.scope + ':' + value.path;
export function parseErasure(key: string, raw: string) {
  const value = ErasureRecord.parse(JSON.parse(raw));
  if (erasureKey(value) !== key) throw Error('刪除紀錄與來源不符');
  return value;
}
