import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmptyState, ThemeProvider } from 'yahha-ui';
import { Layout } from './layout';
import { Activities, ActivityDetail } from './activities';
import { ActivityDraftPage, ActivityDraftsPage, ActivityArrangementPage } from './activity-drafts';
import { ActivityConditionsPage } from './activity-conditions';
import { ActivityLifecyclePage } from './activity-lifecycle';
import { ActivityRegistrationPage } from './activity-registration';
import { ActivityInvitationsPage, AcceptActivityInvitationPage } from './activity-invitations';
import { ActivityClaimsPage, RequestAttendeeClaimPage } from './activity-claims';
import { ActivityAttendancePage } from './activity-attendance';
import { ActivityDelegationPage, AcceptActivityDelegationPage } from './activity-delegation';
import { ActivityEntry } from './activity-entry';
import { Music } from './music';
import { MyMusic, MyPage } from './account';
import { Accounts, AuthConfirm, Login } from './auth';
import { Devices, AcceptDevice } from './devices';
import { Privacy } from './privacy';
import { Registration, RegistrationAdmin } from './registration';
import { AccountProfilePage } from './account-profile';
import { AdminHome } from './admin';
import { AdminPrivacy, AdminPrivacyReview } from './admin-privacy';
import { AdminDirectory, AdminUserPage } from './admin-users';
import { MyPrivacy } from './my-privacy';
import { MusicContactPage } from './music-contact';
import { People, PersonMusic } from './people';
import { MusicRecovery } from './music-recovery';
import { MusicFieldsPage } from './music-fields';
import { AdminMusicDirectory, AdminMusicPage } from './admin-music';
import 'yahha-ui/style.css';
import './style.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
function Missing() { return <EmptyState title="這個入口不存在" action={<Link to="/activities">回到活動</Link>} />; }
const router = createBrowserRouter([{ element: <Layout />, errorElement: <ThemeProvider theme="blue"><main className="main"><EmptyState title="暫時無法顯示頁面" description="請重新整理；已保存的分頁草稿會保留。" action={<a href="/activities">回到活動</a>} /></main></ThemeProvider>, children: [
  { index: true, element: <ActivityEntry /> }, { path: 'activities', element: <Activities /> }, { path: 'activities/:id', element: <ActivityDetail /> },
  { path: 'activities/new', element: <ActivityDraftPage /> }, { path: 'activities/:id/edit', element: <ActivityDraftPage /> }, { path: 'me/activities/drafts', element: <ActivityDraftsPage /> },
  { path: 'activities/:id/arrangements', element: <ActivityArrangementPage /> }, { path: 'activities/:id/conditions', element: <ActivityConditionsPage /> },
  { path: 'activities/:id/attendance', element: <ActivityAttendancePage /> },
  { path: 'activities/:id/delegation', element: <ActivityDelegationPage /> }, { path: 'activities/:id/delegation/:token', element: <AcceptActivityDelegationPage /> },
  { path: 'activities/:id/claims', element: <ActivityClaimsPage /> }, { path: 'activities/:id/claims/:token', element: <RequestAttendeeClaimPage /> },
  { path: 'activities/:id/invitations', element: <ActivityInvitationsPage /> }, { path: 'activities/:id/invitations/:token', element: <AcceptActivityInvitationPage /> },
  { path: 'activities/:id/lifecycle', element: <ActivityLifecyclePage /> },
  { path: 'activities/:id/signup', element: <ActivityRegistrationPage /> }, { path: 'activities/:id/registration', element: <ActivityRegistrationPage manage /> },
  { path: 'music', element: <Music /> }, { path: 'people', element: <People /> }, { path: 'me', element: <MyPage /> }, { path: 'me/music', element: <MyMusic /> }, { path: '*', element: <Missing /> },
  { path: 'me/music/contact', element: <MusicContactPage /> }, { path: 'people/:id', element: <PersonMusic /> },
  { path: 'me/music/recover', element: <MusicRecovery /> },
  { path: 'me/music/details', element: <MusicFieldsPage /> },
  { path: 'admin/music', element: <AdminMusicDirectory /> }, { path: 'admin/music/:id', element: <AdminMusicPage /> },
  { path: 'login', element: <Login /> }, { path: 'auth/confirm', element: <AuthConfirm /> }, { path: 'me/accounts', element: <Accounts /> }, { path: 'privacy', element: <Privacy /> }, { path: 'me/devices', element: <Devices /> }, { path: 'me/devices/accept', element: <AcceptDevice /> },
  { path: 'register', element: <Registration /> }, { path: 'admin/registration', element: <RegistrationAdmin /> },
  { path: 'me/profile', element: <AccountProfilePage /> },
  { path: 'me/privacy', element: <MyPrivacy /> },
  { path: 'admin', element: <AdminHome /> }, { path: 'admin/privacy', element: <AdminPrivacy /> }, { path: 'admin/privacy/:id', element: <AdminPrivacyReview /> }, { path: 'admin/users', element: <AdminDirectory /> }, { path: 'admin/users/:id', element: <AdminUserPage /> },
] }]);
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
