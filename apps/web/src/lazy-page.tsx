import {createElement,lazy,Suspense,type ComponentType,type ComponentProps} from 'react';
import {uiText} from './language';

/** A page loads inside its existing layout, guard and workspace. Provider
 * state and navigation stay mounted while the page bundle is downloading. */
// ComponentType's parameter is only a generic constraint; the returned page
// keeps each imported component's exact required and optional props.
export function lazyPage<PageType extends ComponentType<any>>(load:()=>Promise<{default:PageType}>){
  const Page=lazy(load);
  return function LoadingPage(props:ComponentProps<PageType>){
    return <Suspense fallback={<p role="status">{uiText('正在載入頁面…')}</p>}>{createElement(Page,props)}</Suspense>;
  };
}
