import { z } from 'zod';
import { ConditionArrangement } from './activity-arrangements';
import { FinancePayload, FinanceRoomBalance } from './finance';
import { SettlementPaymentChoices, SettlementReceiptChoice } from './payment-assets';

const text = (maximum: number, required = false) =>
  z
    .string()
    .trim()
    .refine((value) => Array.from(value).length <= maximum && (!required || !!value));
const revision = z.number().int().nonnegative(),
  cents = z.number().int().safe(),
  id = z.string().regex(/^[a-f0-9]{16}$/);
export const SettlementAmount = z.string().regex(/^[0-9]{1,7}(?:\.[0-9]{1,2})?$/);
export const SettlementWeight = z
  .string()
  .regex(/^[0-9]{1,4}(?:\.[0-9]{1,3})?$/)
  .refine((value) => Number(value) <= 1000);
export const SettlementPartyId = z.string().regex(/^(account|person|custom):[a-f0-9]{16}$/);
export const SettlementPayer = z.object({ id: z.string(), name: z.string(), label: z.string() });
export const SettlementRosterPerson = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  status: z.string(),
  attendance: z.string(),
  manager_name: z.string(),
  payer_id: z.string(),
  accepted_conditions_version: revision.nullable(),
  confirmation_state: z.string(),
  accepted_arrangement: ConditionArrangement.nullable(),
  withdrawal_requested: z.boolean(),
});
export const SettlementPaymentInput = z
  .object({ payer_id: SettlementPartyId, share: SettlementWeight.optional(), amount: SettlementAmount.optional() })
  .strict();
export const SettlementPersonInput = z
  .object({
    id: z.string().min(1).max(80),
    share: SettlementWeight.default('1'),
    reason: text(300).default(''),
    payment_mode: z.enum(['shares', 'fixed']).default('shares'),
    payments: z.array(SettlementPaymentInput).min(1).max(20).optional(),
  })
  .strict();
export const SettlementAllocation = z
  .object({
    person_id: z.string().min(1).max(80),
    amount: SettlementAmount.optional(),
    weight: SettlementWeight.optional(),
    minutes: z.number().int().min(0).max(1440).optional(),
  })
  .strict();
export const SettlementItemInput = z
  .object({
    id,
    name: text(80, true),
    kind: z.enum(['expense', 'refund', 'discount']).default('expense'),
    amount: SettlementAmount,
    scope: z.enum(['common', 'selected']).default('common'),
    mode: z.enum(['shares', 'equal', 'weights', 'fixed', 'duration']).default('shares'),
    reason: text(300).default(''),
    allocations: z.array(SettlementAllocation).max(500).default([]),
    receipt: SettlementReceiptChoice.default(null),
  })
  .strict();
export const RoomPlanInput = z
  .object({
    id,
    name: text(40, true),
    payer_id: SettlementPartyId,
    person_ids: z.array(z.string().min(1).max(80)).max(500),
  })
  .strict();
export const ActualRoomInput = RoomPlanInput.extend({
  amount: SettlementAmount,
  merchant_mode: z.enum(['unpaid', 'paid', 'recorded']).default('unpaid'),
  paid_amount: SettlementAmount.optional(),
}).strict();
export const SettlementRoom = z.object({
  id: z.string(),
  name: z.string(),
  payer_id: z.string(),
  payer_name: z.string(),
  payer_label: z.string(),
  person_ids: z.array(z.string()),
});
export const SettlementMerchantPayment = z
  .object({
    mode: z.enum(['unpaid', 'paid', 'recorded']),
    amount: SettlementAmount.optional(),
    payer_id: SettlementPartyId.optional(),
    occurred_at: z.string().max(40).optional(),
    method: z.enum(['wechat', 'alipay', 'qq', 'cash', 'other']).default('other'),
    merchant: text(80).default(''),
    note: text(1000).default(''),
    reason: text(300).default(''),
  })
  .strict();
export const SettlementInput = z
  .object({
    revision,
    base_version: revision,
    reviewed_roster: z.literal(true),
    convert_legacy: z.boolean().default(false),
    people: z.array(SettlementPersonInput).max(500),
    items: z.array(SettlementItemInput).max(50).default([]),
    custom_payers: z
      .array(z.object({ id: z.string().regex(/^custom:[a-f0-9]{16}$/), name: text(24, true) }).strict())
      .max(50)
      .default([]),
    rooms: z.array(ActualRoomInput).max(50).optional(),
    merchant_payment: SettlementMerchantPayment.optional(),
    room_payment_details: SettlementMerchantPayment.omit({
      mode: true,
      amount: true,
      payer_id: true,
      merchant: true,
    }).optional(),
    note: text(1000).default(''),
    reason: text(300).default(''),
    payment_codes: SettlementPaymentChoices.default([]),
    group_notice: z.boolean().default(false),
  })
  .strict();
