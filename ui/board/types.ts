import type React from "react";
export type Flag = boolean | 0 | 1;
export type Category = "约K" | "聚餐" | "运动" | "出游" | "游戏" | "其他";
export type Lifecycle =
  "draft" | "scheduled" | "ongoing" | "ended" | "cancelled";
export type Attendance = "unknown" | "present" | "absent" | "late" | "left";
export type PersonStatus =
  "confirmed" | "waiting" | "tentative" | "invited" | "withdrawn";
export type Scope = "schedule" | "roster" | "attendance" | "settlement";
export type Vote = "yes" | "maybe" | "no";
export interface Named {
  id: string;
  name?: string;
  label?: string;
  nickname?: string;
}
export interface Arrangement {
  starts_at: string;
  timezone: string | null;
  duration_hours: number;
  location: string;
  fee_policy: string;
  description: string;
  withdrawal_deadline: string;
}
export interface Conditions {
  version: number;
  arrangement: Arrangement;
  summary: string;
  reason: string;
  created_at: string;
}
export interface Person extends Named {
  nickname: string;
  avatar_url?: string;
  waiting_position?: number | null;
  name?: string;
  status: PersonStatus;
  note: string;
  party_id: string;
  user_id?: string | null;
  is_me?: Flag;
  is_guest?: Flag;
  managed_by_me?: Flag;
  can_manage?: Flag;
  can_change?: Flag;
  can_withdraw?: Flag;
  can_respond?: Flag;
  can_claim?: Flag;
  manager_name: string;
  payer_kind: "manager" | "self";
  payer_id?: string;
  payer_name?: string;
  payment_locked?: Flag;
  withdrawal_requested: Flag;
  withdrawal_reason?: string;
  needs_withdrawal_request?: Flag;
  confirmation_state: "accepted" | "pending" | "declined";
  accepted_conditions_version: number | null;
  accepted_arrangement?: Arrangement | null;
  attendance: Attendance;
  attendance_note: string;
  arrived_at: string | null;
  left_at: string | null;
  queue_mode?: string;
}
export interface Claim {
  id: string;
  attendee_id: string;
  name: string;
  status: string;
  token: string;
  can_decide?: Flag;
  can_revoke?: Flag;
  requested_by_me?: Flag;
  requester_name?: string;
  reason?: string;
}
export interface Role extends Named {
  user_id: string;
  permissions: Scope[];
  name: string;
}
export interface ManagementInvitation {
  id: string;
  kind: string;
  target_name: string;
  token: string;
  permissions: Scope[];
  expires_at: string;
}
export interface DeliveryRow {
  id: number;
  state: string;
  created_at: string;
  sent_at?: string | null;
  simulated_at?: string | null;
  last_error?: string | null;
  kind?: string;
}
export interface Room {
  id: string;
  name: string;
  payer_id: string;
  person_ids: string[];
  payer_name?: string;
  payer_label?: string;
  payment_codes?: PaymentCode[];
  codes?: CodeChoice[];
}
export interface RoomInput extends Room {
  amount: string;
  merchant_mode: string;
  paid_amount?: string;
}
export interface CodeChoice {
  kind: string;
  code_id?: string;
  version?: number;
  image?: string;
  name?: string;
}
export interface PaymentCode {
  id?: string;
  kind: string;
  name: string;
  url: string;
  version?: number;
}
export interface LibraryCode extends PaymentCode {
  id: string;
}
export interface Allocation {
  person_id: string;
  amount?: string;
  minutes?: number;
  weight?: string;
  amount_cents?: number;
  item_id?: string;
}
export interface SettlementItem {
  id: string;
  name: string;
  amount: string;
  kind: string;
  scope: string;
  mode: string;
  reason: string;
  allocations: Allocation[];
  receipt: string | { version?: number; item_id: string } | null;
  receipt_digest?: string | null;
  amount_cents?: number;
  has_receipt?: boolean;
  breakdown?: Allocation[];
}
export interface RosterPerson extends Named {
  name: string;
  status: PersonStatus;
  attendance: Attendance;
  payer_id: string;
  manager_name: string;
  accepted_conditions_version: number | null;
  confirmation_state: string;
  accepted_arrangement: Arrangement | null;
  withdrawal_requested: Flag;
}
export interface PersonInput {
  id: string;
  share: string;
  reason: string;
  include?: boolean;
  payment_mode: string;
  payments: {
    payer_id: string;
    share?: string;
    amount?: string;
    amount_cents?: number;
    name?: string;
    label?: string;
  }[];
}
export interface SettlementPerson extends RosterPerson {
  share: string;
  reason: string;
  payments: {
    payer_id: string;
    name: string;
    label: string;
    amount_cents: number;
  }[];
  due_cents: number;
  allocations: { item_id: string; amount_cents: number }[];
}
export interface Balance extends Named {
  name: string;
  due_cents: number | null;
  contributed_cents: number;
  balance_cents: number | null;
  held_cents?: number;
  amount_cents?: number;
}
export interface RoomBalance extends Room {
  total_cents: number;
  balances: Balance[];
  cost_cents: number;
  held_cents: number;
  transfers: {
    from_id: string;
    to_id: string;
    from_name: string;
    to_name: string;
    amount_cents: number;
    kind: string;
  }[];
}
export interface SettlementDetail {
  people: SettlementPerson[];
  items: (Omit<SettlementItem, "receipt"> & {
    amount_cents: number;
    breakdown: (Allocation & { amount_cents: number })[];
  })[];
  payers: (Named & { name: string; amount_cents: number })[];
  rooms?: Room[];
  room_balances?: RoomBalance[];
  balances?: Balance[];
  collector?: Named;
  total_cents: number;
  note: string;
  reason: string;
  rounding_rule: string;
  changes?: string[];
  group_notice?: boolean;
  input: {
    people: PersonInput[];
    items: Omit<SettlementItem, "receipt">[];
    rooms?: RoomInput[];
    custom_payers: Named[];
    note: string;
    codes?: CodeChoice[];
  };
}
interface BillMeta {
  version?: number;
  payment_codes?: PaymentCode[];
  total_amount?: string;
  per_person_amount?: string;
  headcount?: number;
  note?: string;
  updated_at?: string;
  created_at?: string;
  kind?: string;
  actor_name?: string;
  changed_fields?: string[];
  rounding_difference_cents?: number;
  qr_url?: string;
  has_qr?: boolean;
  publisher_key?: string;
}
export type Bill = BillMeta &
  (
    | { mode: "detailed"; detail: SettlementDetail }
    | { mode: "legacy"; detail?: never }
  );
