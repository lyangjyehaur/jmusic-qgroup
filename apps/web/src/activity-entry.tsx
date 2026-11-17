import { Navigate, useLocation } from 'react-router-dom';
import { legacyNavigation } from '@qgroup/domain';
import { Notice } from './shared';
import { Layout } from './layout';
/** Resolve old entry points before mounting any page or fetching its private data. */
export function LegacyEntryLayout(){
  const route=useLocation(),entry=legacyNavigation(route.pathname,route.search,route.hash);
  if(entry?.kind==='redirect')return <Navigate replace to={entry.to}/>;
  if(entry?.kind==='invalid')return <main className="main"><Notice>連結不完整或包含衝突的操作，請重新取得連結。</Notice></main>;
  return <Layout/>;
}