export const SaveSettlement = SettlementInput.extend({
  preview_token: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
}).strict();
const inputPerson = z.object({
  id: z.string(),
  share: z.string(),
  reason: z.string(),
  payment_mode: z.enum(['shares', 'fixed']),
  payments: z.array(z.object({ payer_id: z.string(), share: z.string().optional(), amount: z.string().optional() })),
});
const item = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['expense', 'refund', 'discount']),
  amount: z.string(),
  scope: z.enum(['common', 'selected']),
  mode: z.enum(['shares', 'equal', 'weights', 'fixed', 'duration']),
  reason: z.string(),
  allocations: z.array(SettlementAllocation),
  receipt_digest: z.string().nullable(),
});
export const SettlementSnapshot = z.object({
  people: z.array(
    SettlementRosterPerson.extend({
      share: z.string(),
      reason: z.string(),
      due_cents: cents,
      allocations: z.array(z.object({ item_id: z.string(), amount_cents: cents })),
      payments: z.array(z.object({ payer_id: z.string(), name: z.string(), label: z.string(), amount_cents: cents })),
    }),
  ),
  items: z.array(
    item.extend({
      amount_cents: cents,
      breakdown: z.array(SettlementAllocation.extend({ amount_cents: cents })),
      has_receipt: z.boolean(),
    }),
  ),
  payers: z.array(SettlementPayer.extend({ amount_cents: cents })),
  total_cents: cents.nonnegative(),
  note: z.string(),
  reason: z.string(),
  qr_digest: z.string().nullable(),
  payment_codes: z.array(
    z.object({ kind: z.enum(['wechat', 'alipay', 'other']), name: z.string(), digest: z.string() }),
  ),
  rounding_rule: z.string(),
  input: z.object({
    people: z.array(inputPerson),
    items: z.array(item),
    custom_payers: z.array(z.object({ id: z.string(), name: z.string() })),
    rooms: z.array(ActualRoomInput.extend({ payer_name: z.string(), payer_label: z.string() })).optional(),
  }),
  rooms: z.array(SettlementRoom).optional(),
  collector: z.object({ id: z.string(), name: z.string() }).optional(),
  journal_seq: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  merchant_payment: FinancePayload.optional(),
  merchant_payments: z.array(FinancePayload).optional(),
  room_balances: z.array(FinanceRoomBalance).optional(),
  balances: z.array(SettlementPayer.extend({ due_cents: cents, contributed_cents: cents, balance_cents: cents })),
  group_notice: z.boolean(),
  changes: z.array(z.string()),
});
export const SettlementBill = z.object({
  version: revision,
  total_amount: z.string(),
  headcount: revision,
  per_person_amount: z.string().nullable(),
  rounding_difference_cents: cents,
  note: z.string(),
  updated_at: z.string(),
  actor_name: z.string(),
  kind: z.string(),
  changed_fields: z.array(z.string()),
  mode: z.enum(['legacy', 'detailed']),
  publisher_key: z.string().nullable(),
  detail: SettlementSnapshot.nullable(),
});
export const SettlementContext = z.object({
  id: z.string(),
  title: z.string(),
  revision,
  lifecycle: z.string(),
  is_owner: z.boolean(),
  can_manage: z.boolean(),
  people: z.array(SettlementRosterPerson),
  payers: z.array(SettlementPayer),
  collector: z.object({ id: z.string(), name: z.string() }),
  has_merchant_records: z.boolean(),
  rooms: z.array(SettlementRoom),
  room_record_ids: z.array(z.string()),
  bill: SettlementBill.nullable(),
});
export const SettlementPreview = z.object({
  snapshot: SettlementSnapshot,
  group_preview: z.string(),
  preview_token: z.string(),
  base_revision: revision,
  base_version: revision,
});
export const SettlementResult = z.object({ id: z.string(), revision, version: revision, changed: z.boolean() });
export const SettlementHistory = z.object({ revisions: z.array(SettlementBill), next_before: revision.nullable() });
export const SaveRoomPlan = z
  .object({
    revision,
    rooms: z.array(RoomPlanInput).max(50),
    reason: text(300).default(''),
    music_source_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    confirm: z.literal(true),
  })
  .strict();
export const RoomPlanView = z.object({
  id: z.string(),
  title: z.string(),
  revision,
  version: revision,
  can_manage: z.boolean(),
  blocked_reason: z.string(),
  rooms: z.array(SettlementRoom),
  people: z.array(SettlementRosterPerson),
  payers: z.array(SettlementPayer),
});

export const SettlementView = z.object({
  id: z.string(),
  title: z.string(),
  revision,
  can_manage: z.boolean(),
  bill: SettlementBill.nullable(),
});
