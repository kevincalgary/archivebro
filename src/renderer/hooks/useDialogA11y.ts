import { useCallback, useEffect, useRef, useState } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null, // skip anything hidden (e.g. a collapsed section)
  );
}

/**
 * Applies the three things every modal dialog in this app needs and none
 * of them had: an initial focus target, a focus trap (Tab/Shift+Tab
 * cycles within the dialog instead of escaping into the page behind it),
 * and focus restored to whatever triggered the dialog once it closes.
 *
 * Returns a callback ref to attach to the dialog's own content element
 * (the thing with role="dialog", not the overlay behind it) -- not a
 * plain ref object, because at least one caller (ArchiveDetail) renders a
 * loading placeholder before the real dialog element exists, and a
 * `useEffect(..., [])` keyed on mount would fire while that ref is still
 * null and never run again once the real element appears.
 */
export function useDialogA11y(onEscape?: () => void): (node: HTMLDivElement | null) => void {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setNode(el), []);

  // Read fresh each keydown without re-running the setup effect whenever
  // a parent re-renders with a new inline callback (every dialog here
  // does, since onEscape is usually an arrow function in the JSX).
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = focusableElements(node);
    (focusable[0] ?? node).focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscapeRef.current) {
          e.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const current = focusableElements(node);
      if (current.length === 0) {
        e.preventDefault();
        return;
      }
      const first = current[0]!;
      const last = current[current.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', handleKeyDown);
    return () => {
      node.removeEventListener('keydown', handleKeyDown);
      // The trigger may have unmounted (e.g. a tab closed itself); only
      // restore focus somewhere that's still actually in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [node]);

  return ref;
}