export interface FinanceSummary {
  state: string;
  detailed: boolean;
  has_records: boolean;
  pending_count: number;
  can_manage: boolean;
  can_report: boolean;
  my_balance_cents: number | null;
  my_outstanding_cents: number | null;
  my_refund_due_cents: number | null;
  outstanding_cents: number | null;
  refund_due_cents: number | null;
  total_due_cents: number | null;
  cost_cents: number;
  held_cents: number;
  deposit_cents: number;
  bill_version: number;
  last_seq: number;
  balances: Balance[];
  custodians: Balance[];
  room_balances: RoomBalance[];
}
export interface BoardEvent extends Arrangement {
  id: string;
  title: string;
  category: Category;
  owner_name: string;
  deadline: string;
  capacity: number;
  minimum_participants: number;
  revision: number;
  conditions_version: number;
  lifecycle: Lifecycle;
  phase: string;
  status: string;
  ends_at: string | null;
  archived_at: string | null;
  registration_open: Flag;
  bot_enabled: boolean;
  bot_feature_enabled: boolean;
  estimated_over: boolean;
  minimum_met: boolean;
  formation_state: string;
  confirmed_count: number;
  waiting_count: number;
  tentative_count?: number;
  queue_blocked: boolean;
  is_owner: boolean;
  is_cohost: boolean;
  can_settle: boolean;
  can_finish: boolean;
  can_assist_schedule: boolean;
  can_edit_schedule: boolean;
  can_manage_roster: boolean;
  can_attendance: boolean;
  can_onsite: boolean;
  can_join: boolean;
  can_manage_rooms: boolean;
  can_remove: boolean;
  visibility: "public" | "invitation";
  share_token: string | null;
  removal_blocker: string;
  draft_join_owner?: boolean | null;
  participants: Person[];
  my_attendees: Person[];
  my_registration: Person | null;
  pending_invitations: (Person & {
    invitation_token: string;
    expires_at?: string;
  })[];
  claim_invitations: Claim[];
  attendance_roster: Person[];
  cohosts: Role[];
  pending_management: ManagementInvitation[];
  management_scopes: Scope[];
  conditions: Conditions;
  pending_confirmation_count: number;
  declined_confirmation_count: number;
  cancellation_reason: string;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  bot_delivery?: DeliveryRow[];
  room_plan: Room[];
  settlement: Bill | null;
  finance: Omit<FinanceSummary, "balances" | "custodians" | "last_seq">;
  my_payable_cents?: number | null;
}
export interface PollOption {
  id: string;
  date: string;
  starts_at: string | null;
  ends_at: string | null;
  expired: boolean;
  can_vote: boolean;
  yes: number;
  maybe: number;
  no: number;
}
export interface Poll {
  id: string;
  title: string;
  category: Category;
  location: string;
  description: string;
  timezone: string;
  duration_hours: number | null;
  capacity: number;
  minimum_participants: number;
  fee_policy: string;
  deadline: string;
  revision: number;
  vote_revision: number;
  time_mode: "date" | "exact";
  status: string;
  is_owner: boolean;
  can_remove: boolean;
  can_vote: boolean;
  can_manage: boolean;
  has_voted: boolean;
  owner_name: string;
  my_choices: Record<string, Vote>;
  options: PollOption[];
  leading_option_ids: string[];
  respondent_count: number;
  event_id: string | null;
  event_deleted?: boolean;
  event_time?: Pick<BoardEvent, "starts_at" | "ends_at" | "timezone">;
  selected_option_id: string | null;
  reason: string;
  bot_enabled?: boolean;
  bot_feature_enabled?: boolean;
  bot_notice_enabled?: boolean;
  bot_delivery?: DeliveryRow[];
  respondents?: {
    id?: string;
    name: string;
    updated_at: string;
    choices: Record<string, Vote>;
  }[];
  history?: {
    action: string;
    details: { reason?: string };
    created_at: string;
  }[];
}
export interface QQ {
  enabled?: boolean;
  bound?: boolean;
  needs_reauth?: boolean;
  nickname?: string;
  avatar_url?: string;
}
export interface Me {
  authenticated: boolean;
  nickname: string;
  draft_scope: string;
  qq: QQ;
  privacy_accepted?: boolean;
  privacy_version?: string;
  allow_name_registration?: boolean;
}
export interface BoardI18n {
  locale: string;
  category(value: string): string;
}
export interface PendingOperation {
  key: string;
  path: string;
  data: { client_intent?: string };
}
export type ApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export interface BoardApi {
  <T = void>(path: string, method?: ApiMethod, data?: unknown): Promise<T>;
}
export interface BoardClient {
  request: BoardApi;
  setIdentity(scope: string): void;
  pending(): Promise<PendingOperation[]>;
  hasPending(id: string): Promise<boolean>;
  recover(
    key: string,
    retry: boolean,
  ): Promise<{ committed: boolean; result: BoardEvent }>;
}
export interface LegacyField {
  name: string;
  value: string;
  checked?: boolean;
}
export interface LegacyDraft {
  people?: PersonInput[];
  items?: SettlementItem[];
  rooms?: RoomInput[];
  custom?: Named[];
  paymentCodes?: CodeChoice[];
  slots?: { date: string; time: string }[];
  intent?: string;
  edit?: { custom?: Named[]; recordId?: string };
  fields: LegacyField[];
  dataset?: Record<string, string>;
  warning?: string;
  revision?: number;
  react?: never;
}
export interface ReactDraft<T> {
  react: 1;
  dataset?: never;
  value: T;
  revision?: number;
  warning?: string;
}
export interface Stored<T> {
  key: string;
  data: T;
  at: number;
}
export interface BoardStore {
  get<T>(key: string): Promise<Stored<T> | undefined>;
  put<T>(key: string, value: { data: T; at: number }): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  list<T>(prefix: string): Promise<Stored<T>[]>;
}
export interface BoardServices {
  client: BoardClient;
  storage: BoardStore;
  i18n: BoardI18n;
}
export interface FormStatus {
  busy?: boolean;
  dirty?: boolean;
  save?: () => Promise<void>;
  discard?: () => Promise<void>;
  choice?: boolean;
}
export interface DraftState extends Omit<FormStatus, "choice"> {
  dirty: boolean;
  choice: unknown;
  status: string;
  warning: string;
  storageError: string;
  save(): Promise<void>;
  discard(): Promise<void>;
  clear(): Promise<void>;
  ready(): boolean;
  restore(): void;
  retry(): Promise<void>;
}
export interface PrivacyReceiptData {
  request_id: string;
  status: string;
  shared_records: Record<string, number>;
}
export interface FinanceTransaction {
  actual_party_id?: string;
  funding?: string;
  funder_id?: string;
  room_name?: string;
  bill_version?: number;
  kind: string;
  amount_cents: number;
  from_id?: string;
  to_id?: string;
  custodian_id?: string;
  payer_id?: string;
  merchant?: string;
  method?: string;
  note?: string;
  reason?: string;
  occurred_at?: string;
  room_id?: string;
  reference_id?: string;
  parties?: Named[];
}
export interface FinanceEntry {
  id: string;
  seq: number;
  kind: string;
  payload: FinanceTransaction;
  occurred_at: string;
  created_at: string;
  actor_name: string;
  reversal_of: string | null;
  reversed: boolean;
  source_report_id?: string;
}
export interface FinanceReport {
  id: string;
  seq: number;
  payload: FinanceTransaction;
  reporter_name: string;
  created_at: string;
  status: string;
  reason?: string;
  decision_by?: string;
  decided_at?: string;
  can_withdraw: boolean;
  entry_id: string | null;
  entry_reversed: boolean;
}
export interface FinanceViewData {
  rooms: Room[];
  summary: FinanceSummary;
  close_blockers: string[];
  parties: Named[];
  reportable_ids: string[];
  default_custodian_id: string;
  entries: FinanceEntry[];
  next_before: number | null;
  reports: FinanceReport[];
  next_report_before: number | null;
  references: {
    id: string;
    kind: string;
    remaining_cents: number;
    payload: FinanceTransaction;
  }[];
}
export interface FinancePreview {
  command: Omit<FinanceCommand, "transaction" | "base_revision"> & {
    transaction?: FinanceTransaction;
  };
  data?: FinanceCommand;
  preview_token: string;
  projection: {
    cost_cents: number;
    held_cents: number;
    deposit_cents: number;
    credit: Record<string, number>;
  };
}
export interface SettlementRoster {
  people: RosterPerson[];
  payers: Named[];
  collector: Named;
  has_merchant_records: boolean;
  rooms: Room[];
  room_record_ids: string[];
}
export interface SettlementPreview {
  data?: SettlementWrite;
  snapshot: SettlementDetail;
  group_preview: string;
  preview_token: string;
  base_revision: number;
  base_version: number;
}
export interface PartyPreview {
  allocation: { name: string; status: PersonStatus }[];
  base_revision: number;
  preview_token: string;
  conditions_version: number;
}
export interface AccountData {
  devices: {
    id: string;
    current: boolean;
    created_at: string;
  }[];
  history: { action: string; created_at: string }[];
  qq: QQ;
  accounts: { scope: string; nickname: string; current: boolean }[];
}
export interface ClaimInfo {
  claimed?: boolean;
  title: string;
  name: string;
  status: PersonStatus;
  payer_name: string;
  payer_kind: string;
  base_revision: number;
  expires_at: string;
  claim_status: string;
  requested_by_me: boolean;
  duplicate: boolean;
  event_id: string;
}
export interface AuditData extends Partial<Omit<BoardEvent, "participants">> {
  event?: Partial<BoardEvent>;
  participants?: Person[];
  people?: Person[];
  attendee?: Person;
  nickname?: string;
  confirmation?: string;
  accepted_version?: number;
  owner_name?: string;
  roles?: Role[];
  target_name?: string;
  kind?: string;
}
export interface AuditEntry {
  id: number;
  before: AuditData;
  after: AuditData;
  actor_name: string;
  created_at: string;
  action: string;
  reason: string;
}
export interface Notice {
  id: string;
  read_at: string | null;
  event_id: string;
  message: string;
  created_at: string;
}
export type EventProps = { event: BoardEvent };
export type MemberMusicProfile =
  | { state: "unlinked" | "viewer_unlinked" }
  | {
      state: "ready";
      is_self: boolean;
      picks: {
        id: string;
        text: string;
        kind: "main" | "sub";
        level: 1 | 2 | 3 | 4;
        shared: boolean;
      }[];
    };
