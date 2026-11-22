import { useEffect, useState } from 'react';

export function PageTools() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const mobile = window.matchMedia('(max-width: 700px)');
    const main = document.getElementById('main');
    let actions: Element | null = null;
    const setLength = (name: string, value: number) => {
      const length = `${value}px`;
      if (root.style.getPropertyValue(name) !== length) root.style.setProperty(name, length);
    };
    const update = () => {
      const inset = viewport?.scale === 1 ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
      setLength('--visual-viewport-inset', inset);
      const next = main?.querySelector('.editor-actions') ?? null;
      if (next !== actions) {
        if (actions) sizes.unobserve(actions);
        actions = next;
        if (actions) sizes.observe(actions);
      }
      const height = mobile.matches && actions && getComputedStyle(actions).position === 'fixed' ? actions.getBoundingClientRect().height : 0;
      setLength('--mobile-actions-height', height);
      setVisible(scrollY > Math.min(320, innerHeight / 2) && inset === 0);
    };
    const sizes = new ResizeObserver(update);
    const changes = new MutationObserver(update);
    if (main) { sizes.observe(main); changes.observe(main, { childList: true, subtree: true }); }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    mobile.addEventListener('change', update);
    update();
    return () => {
      sizes.disconnect(); changes.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      mobile.removeEventListener('change', update);
      root.style.removeProperty('--visual-viewport-inset');
      root.style.removeProperty('--mobile-actions-height');
    };
  }, []);
  if (!visible) return null;
  return <button className="back-to-top" aria-label="回到頂部" onClick={() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}><span aria-hidden="true">↑</span></button>;
}
