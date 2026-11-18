import { ErasureProof } from './erasure-proof';
export * from './legacy-local';
export * from './create-intents';
export { OperationReceipt } from './operations';
export { ErasureProof } from './erasure-proof';
import { z } from 'zod';
export * from './activity-arrangements';
export * from './activity-registration';
export * from './activity-invitations';
export * from './activity-claims';
export * from './activity-delegation';
export * from './payment-assets';
export * from './settlements';
export * from './time-polls';
export * from './activity-rooms';
export * from './music-catalog';

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
export const MusicFields = z.object({ profileId: z.string(), name: z.string(), note: z.string(), noteAt: z.number(), gender: z.string(), genderPublic: z.boolean(), revision: z.number().int().min(0) });
// Existing source text can exceed current editing limits. Validate changed fields
// against the actual prior value on the server, without silently truncating imports.
export const SaveMusicFields = z.object({ profileId: z.string().min(1).max(80), musicEpoch: z.number().int().min(0), revision: z.number().int().min(0), name: z.string().max(16384), note: z.string().max(16384), gender: z.string().max(16384), genderPublic: z.boolean() }).strict();
export const LookupMusicProfile = z.object({ query: z.string().trim().min(1).max(80) }).strict();
export const MemberMusicProfile = z.object({ id: z.string(), name: z.string(), contactQQ: z.string(), contactSource: z.enum(['legacy','self_reported','']), gender: z.string(), note: z.string(), selections: z.array(Selection.extend({ name: z.string(), kind: z.enum(['main','sub']) })) });
export const ActivityRoster = z.object({eventId:z.string(),revision:z.number().int(),participants:z.array(z.object({
  id:z.string(),name:z.string(),note:z.string(),status:z.enum(['confirmed','waiting','tentative']),position:z.number().int(),waitingPosition:z.number().int().nullable(),
  isMe:z.boolean(),isGuest:z.boolean(),managedByMe:z.boolean(),managerName:z.string(),payerName:z.string(),withdrawalRequested:z.boolean(),confirmationState:z.string(),attendance:z.string(),avatarUrl:z.string(),
}))});
export const AttendeeMusic = z.discriminatedUnion('state',[
  z.object({state:z.literal('unlinked')}),
  z.object({state:z.literal('viewer_unlinked')}),
  z.object({state:z.literal('ready'),profileId:z.string(),name:z.string(),isSelf:z.boolean(),picks:z.array(Selection.extend({name:z.string(),kind:z.enum(['main','sub']),shared:z.boolean()}))}),
]);
export const PRIVACY_VERSION = '2026-11-10';
const sessionSecurity = { scope: z.string(), csrf: z.string(), qqEnabled: z.boolean(), privacyVersion: z.string(), privacyAccepted: z.boolean(), nameRegistrationEnabled: z.boolean() };
export const QQSummary = z.object({ bound: z.boolean(), nickname: z.string(), avatarUrl: z.string(), unionidBound: z.boolean(), needsReauth: z.boolean() });
export const Session = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false), ...sessionSecurity }),
  z.object({ authenticated: z.literal(true), nickname: z.string(), administrator: z.boolean(), musicEpoch: z.number().int().min(0), ...sessionSecurity, qq: QQSummary }),
]);
export type Viewer = z.infer<typeof Session>;
export const QQStart = z.object({ mode: z.enum(['bind', 'login']), confirm: z.literal(true), returnTo: z.string().max(4096).default('/'), acceptPrivacy: z.boolean().default(false), privacyVersion: z.string(), musicClaimId: z.string().uuid().optional() }).strict();
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
export const StartMusicClaim = z.object({ requestId: z.string().uuid(), legacyQQ: z.string().trim().regex(/^[0-9]{4,12}$/), pin: z.string().trim().regex(/^[0-9]{4,6}$/), consent: z.literal(true) }).strict();
export const ConfirmMusicClaim = z.object({ claimId: z.string().uuid(), confirm: z.literal(true) }).strict();
export const MusicClaimStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.enum(['pending','authorized','completed','unavailable']), claimId: z.string().uuid(), expiresAt: z.string(), profileId: z.string(), name: z.string(), legacyQQ: z.string(), targetNickname: z.string() }),
]);

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
  feePolicy:z.string(),withdrawalDeadline:z.string().nullable(),conditionsVersion:z.number().int(),changeSummary:z.string(),visibility:z.string(),
});
export type ActivityView = z.infer<typeof Activity>;
export const ActivityList = z.object({ events: z.array(Activity), page: z.number().int(), hasMore: z.boolean() });
export const ApiFailure = z.object({ code: z.string(), message: z.string() });