export interface ModalProps {
  detail: { eventId: string; title?: string; advanced?: boolean };
  eventForm: { event?: BoardEvent | null; copy?: boolean };
  party: EventProps & { tentative?: boolean; invite?: boolean };
  attendee: EventProps & { personId: string };
  invitation: { eventId: string; token: string };
  history: EventProps;
  rooms: EventProps;
  settlement: EventProps;
  settlementHistory: EventProps;
  finance: EventProps & { report?: boolean };
  financeForm: EventProps & {
    view: FinanceViewData;
    command: string;
    id?: string;
  };
  activity: EventProps & { action: string; id?: string | number };
  conditions: EventProps;
  management: EventProps & { settlement?: boolean };
  role: { eventId: string; token: string };
  attendance: EventProps;
  onsite: EventProps;
  pollForm: Record<string, never>;
  poll: { pollId: string; title?: string };
  profile: { next?: () => unknown };
  receipt: { receipt: PrivacyReceiptData };
  account: Record<string, never>;
  qqReturn: Record<string, never>;
  claim: { eventId: string; token: string };
  device: { token: string };
  qqReminder: Record<string, never>;
  notifications: Record<string, never>;
  confirm: {
    title: string;
    text: string;
    action: () => unknown;
    confirm?: string;
    cancel?: string;
    closeOnSuccess?: boolean;
  };
  draftClose: { target: string; status: FormStatus };
  link: { text: string; title: string };
}
export type ModalName = keyof ModalProps;
export type ModalEntry<K extends ModalName = ModalName> = {
  type: K;
  props: ModalProps[K];
  key: string;
  version: string;
};
export type OpenModal = <K extends ModalName>(
  type: K,
  ...args: {} extends ModalProps[K]
    ? [props?: ModalProps[K], options?: { historyless?: boolean }]
    : [props: ModalProps[K], options?: { historyless?: boolean }]
) => string;
export interface ModalContextValue {
  id?: string;
  entry?: ModalEntry;
  setTitle(title: string): void;
  register(status: FormStatus): void;
  close(): void;
  requestClose(): void;
}
export interface BoardContextValue extends BoardServices {
  api: BoardApi;
  me: Me;
  events: BoardEvent[];
  polls: Poll[];
  modals: ModalEntry[];
  updateMe(me: Me): void;
  setPolls: React.Dispatch<React.SetStateAction<Poll[]>>;
  apply(event: BoardEvent): void;
  refresh(options?: {
    loud?: boolean;
  }): Promise<{ events: BoardEvent[]; time_polls?: Poll[] } | null>;
  toast(message: string): void;
  open: OpenModal;
  close(key?: string, fromHistory?: boolean): void;
  requestClose(key: string, fromHistory?: boolean): boolean;
  openDetail(id: string, changeURL?: boolean): Promise<BoardEvent | null>;
  openPoll(id: string, changeURL?: boolean): Promise<Poll | undefined>;
  withProfile(task: () => unknown): unknown;
  eventUrl(event: BoardEvent, participantToken?: string): string;
  copy(text: string, label?: string): Promise<void>;
  confirm(
    title: string,
    text: string,
    action: () => unknown,
    labels?: { confirm?: string; cancel?: string; closeOnSuccess?: boolean },
  ): string;
  formStates: React.RefObject<Map<string, FormStatus>>;
  setFilter(filter: string): void;
}
export interface InvitationInfo {
  title: string;
  name: string;
  starts_at: string;
  timezone: string;
  location: string;
  base_revision: number;
  conditions: Conditions;
}
export interface RoleInfo {
  base_revision: number;
  kind: string;
  permissions: Scope[];
  title: string;
  owner_name: string;
  target_name: string;
}
export interface QQStatus {
  status: string;
  avatar_url?: string;
  qq_nickname: string;
  conflict: boolean;
  mode: string;
  current_nickname?: string;
  target_nickname?: string;
  existing_account?: boolean;
  attempt_id: string;
}
export interface DeviceInfo {
  nickname: string;
  expires_at: string;
}

