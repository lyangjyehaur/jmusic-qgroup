import { Button } from './kimi-ui';
import { useEffect, useState } from 'react';

export function PageTools() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const mobile = window.matchMedia('(max-width: 768px)');
    const main = document.getElementById('main');
    let actions: Element | null = null;
    const setLength = (name: string, value: number) => {
      const length = `${value}px`;
      if (root.style.getPropertyValue(name) !== length) root.style.setProperty(name, length);
    };
    const update = () => {
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement && focused.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]');
      const reduction = viewport?.scale === 1 ? Math.max(0, innerHeight - viewport.height - Math.max(0, viewport.offsetTop)) : 0;
      // Browser chrome and elastic overscroll also change the visual viewport.
      // Only a substantial reduction while editing should lift save actions.
      const inset = editing && reduction > 150 ? reduction : 0;
      setLength('--visual-viewport-inset', inset);
      const next = main?.querySelector('.music-save-dock:not([hidden])') ?? main?.querySelector('.mobile-selection-save') ?? main?.querySelector('.editor-actions') ?? null;
      if (next !== actions) {
        if (actions) sizes.unobserve(actions);
        actions = next;
        if (actions) sizes.observe(actions);
      }
      const height = mobile.matches && actions && getComputedStyle(actions).position === 'fixed' ? actions.getBoundingClientRect().height : 0;
      setLength('--mobile-actions-height', height);
      setLength('--music-save-dock-height', actions?.classList.contains('music-save-dock') && getComputedStyle(actions).position === 'fixed' ? actions.getBoundingClientRect().height : 0);
      setVisible(scrollY > Math.min(320, innerHeight / 2) && inset === 0);
    };
    const sizes = new ResizeObserver(update);
    const changes = new MutationObserver(update);
    if (main) { sizes.observe(main); changes.observe(main, { childList: true, subtree: true }); }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    mobile.addEventListener('change', update);
    update();
    return () => {
      sizes.disconnect(); changes.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      mobile.removeEventListener('change', update);
      root.style.removeProperty('--visual-viewport-inset');
      root.style.removeProperty('--mobile-actions-height');
      root.style.removeProperty('--music-save-dock-height');
    };
  }, []);
  if (!visible) return null;
  return <Button variant="ghost" className="back-to-top" aria-label="回到頂部" onClick={() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}><span aria-hidden="true">↑</span></Button>;
}
