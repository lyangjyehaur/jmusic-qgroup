import { AdminAppearancePage } from './admin-appearance';
import { AdminBackupsPage } from './admin-backups';
import { AppearanceProvider,bootstrapAppearance } from './appearance-preferences';
import { AppearancePage } from './appearance';
import { AdminMusicErasurePage } from './admin-music-erasure';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmptyState } from 'yahha-ui';
import { InboxPage } from './inbox';
import { Layout } from './layout';
import { Activities, ActivityDetail } from './activities';
import { ActivityDraftPage, ActivityDraftsPage, ActivityArrangementPage } from './activity-drafts';
import { ActivityConditionsPage } from './activity-conditions';
import { ActivityLifecyclePage } from './activity-lifecycle';
import { ActivityRegistrationPage } from './activity-registration';
import { ActivityInvitationsPage, AcceptActivityInvitationPage } from './activity-invitations';
import { ActivityClaimsPage, RequestAttendeeClaimPage } from './activity-claims';
import { ActivityFinancePage } from './activity-finance';
import { ActivitySettlementPage, ActivitySettlementEditor } from './activity-settlement';
import { RoomPlanHistoryPage } from './activity-room-overview';
import { MyMusicEntriesPage, MusicEntryEditorPage } from './music-entries';
import { ActivityRoomsPage } from './activity-rooms';
import { ActivityHistoryPage } from './activity-history';
import { ActivityAttendancePage } from './activity-attendance';
import { ActivityDelegationPage, AcceptActivityDelegationPage } from './activity-delegation';
import { TimePollPage, TimePollsPage, NewTimePollPage } from './time-polls';
import { ActivityEntry } from './activity-entry';
import { Music } from './music';
import { MusicEntryPage } from './music-entry';
import { MusicSharePage } from './music-share';
import { MusicTrendPage } from './music-trend';
import { MusicShoutsPage, MusicShoutPage } from './music-shouts';
import { AdminShoutsPage } from './admin-shouts';
import { AdminMusicCatalogPage } from './admin-music-catalog';
import { MusicCirclesPage } from './music-circles';
import { MusicWorkspace } from './music-selection';
import { MyMusic, MyPage } from './account';
import { Accounts, AuthConfirm, Login } from './auth';
import { Devices, AcceptDevice } from './devices';
import { Privacy } from './privacy';
import { Registration, RegistrationAdmin } from './registration';
import { AccountProfilePage } from './account-profile';
import { PaymentCodesPage } from './payment-codes';
import { SettlementImagesPage } from './settlement-images';
import { AdminHome } from './admin';
import { AdminPrivacy, AdminPrivacyReview } from './admin-privacy';
import { AdminDirectory, AdminUserPage } from './admin-users';
import { MyPrivacy } from './my-privacy';
import { MusicContactPage } from './music-contact';
import { MusicComparisonPage } from './music-matches';
import { People, PersonMusic } from './people';
import { MusicRecovery } from './music-recovery';
import { MusicFieldsPage } from './music-fields';
import { AdminMusicDirectory, AdminMusicPage } from './admin-music';
import 'yahha-ui/style.css';
import './style.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
function Missing() { return <EmptyState title="這個入口不存在" action={<Link to="/activities">回到活動</Link>} />; }
const router = createBrowserRouter([{ element: <Layout />, errorElement: <main className="main"><EmptyState title="暫時無法顯示頁面" description="請重新整理；已保存的分頁草稿會保留。" action={<a href="/activities">回到活動</a>} /></main>, children: [
  { path: 'time-polls', element: <TimePollsPage /> }, { path: 'time-polls/new', element: <NewTimePollPage /> }, { path: 'time-polls/:id', element: <TimePollPage /> }, { path: 'time-polls/:id/manage', element: <TimePollPage manage /> },
  { path: 'admin/appearance', element: <AdminAppearancePage /> },
  { path: 'admin/backups', element: <AdminBackupsPage /> },
  { path: 'me/appearance', element: <AppearancePage /> },
  { path: 'inbox', element: <InboxPage /> },
  { index: true, element: <ActivityEntry /> }, { path: 'activities', element: <Activities /> }, { path: 'activities/:id', element: <ActivityDetail /> },
  { path: 'activities/new', element: <ActivityDraftPage /> }, { path: 'activities/:id/edit', element: <ActivityDraftPage /> }, { path: 'me/activities/drafts', element: <ActivityDraftsPage /> },
  { path: 'activities/:id/arrangements', element: <ActivityArrangementPage /> }, { path: 'activities/:id/conditions', element: <ActivityConditionsPage /> },
  { path: 'activities/:id/settlement', element: <ActivitySettlementPage /> },
  { path: 'activities/:id/settlement/edit', element: <ActivitySettlementEditor /> },
  { path: 'activities/:id/rooms', element: <ActivityRoomsPage /> }, { path: 'activities/:id/rooms/history', element: <RoomPlanHistoryPage /> },
  { path: 'activities/:id/finance', element: <ActivityFinancePage /> },
  { path: 'activities/:id/settlement/images', element: <SettlementImagesPage /> },
  { path: 'activities/:id/history', element: <ActivityHistoryPage /> },
  { path: 'activities/:id/attendance', element: <ActivityAttendancePage /> },
  { path: 'activities/:id/delegation', element: <ActivityDelegationPage /> }, { path: 'activities/:id/delegation/:token', element: <AcceptActivityDelegationPage /> },
  { path: 'activities/:id/claims', element: <ActivityClaimsPage /> }, { path: 'activities/:id/claims/:token', element: <RequestAttendeeClaimPage /> },
  { path: 'activities/:id/invitations', element: <ActivityInvitationsPage /> }, { path: 'activities/:id/invitations/:token', element: <AcceptActivityInvitationPage /> },
  { path: 'activities/:id/lifecycle', element: <ActivityLifecyclePage /> },
  { path: 'activities/:id/signup', element: <ActivityRegistrationPage /> }, { path: 'activities/:id/registration', element: <ActivityRegistrationPage manage /> },
  { element: <MusicWorkspace />, children: [{ path: 'music', element: <Music /> }, { path: 'music/trends', element: <MusicTrendPage /> }, { path: 'music/entries/:id', element: <MusicEntryPage /> }, { path: 'me/music', element: <MyMusic /> }, { path: 'me/music/share', element: <MusicSharePage /> }] }, { path: 'people', element: <People /> }, { path: 'me', element: <MyPage /> },
  { path: 'me/music/entries', element: <MyMusicEntriesPage /> }, { path: 'me/music/entries/new', element: <MusicEntryEditorPage command="create" /> },
  { path: 'me/music/entries/:id/edit', element: <MusicEntryEditorPage command="update" /> }, { path: 'me/music/entries/:id/delete', element: <MusicEntryEditorPage command="delete" /> }, { path: '*', element: <Missing /> },
  { path: 'me/music/contact', element: <MusicContactPage /> }, { path: 'people/:id', element: <PersonMusic /> }, { path: 'people/:id/compare', element: <MusicComparisonPage /> },
  { path: 'people/shouts', element: <MusicShoutsPage /> }, { path: 'people/shouts/history', element: <MusicShoutsPage history /> }, { path: 'people/shouts/:id', element: <MusicShoutPage /> }, { path: 'admin/shouts', element: <AdminShoutsPage /> }, { path: 'admin/music-entries', element: <AdminMusicCatalogPage /> },
  { path: 'people/circles', element: <MusicCirclesPage /> },
  { path: 'me/music/recover', element: <MusicRecovery /> },
  { path: 'me/music/details', element: <MusicFieldsPage /> },
  { path: 'admin/music', element: <AdminMusicDirectory /> }, { path: 'admin/music/:id/erase', element: <AdminMusicErasurePage /> }, { path: 'admin/music-reset', element: <AdminMusicErasurePage reset /> }, { path: 'admin/music/:id', element: <AdminMusicPage /> },
  { path: 'login', element: <Login /> }, { path: 'auth/confirm', element: <AuthConfirm /> }, { path: 'me/accounts', element: <Accounts /> }, { path: 'privacy', element: <Privacy /> }, { path: 'me/devices', element: <Devices /> }, { path: 'me/devices/accept', element: <AcceptDevice /> },
  { path: 'register', element: <Registration /> }, { path: 'admin/registration', element: <RegistrationAdmin /> },
  { path: 'me/profile', element: <AccountProfilePage /> },
  { path: 'me/payment-codes', element: <PaymentCodesPage /> },
  { path: 'me/privacy', element: <MyPrivacy /> },
  { path: 'admin', element: <AdminHome /> }, { path: 'admin/privacy', element: <AdminPrivacy /> }, { path: 'admin/privacy/:id', element: <AdminPrivacyReview /> }, { path: 'admin/users', element: <AdminDirectory /> }, { path: 'admin/users/:id', element: <AdminUserPage /> },
] }]);
bootstrapAppearance();
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><AppearanceProvider><RouterProvider router={router} /></AppearanceProvider></QueryClientProvider></React.StrictMode>);
