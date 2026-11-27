import { AppSettingsPage, PWAProvider } from './pwa';
import { AppearanceProvider,bootstrapAppearance } from './appearance-preferences';
import React from 'react';
import { lazyPage } from './lazy-page';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmptyState } from 'yahha-ui';
import { LegacyLocalGuard } from './legacy-local';
import { LegacyEntryLayout } from './activity-entry';
import { MusicWorkspace } from './music-selection';
import './kimi/legacy.css';
import 'yahha-ui/style.css';
import './kimi/button-links.css';
import './kimi/scoped.css';
import './kimi/adapter.css';
import './kimi/theme.css';
import './music-save-dock.css';
import './forms.css';
import './participation.css';
import './kimi/shell.css';
import './kimi/people.css';
import './kimi/density.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
const AdminBotPage = lazyPage(() => import('./admin-bot').then(module => ({ default: module.AdminBotPage })));
const AdminBotDeliveriesPage = lazyPage(() => import('./bot-deliveries').then(module => ({ default: module.AdminBotDeliveriesPage })));
const BotDeliveriesPage = lazyPage(() => import('./bot-deliveries').then(module => ({ default: module.BotDeliveriesPage })));
const MusicRoomsPage = lazyPage(() => import('./music-rooms').then(module => ({ default: module.MusicRoomsPage })));
const AdminAppearancePage = lazyPage(() => import('./admin-appearance').then(module => ({ default: module.AdminAppearancePage })));
const AdminBackupsPage = lazyPage(() => import('./admin-backups').then(module => ({ default: module.AdminBackupsPage })));
const AppearancePage = lazyPage(() => import('./appearance').then(module => ({ default: module.AppearancePage })));
const AdminMusicErasurePage = lazyPage(() => import('./admin-music-erasure').then(module => ({ default: module.AdminMusicErasurePage })));
const InboxPage = lazyPage(() => import('./inbox').then(module => ({ default: module.InboxPage })));
const LegacyLocalPage = lazyPage(() => import('./legacy-local').then(module => ({ default: module.LegacyLocalPage })));
const Activities = lazyPage(() => import('./activities').then(module => ({ default: module.Activities })));
const ActivityWorkspace = lazyPage(() => import('./activity-workspace').then(module => ({ default: module.ActivityWorkspace })));
const ActivityDraftPage = lazyPage(() => import('./activity-drafts').then(module => ({ default: module.ActivityDraftPage })));
const ActivityDraftsPage = lazyPage(() => import('./activity-drafts').then(module => ({ default: module.ActivityDraftsPage })));
const ActivityArrangementPage = lazyPage(() => import('./activity-drafts').then(module => ({ default: module.ActivityArrangementPage })));
const ActivityConditionsPage = lazyPage(() => import('./activity-conditions').then(module => ({ default: module.ActivityConditionsPage })));
const ActivityLifecyclePage = lazyPage(() => import('./activity-lifecycle').then(module => ({ default: module.ActivityLifecyclePage })));
const ActivityRegistrationPage = lazyPage(() => import('./activity-registration').then(module => ({ default: module.ActivityRegistrationPage })));
const ActivityInvitationsPage = lazyPage(() => import('./activity-invitations').then(module => ({ default: module.ActivityInvitationsPage })));
const AcceptActivityInvitationPage = lazyPage(() => import('./activity-invitations').then(module => ({ default: module.AcceptActivityInvitationPage })));
const ActivityClaimsPage = lazyPage(() => import('./activity-claims').then(module => ({ default: module.ActivityClaimsPage })));
const RequestAttendeeClaimPage = lazyPage(() => import('./activity-claims').then(module => ({ default: module.RequestAttendeeClaimPage })));
const ActivityFinancePage = lazyPage(() => import('./activity-finance').then(module => ({ default: module.ActivityFinancePage })));
const ActivitySettlementPage = lazyPage(() => import('./activity-settlement').then(module => ({ default: module.ActivitySettlementPage })));
const ActivitySettlementEditor = lazyPage(() => import('./activity-settlement').then(module => ({ default: module.ActivitySettlementEditor })));
const RoomPlanHistoryPage = lazyPage(() => import('./activity-room-overview').then(module => ({ default: module.RoomPlanHistoryPage })));
const MyMusicEntriesPage = lazyPage(() => import('./music-entries').then(module => ({ default: module.MyMusicEntriesPage })));
const MusicEntryEditorPage = lazyPage(() => import('./music-entries').then(module => ({ default: module.MusicEntryEditorPage })));
const ActivityRoomsPage = lazyPage(() => import('./activity-rooms').then(module => ({ default: module.ActivityRoomsPage })));
const ActivityHistoryPage = lazyPage(() => import('./activity-history').then(module => ({ default: module.ActivityHistoryPage })));
const ActivityAttendancePage = lazyPage(() => import('./activity-attendance').then(module => ({ default: module.ActivityAttendancePage })));
const ParticipationPage = lazyPage(() => import('./participation').then(module => ({ default: module.ParticipationPage })));
const ActivityDelegationPage = lazyPage(() => import('./activity-delegation').then(module => ({ default: module.ActivityDelegationPage })));
const AcceptActivityDelegationPage = lazyPage(() => import('./activity-delegation').then(module => ({ default: module.AcceptActivityDelegationPage })));
const TimePollPage = lazyPage(() => import('./time-polls').then(module => ({ default: module.TimePollPage })));
const TimePollsPage = lazyPage(() => import('./time-polls').then(module => ({ default: module.TimePollsPage })));
const NewTimePollPage = lazyPage(() => import('./time-polls').then(module => ({ default: module.NewTimePollPage })));
const ActivityAccessPage = lazyPage(() => import('./activity-access').then(module => ({ default: module.ActivityAccessPage })));
const ActivitySharePage = lazyPage(() => import('./activity-access').then(module => ({ default: module.ActivitySharePage })));
const ContactPage = lazyPage(() => import('./contact').then(module => ({ default: module.ContactPage })));
const Music = lazyPage(() => import('./music').then(module => ({ default: module.Music })));
const MusicEntryPage = lazyPage(() => import('./music-entry').then(module => ({ default: module.MusicEntryPage })));
const MusicSharePage = lazyPage(() => import('./music-share').then(module => ({ default: module.MusicSharePage })));
const MusicTrendPage = lazyPage(() => import('./music-trend').then(module => ({ default: module.MusicTrendPage })));
const MusicShoutsPage = lazyPage(() => import('./music-shouts').then(module => ({ default: module.MusicShoutsPage })));
const MusicShoutPage = lazyPage(() => import('./music-shouts').then(module => ({ default: module.MusicShoutPage })));
const AdminShoutsPage = lazyPage(() => import('./admin-shouts').then(module => ({ default: module.AdminShoutsPage })));
const AdminMusicCatalogPage = lazyPage(() => import('./admin-music-catalog').then(module => ({ default: module.AdminMusicCatalogPage })));
const MusicCirclesPage = lazyPage(() => import('./music-circles').then(module => ({ default: module.MusicCirclesPage })));
const MyMusic = lazyPage(() => import('./account').then(module => ({ default: module.MyMusic })));
const MyPage = lazyPage(() => import('./account').then(module => ({ default: module.MyPage })));
const Accounts = lazyPage(() => import('./auth').then(module => ({ default: module.Accounts })));
const AuthConfirm = lazyPage(() => import('./auth').then(module => ({ default: module.AuthConfirm })));
const Login = lazyPage(() => import('./auth').then(module => ({ default: module.Login })));
const Devices = lazyPage(() => import('./devices').then(module => ({ default: module.Devices })));
const AcceptDevice = lazyPage(() => import('./devices').then(module => ({ default: module.AcceptDevice })));
const Privacy = lazyPage(() => import('./privacy').then(module => ({ default: module.Privacy })));
const Registration = lazyPage(() => import('./registration').then(module => ({ default: module.Registration })));
const RegistrationAdmin = lazyPage(() => import('./registration').then(module => ({ default: module.RegistrationAdmin })));
const AccountProfilePage = lazyPage(() => import('./account-profile').then(module => ({ default: module.AccountProfilePage })));
const PaymentCodesPage = lazyPage(() => import('./payment-codes').then(module => ({ default: module.PaymentCodesPage })));
const SettlementImagesPage = lazyPage(() => import('./settlement-images').then(module => ({ default: module.SettlementImagesPage })));
const AdminHome = lazyPage(() => import('./admin').then(module => ({ default: module.AdminHome })));
const AdminPrivacy = lazyPage(() => import('./admin-privacy').then(module => ({ default: module.AdminPrivacy })));
const AdminPrivacyReview = lazyPage(() => import('./admin-privacy').then(module => ({ default: module.AdminPrivacyReview })));
const AdminDirectory = lazyPage(() => import('./admin-users').then(module => ({ default: module.AdminDirectory })));
const AdminUserPage = lazyPage(() => import('./admin-users').then(module => ({ default: module.AdminUserPage })));
const MyPrivacy = lazyPage(() => import('./my-privacy').then(module => ({ default: module.MyPrivacy })));
const PrivacyConsentPage = lazyPage(() => import('./privacy-consent').then(module => ({ default: module.PrivacyConsentPage })));
const MusicContactPage = lazyPage(() => import('./music-contact').then(module => ({ default: module.MusicContactPage })));
const MusicComparisonPage = lazyPage(() => import('./music-matches').then(module => ({ default: module.MusicComparisonPage })));
const People = lazyPage(() => import('./people').then(module => ({ default: module.People })));
const SearchPage = lazyPage(() => import('./search').then(module => ({ default: module.SearchPage })));
const PersonMusic = lazyPage(() => import('./people').then(module => ({ default: module.PersonMusic })));
const MusicRecovery = lazyPage(() => import('./music-recovery').then(module => ({ default: module.MusicRecovery })));
const MusicFieldsPage = lazyPage(() => import('./music-fields').then(module => ({ default: module.MusicFieldsPage })));
const AdminMusicDirectory = lazyPage(() => import('./admin-music').then(module => ({ default: module.AdminMusicDirectory })));
const AdminMusicPage = lazyPage(() => import('./admin-music').then(module => ({ default: module.AdminMusicPage })));
const GuidePage = lazyPage(() => import('./guide').then(module => ({ default: module.GuidePage })));
function Missing() { return <EmptyState title="這個入口不存在" action={<Link to="/activities">回到活動</Link>} />; }
const router = createBrowserRouter([{ element: <LegacyEntryLayout />, errorElement: <main className="main"><EmptyState title="暫時無法顯示頁面" description="請重新整理；已保存的分頁草稿會保留。" action={<a href="/activities">回到活動</a>} /></main>, children: [
  { path: 'time-polls', element: <TimePollsPage /> }, { path: 'time-polls/new', element: <LegacyLocalGuard><NewTimePollPage /></LegacyLocalGuard> }, { path: 'time-polls/:id', element: <TimePollPage /> }, { path: 'time-polls/:id/manage', element: <TimePollPage manage /> },
  { path: 'admin/bot', element: <AdminBotPage /> },
  { path: 'admin/bot/deliveries', element: <AdminBotDeliveriesPage /> },

  { path: 'time-polls/:id/bot-deliveries', element: <BotDeliveriesPage entity="poll" /> },
  { path: 'admin/appearance', element: <AdminAppearancePage /> },
  { path: 'admin/backups', element: <AdminBackupsPage /> },
  { path: 'me/app', element: <AppSettingsPage /> },
  { path: 'me/appearance', element: <AppearancePage /> },
  { path: 'inbox', element: <InboxPage /> },
  { path: 'me/local-history', element: <LegacyLocalPage /> },
  { index: true, element: <Activities /> }, { path: 'activities', element: <Activities /> }, { path: 'activities/:id', element: <ActivityWorkspace />, children: [
    { index: true },
    { path: 'share', element: <ActivitySharePage/> },
    { path: 'arrangements', element: <LegacyLocalGuard><ActivityArrangementPage /></LegacyLocalGuard> },
    { path: 'conditions', element: <ActivityConditionsPage /> },
    { path: 'settlement', element: <ActivitySettlementPage /> },
    { path: 'settlement/edit', element: <LegacyLocalGuard><ActivitySettlementEditor /></LegacyLocalGuard> },
    { path: 'rooms', element: <LegacyLocalGuard><ActivityRoomsPage /></LegacyLocalGuard> },
    { path: 'rooms/history', element: <RoomPlanHistoryPage /> },
    { path: 'finance', element: <LegacyLocalGuard><ActivityFinancePage /></LegacyLocalGuard> },
    { path: 'settlement/images', element: <SettlementImagesPage /> },
    { path: 'history', element: <ActivityHistoryPage /> },
    { path: 'attendance', element: <ActivityAttendancePage /> },
    { path: 'delegation', element: <ActivityDelegationPage /> },
    { path: 'claims', element: <ActivityClaimsPage /> },
    { path: 'invitations', element: <ActivityInvitationsPage /> },
    { path: 'lifecycle', element: <ActivityLifecyclePage /> },
    { path: 'signup', element: <ActivityRegistrationPage /> },
    { path: 'registration', element: <ActivityRegistrationPage manage /> },
    { path: 'bot-deliveries', element: <BotDeliveriesPage entity="activity" /> },
  ] },
  { path: 'contact', element: <ContactPage/> }, { path: 'guide', element: <GuidePage/> }, { path: 'me/activities', element: <Activities mine/> },
  { path: 'activities/:id/access/:token', element: <ActivityAccessPage/> },
  { path: 'activities/new', element: <LegacyLocalGuard><ActivityDraftPage /></LegacyLocalGuard> }, { path: 'activities/:id/edit', element: <LegacyLocalGuard><ActivityDraftPage /></LegacyLocalGuard> }, { path: 'me/activities/drafts', element: <ActivityDraftsPage /> },
  { path: 'activities/participation', element: <ParticipationPage /> }, { path: 'me/participation', element: <ParticipationPage mine /> },

  { path: 'activities/:id/delegation/:token', element: <AcceptActivityDelegationPage /> },
  { path: 'activities/:id/claims/:token', element: <RequestAttendeeClaimPage /> },
  { path: 'activities/:id/invitations/:token', element: <AcceptActivityInvitationPage /> },

  { element: <MusicWorkspace />, children: [
    { path: 'search', element: <SearchPage /> }, { path: 'music', element: <Music /> }, { path: 'music/trends', element: <MusicTrendPage /> }, { path: 'music/entries/:id', element: <MusicEntryPage /> }, { path: 'me/music', element: <MyMusic /> }, { path: 'me/music/share', element: <MusicSharePage /> },
    { path: 'people', element: <People /> }, { path: 'people/:id', element: <PersonMusic /> }, { path: 'people/:id/compare', element: <MusicComparisonPage /> },
  ] }, { path: 'me', element: <MyPage /> },
  { path: 'me/music/entries', element: <MyMusicEntriesPage /> }, { path: 'me/music/entries/new', element: <MusicEntryEditorPage command="create" /> },
  { path: 'me/music/entries/:id/edit', element: <MusicEntryEditorPage command="update" /> }, { path: 'me/music/entries/:id/delete', element: <MusicEntryEditorPage command="delete" /> }, { path: '*', element: <Missing /> },
  { path: 'me/music/contact', element: <MusicContactPage /> },
  { path: 'people/shouts', element: <MusicShoutsPage /> }, { path: 'people/shouts/history', element: <MusicShoutsPage history /> }, { path: 'people/shouts/:id', element: <MusicShoutPage /> }, { path: 'people/circles', element: <MusicCirclesPage /> },
  { path: 'admin/shouts', element: <AdminShoutsPage /> }, { path: 'admin/music-entries', element: <AdminMusicCatalogPage /> },
  { path: 'tools/room-lab', element: <MusicRoomsPage /> },
  { path: 'me/music/recover', element: <MusicRecovery /> },
  { path: 'me/music/details', element: <MusicFieldsPage /> },
  { path: 'admin/music', element: <AdminMusicDirectory /> }, { path: 'admin/music/:id/erase', element: <AdminMusicErasurePage /> }, { path: 'admin/music-reset', element: <AdminMusicErasurePage reset /> }, { path: 'admin/music/:id', element: <AdminMusicPage /> },
  { path: 'login', element: <Login /> }, { path: 'auth/confirm', element: <AuthConfirm /> }, { path: 'me/accounts', element: <Accounts /> }, { path: 'privacy', element: <Privacy /> }, { path: 'me/devices', element: <Devices /> }, { path: 'me/devices/accept', element: <AcceptDevice /> },
  { path: 'register', element: <Registration /> }, { path: 'admin/registration', element: <RegistrationAdmin /> },
  { path: 'me/profile', element: <AccountProfilePage /> },
  { path: 'me/payment-codes', element: <PaymentCodesPage /> },
  { path: 'me/privacy', element: <MyPrivacy /> },
  { path: 'me/privacy/consent', element: <PrivacyConsentPage /> },
  { path: 'admin', element: <AdminHome /> }, { path: 'admin/privacy', element: <AdminPrivacy /> }, { path: 'admin/privacy/:id', element: <AdminPrivacyReview /> }, { path: 'admin/users', element: <AdminDirectory /> }, { path: 'admin/users/:id', element: <AdminUserPage /> },
] }]);
bootstrapAppearance();
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><AppearanceProvider><PWAProvider><RouterProvider router={router} /></PWAProvider></AppearanceProvider></QueryClientProvider></React.StrictMode>);
