import { z } from 'zod';

export const PaymentKind = z.enum(['wechat', 'alipay', 'other']);
export const PaymentCodeId = z.string().regex(/^[a-f0-9]{16}$/);
export const PaymentCodeName = z.string().trim().refine(value => Array.from(value).length <= 40 && !/[\x00-\x1f\x7f]/.test(value), '收款碼名稱最多 40 字');
export const PaymentImage = z.string().min(1).max(2800000);
export const PaymentCodeSource = z.object({ event_id: z.string().min(1).max(80), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), kind: PaymentKind }).strict();
const common = { kind: PaymentKind, name: PaymentCodeName, confirm: z.literal(true) };
export const CreatePaymentCode = z.union([
  z.object({ ...common, image: PaymentImage }).strict(),
  z.object({ ...common, source: PaymentCodeSource }).strict(),
]);
export const ArchivePaymentCode = z.object({ confirm: z.literal(true) }).strict();
export const PaymentCode = z.object({ id: PaymentCodeId, kind: PaymentKind, name: z.string(), created_at: z.string(), url: z.string() });
export const PaymentCodeLibrary = z.object({ codes: z.array(PaymentCode) });
export const FrozenPaymentCode = z.object({ kind: PaymentKind, name: z.string(), url: z.string() });
export const SettlementAssets = z.object({ codes: z.array(FrozenPaymentCode), receipts: z.array(z.object({ item_id: PaymentCodeId, name: z.string(), url: z.string() })), can_save: z.boolean() });
export const SettlementAssetVersions = z.object({ versions: z.array(z.object({ version: z.number().int().positive(), total_cents: z.number().int().nonnegative(), headcount: z.number().int().positive(), actor_name: z.string(), updated_at: z.string() })), next_before: z.number().int().positive().nullable() });
/** Settlement choices are resolved again inside the eventual invoice write transaction. */
export const SettlementPaymentChoice = z.union([
  z.object({ kind: PaymentKind, code_id: PaymentCodeId }).strict(),
  z.object({ kind: PaymentKind, image: PaymentImage, name: PaymentCodeName }).strict(),
  z.object({ kind: PaymentKind, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
export const SettlementPaymentChoices = z.array(SettlementPaymentChoice).max(3).refine(values => new Set(values.map(value => value.kind)).size === values.length, '每種收款方式最多一張');
export const SettlementReceiptChoice = z.union([
  PaymentImage,
  z.object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), item_id: PaymentCodeId }).strict(),
]).nullable();
