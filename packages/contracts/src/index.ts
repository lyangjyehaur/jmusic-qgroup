import { z } from 'zod';

export const Selection = z.object({ entryId: z.string().min(1).max(80), level: z.number().int().min(1).max(4) }).strict();
export const SaveProfile = z.object({
  profileId: z.string().min(1).max(80).nullable(),
  musicEpoch: z.number().int().min(0),
  revision: z.number().int().min(0),
  selections: z.array(Selection).min(1).max(20),
}).strict().refine(value => new Set(value.selections.map(s => s.entryId)).size === value.selections.length, '詞條不能重複');
export type SaveProfileInput = z.infer<typeof SaveProfile>;
export const Entry = z.object({ id: z.string(), name: z.string(), kind: z.enum(['main', 'sub']) });
export type MusicEntry = z.infer<typeof Entry>;
export const Catalog = z.object({ entries: z.array(Entry) });
export const Profile = z.object({ id: z.string(), revision: z.number().int(), selections: z.array(Selection), updatedAt: z.string() }).nullable();
export type MusicProfile = z.infer<typeof Profile>;
export const ContactQQ = z.string().trim().refine(value => !value || /^[1-9][0-9]{3,11}$/.test(value), 'QQ 號須為 4–12 位數字，或留空');
export const MusicContact = z.object({ profileId: z.string(), contactQQ: z.string(), source: z.enum(['legacy', 'self_reported']), revision: z.number().int().min(0) });
export const SaveMusicContact = z.object({ profileId: z.string().min(1).max(80), musicEpoch: z.number().int().min(0), revision: z.number().int().min(0), contactQQ: ContactQQ }).strict();
export const LookupMusicProfile = z.object({ query: z.string().trim().min(1).max(80) }).strict();
export const MemberMusicProfile = z.object({ id: z.string(), name: z.string(), contactQQ: z.string(), contactSource: z.enum(['legacy','self_reported','']), selections: z.array(Selection.extend({ name: z.string(), kind: z.enum(['main','sub']) })) });
export const PRIVACY_VERSION = '2026-11-10';
const sessionSecurity = { scope: z.string(), csrf: z.string(), qqEnabled: z.boolean(), privacyVersion: z.string(), privacyAccepted: z.boolean(), nameRegistrationEnabled: z.boolean() };
export const QQSummary = z.object({ bound: z.boolean(), nickname: z.string(), avatarUrl: z.string(), unionidBound: z.boolean(), needsReauth: z.boolean() });
export const Session = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false), ...sessionSecurity }),
  z.object({ authenticated: z.literal(true), nickname: z.string(), administrator: z.boolean(), musicEpoch: z.number().int().min(0), ...sessionSecurity, qq: QQSummary }),
]);
export type Viewer = z.infer<typeof Session>;
export const QQStart = z.object({ mode: z.enum(['bind', 'login']), confirm: z.literal(true), returnTo: z.string().max(4096).default('/'), acceptPrivacy: z.boolean().default(false), privacyVersion: z.string() }).strict();
export const QQStartResult = z.object({ authorizeUrl: z.string().url() });
export const QQFinish = z.object({ attemptId: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
export const AuthResult = z.object({ returnTo: z.string(), switched: z.boolean(), newAccount: z.boolean(), qqUnionidBound: z.boolean().optional() });
export const Nickname = z.string().trim().refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 24 && !/[\x00-\x1f\x7f]/.test(value), '稱呼須為 1–24 字');
export const AccountProfile = z.object({ nickname: z.string(), revision: z.number().int().min(0) });
export const SaveNickname = z.object({ nickname: Nickname, revision: z.number().int().min(0) }).strict();
export const RegisterName = z.object({
  nickname: Nickname,
  confirm: z.literal(true), acceptPrivacy: z.literal(true), privacyVersion: z.literal(PRIVACY_VERSION), returnTo: z.string().max(4096).default('/'),
}).strict();
export const RegistrationSettings = z.object({ enabled: z.boolean(), revision: z.number().int().min(0), adminCsrf: z.string() });
export const UpdateRegistrationSettings = z.object({ enabled: z.boolean(), revision: z.number().int().min(0), confirm: z.literal(true) }).strict();
export const QQStatus = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['expired', 'pending', 'exchanging', 'failed', 'used']), returnTo: z.string().default('/') }),
  z.object({ status: z.literal('verified'), attemptId: z.string(), mode: z.enum(['bind', 'login']), qqNickname: z.string(), currentNickname: z.string(), targetNickname: z.string(), existingAccount: z.boolean(), conflict: z.boolean(), returnTo: z.string() }),
]);
export const AccountList = z.object({ accounts: z.array(z.object({ scope: z.string(), nickname: z.string(), current: z.boolean() })) });
export const Confirm = z.object({ confirm: z.literal(true) }).strict();
export const SwitchAccount = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
export const DeviceList = z.object({ devices: z.array(z.object({ id: z.string(), current: z.boolean(), createdAt: z.string() })) });
export const IssueDeviceLink = z.object({ confirm: z.literal(true), authorizeOwnDevice: z.literal(true) }).strict();
export const IssuedDeviceLink = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/), expiresAt: z.string() });
export const ReadDeviceLink = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();
export const AcceptDeviceLink = ReadDeviceLink.extend({ confirm: z.literal(true), acceptAccess: z.literal(true) });
export const DeviceLinkView = z.object({ status: z.enum(['pending', 'accepted']), nickname: z.string(), expiresAt: z.string(), alreadyAuthorized: z.boolean() });
export const RevokeDevice = z.object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
export const AccountHistory = z.object({ history: z.array(z.object({ id: z.number().int(), action: z.string(), createdAt: z.string() })), nextCursor: z.number().int().nullable() });
export const Ok = z.object({ ok: z.literal(true) });
export const ErasureProof = z.object({ requestId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const EraseData = ErasureProof.extend({ target: z.enum(['music', 'account', 'both']), confirm: z.literal(true), profileId: z.string().max(80).nullable(), profileRevision: z.number().int().min(0) }).strict();
export const ErasureResult = z.object({ requestId: z.string(), target: z.enum(['music', 'account', 'both']), status: z.enum(['completed', 'shared_review']) });
export const PrivacySummary = z.object({ profile: Profile, activeEvents: z.number().int(), activePolls: z.number().int() });
export const AdminLogin = z.object({ key: z.string().refine(value => Array.from(value).length >= 32 && Array.from(value).length <= 256), confirm: z.literal(true) }).strict();
export const AdminSession = z.object({ authenticated: z.literal(true), authMethod: z.enum(['account', 'credential']), scope: z.string(), adminCsrf: z.string(), currentUserId: z.string().nullable(), rescueEnabled: z.boolean() });
export const AdminUser = z.object({ id: z.string(), nickname: z.string(), createdAt: z.string(), isAdmin: z.boolean(), revision: z.number().int(), note: z.string(), manualQQ: z.string(), metadataRevision: z.number().int(), metadataUpdatedAt: z.string().nullable(), identities: z.array(z.object({ provider: z.string(), displayName: z.string(), unionidBound: z.boolean() })) });
export const AdminUsers = z.object({ users: z.array(AdminUser), total: z.number().int(), offset: z.number().int(), limit: z.literal(20) });
export const SaveAdminRole = z.object({ isAdmin: z.boolean(), revision: z.number().int().min(0), confirm: z.literal(true) }).strict();
export const SaveAdminMetadata = z.object({ note: z.string().trim().refine(value => Array.from(value).length <= 1000), manualQQ: z.string().trim().refine(value => !value || /^[1-9][0-9]{4,11}$/.test(value)), revision: z.number().int().min(0), confirm: z.literal(true) }).strict();
export const AdminRoleHistory = z.object({ history: z.array(z.object({ id: z.number().int(), before: z.boolean(), after: z.boolean(), revision: z.number().int(), createdAt: z.string(), actor: z.string() })), nextCursor: z.number().int().nullable() });
export const Activity = z.object({
  id: z.string(), title: z.string(), category: z.string(), location: z.string(),
  startsAt: z.string(), deadline: z.string(), durationHours: z.number().nullable(), timezone: z.string().nullable(),
  description: z.string(), capacity: z.number().int(), minimumParticipants: z.number().int(),
  lifecycle: z.string(), phase: z.string(), registrationOpen: z.boolean(), estimatedOver: z.boolean(),
  archived: z.boolean(), confirmed: z.number().int(), waiting: z.number().int(), tentative: z.number().int(),
});
export type ActivityView = z.infer<typeof Activity>;
export const ActivityList = z.object({ events: z.array(Activity), page: z.number().int(), hasMore: z.boolean() });
export const ApiFailure = z.object({ code: z.string(), message: z.string() });

export const AdminPrivacyRequest = z.object({ id: z.string(), userId: z.string(), status: z.enum(['completed', 'shared_review']), createdAt: z.string(), updatedAt: z.string(), note: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), sharedRecords: z.record(z.string(), z.number().int().positive()) });
export const AdminPrivacyQueue = z.object({ requests: z.array(AdminPrivacyRequest), total: z.number().int(), offset: z.number().int(), limit: z.literal(20) });
export const SavePrivacyReview = z.object({ note: z.string().trim().refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 1000), revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