export const AdminPrivacyRequest = z.object({ id: z.string(), userId: z.string(), status: z.enum(['completed', 'shared_review']), createdAt: z.string(), updatedAt: z.string(), note: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), sharedRecords: z.record(z.string(), z.number().int().positive()) });
export const AdminPrivacyQueue = z.object({ requests: z.array(AdminPrivacyRequest), total: z.number().int(), offset: z.number().int(), limit: z.literal(20) });
export const SavePrivacyReview = z.object({ note: z.string().trim().refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 1000), revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
export const AdminMusicOwner = z.object({ id: z.string(), nickname: z.string() });
export const AdminMusicProfile = z.object({ id: z.string(), name: z.string(), legacyKey: z.string(), hasPin: z.boolean(), owner: AdminMusicOwner.nullable(), status: z.enum(['oauth','prelinked','unlinked','account']), revision: z.number().int(), selections: z.array(Selection.extend({ name: z.string(), kind: z.enum(['main','sub']) })) });
export const AdminMusicSearch = z.object({ search: z.string().trim().max(100).default(''), status: z.enum(['all','oauth','prelinked','unlinked','account']).default('all'), offset: z.number().int().min(0).max(1000000).default(0) }).strict();
export const AdminMusicProfiles = z.object({ profiles: z.array(AdminMusicProfile), total: z.number().int(), offset: z.number().int(), limit: z.literal(20) });
export const PreviewMusicLink = z.object({ targetUserId: z.string().min(1).max(128).nullable() }).strict();
export const AdminMusicLinkPreview = z.object({ profile: AdminMusicProfile, target: AdminMusicOwner.nullable(), revision: z.string().regex(/^[a-f0-9]{64}$/) });
export const SaveMusicLink = PreviewMusicLink.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(500), confirm: z.literal(true) }).strict();
export const AdminMusicHistory = z.object({ history: z.array(z.object({ id: z.number().int(), revision: z.number().int().nullable(), beforeUserId: z.string().nullable(), afterUserId: z.string().nullable(), actor: z.string(), reason: z.string(), createdAt: z.string(), source: z.enum(['unified','legacy']), legacyId: z.number().int().nullable(), createdSeconds: z.number().nullable() })), nextCursor: z.number().int().nullable() });
export const ResetMusicPin = z.object({ pin: z.string().trim().regex(/^[0-9]{4,6}$/), revision: z.number().int().min(0), reason: z.string().trim().min(1).max(500), confirm: z.literal(true) }).strict();
export const MusicPinResultRequest = z.object({ requestId: z.string().uuid() }).strict();
export const MusicPinResult = z.object({ status: z.enum(['not_found','completed']) });
export const AdminMusicPinHistory = z.object({ history: z.array(z.object({ id: z.number().int(), revision: z.number().int(), actor: z.string(), reason: z.string(), createdAt: z.string() })), nextCursor: z.number().int().nullable() });

export * from './activity-attendance';

export * from './activity-history';
export * from './inbox';
export * from './finance';
export * from './music-matching';
export * from './music-share';
export * from './music-trend';
export * from './music-circles';
export * from './music-shouts';
export * from './admin-music-catalog';

export * from './admin-music-erasure';

export * from './appearance';
export * from './backups';
export * from './music-rooms';
export * from './bot-policy';
export * from './bot-deliveries';
export * from './activity-access';
export * from './finance-origin';
