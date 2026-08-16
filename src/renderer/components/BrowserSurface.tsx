import { useEffect, useRef } from 'react';

interface Props {
  active: boolean;
}

/**
 * This div claims layout space for the live tab content, but never renders
 * anything itself -- the actual page is a WebContentsView owned by the
 * main process, painted by the OS compositor directly over this
 * rectangle. We just keep main informed of where that rectangle is via
 * tabs.setBounds(), in window-relative pixels (BrowserWindow.contentView's
 * coordinate space), which is exactly what getBoundingClientRect() gives
 * us here since this element isn't transformed/scaled.
 */
export default function BrowserSurface({ active }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const report = () => {
      if (!active) {
        void window.archiveBrowser.tabs.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      const rect = el.getBoundingClientRect();
      void window.archiveBrowser.tabs.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [active]);

  return <div ref={ref} className="browser-surface" />;
}
