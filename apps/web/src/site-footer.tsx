import { Link } from 'react-router-dom';

export function SiteFooter() {
  return <footer className="kimi site-footer" role="contentinfo">
    <nav aria-label="網站資訊"><Link to="/guide">使用說明</Link><Link to="/privacy">隱私政策</Link><Link to="/contact">聯絡營運者</Link></nav>
    <div className="site-footer-credits"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" translate="no">渝ICP备16002872号-1</a>
      <span>成分站構想：<span translate="no">紅雨老師</span></span>
      <span>由 <a href="https://danndann.cn" target="_blank" rel="noopener noreferrer" translate="no">飯糰</a> 製作</span></div>
  </footer>;
}
