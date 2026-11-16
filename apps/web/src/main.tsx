import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmptyState, Surface, ThemeProvider } from 'yahha-ui';
import { Layout } from './layout';
import { Activities, ActivityDetail } from './activities';
import { Music } from './music';
import { MyMusic, MyPage } from './account';
import { Accounts, AuthConfirm, Login } from './auth';
import { Devices, AcceptDevice } from './devices';
import { Privacy } from './privacy';
import { Registration, RegistrationAdmin } from './registration';
import { PageIntro } from './shared';
import 'yahha-ui/style.css';
import './style.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
function People() { return <><PageIntro title="同好" /><Surface><EmptyState title="同好推薦尚未開放" action={<Link to="/me/music">我的成分</Link>} /></Surface></>; }
function Missing() { return <EmptyState title="這個入口不存在" action={<Link to="/activities">回到活動</Link>} />; }
const router = createBrowserRouter([{ element: <Layout />, errorElement: <ThemeProvider theme="blue"><main className="main"><EmptyState title="暫時無法顯示頁面" description="請重新整理；已保存的分頁草稿會保留。" action={<a href="/activities">回到活動</a>} /></main></ThemeProvider>, children: [
  { index: true, element: <Activities /> }, { path: 'activities', element: <Activities /> }, { path: 'activities/:id', element: <ActivityDetail /> },
  { path: 'music', element: <Music /> }, { path: 'people', element: <People /> }, { path: 'me', element: <MyPage /> }, { path: 'me/music', element: <MyMusic /> }, { path: '*', element: <Missing /> },
  { path: 'login', element: <Login /> }, { path: 'auth/confirm', element: <AuthConfirm /> }, { path: 'me/accounts', element: <Accounts /> }, { path: 'privacy', element: <Privacy /> }, { path: 'me/devices', element: <Devices /> }, { path: 'me/devices/accept', element: <AcceptDevice /> },
  { path: 'register', element: <Registration /> }, { path: 'admin/registration', element: <RegistrationAdmin /> },
] }]);
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></React.StrictMode>);