export type EventWrite = Partial<
  Pick<
    BoardEvent,
    | "title"
    | "category"
    | "location"
    | "description"
    | "minimum_participants"
    | "capacity"
    | "duration_hours"
    | "timezone"
    | "starts_at"
    | "deadline"
    | "withdrawal_deadline"
    | "visibility"
    | "fee_policy"
    | "bot_enabled"
    | "lifecycle"
  >
> & {
  client_intent?: string;
  reason?: string;
  base_revision?: number;
  join_owner?: boolean;
  action?: string;
  outbox_id?: number;
};
export interface TransactionWrite {
  kind: string;
  amount: string;
  occurred_at: string;
  note: string;
  reason: string;
  room_id?: string;
  funding?: string;
  payer_id?: string;
  custodian_id?: string;
  funder_id?: string;
  from_id?: string;
  to_id?: string;
  merchant?: string;
  reference_id?: string;
  actual_party_id?: string;
  method?: string;
  custom_parties?: Named[];
}
export interface FinanceCommand {
  command: string;
  base_revision: number;
  reason?: string;
  report_id?: string;
  entry_id?: string;
  id?: string;
  transaction?: TransactionWrite;
}
export interface SettlementWrite {
  people: PersonInput[];
  items: SettlementItem[];
  custom_payers: Named[];
  note: string;
  reason: string;
  base_revision: number;
  base_version: number;
  reviewed_roster: boolean;
  convert_legacy: boolean;
  rooms: RoomInput[];
  payment_codes: CodeChoice[];
  group_notice: boolean;
  room_payment_details?: { occurred_at: string; method: string };
  merchant_payment?: {
    mode: string;
    payer_id?: string;
    amount?: string;
    merchant?: string;
    occurred_at?: string;
    method?: string;
  };
}
