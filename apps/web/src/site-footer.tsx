import type { ReactNode } from 'react';
import { useHref, useLinkClickHandler } from 'react-router-dom';
import { Link } from 'yahha-ui';

function FooterPageLink({ to, children }: { to: string; children: ReactNode }) {
  const href = useHref(to);
  const onClick = useLinkClickHandler<HTMLAnchorElement>(to);
  return <Link href={href} onClick={onClick}>{children}</Link>;
}

export function SiteFooter() {
  return <footer className="kimi site-footer" role="contentinfo">
    <nav aria-label="網站資訊"><FooterPageLink to="/guide">使用說明</FooterPageLink><FooterPageLink to="/privacy">隱私政策</FooterPageLink><FooterPageLink to="/contact">聯絡營運者</FooterPageLink></nav>
    <div className="site-footer-credits">
      <p className="site-footer-ideas"><span>活動看板構思：<span translate="no">飯糰</span></span><span className="site-footer-idea-separator" aria-hidden="true">、</span><span>成分查詢構思：<span translate="no">紅雨</span></span></p>
      <p className="site-footer-operation">由 <Link href="https://danndann.cn" external translate="no">飯糰</Link> 製作&amp;運營於 <Link href="https://qm.qq.com/q/fYn352Qdt6" external translate="no">霧都日音約K</Link> 群</p>
    </div>
    <div className="site-footer-filing"><Link href="https://beian.miit.gov.cn/" external translate="no">渝ICP备16002872号-1</Link></div>
  </footer>;
}
