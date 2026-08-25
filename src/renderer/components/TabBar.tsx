import type { KeyboardEvent } from 'react';
import type { TabState } from '../../shared/types';

interface Props {
  tabs: TabState[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onNewTab }: Props) {
  // Not using role="tablist"/"tab": that ARIA pattern requires a tablist's
  // (effective) children to be only tabs, which a per-tab close button
  // can never satisfy no matter where it sits in the DOM (axe's
  // aria-required-children flags it even as a non-nested sibling). Each
  // tab is a role="button" instead, with aria-current marking the active
  // one -- still a roving tabindex (Tab enters/exits at the active tab)
  // with Left/Right moving between tabs and switching to them, matching
  // how a real browser's own tab strip behaves.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next) {
        onSelect(next.id);
        document.getElementById(`tab-${next.id}`)?.focus();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const tab = tabs[index];
      if (tab) onSelect(tab.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const tab = tabs[index];
      if (tab) onClose(tab.id);
    }
  };

  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll" aria-label="Open tabs">
        {tabs.map((tab, index) => (
          // Plain outer div (no role): keeps the click-to-select area
          // covering the whole tab, including its padding, same as
          // before restructuring this for the close button below.
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tab.isPrivate ? 'tab-private' : ''} ${tab.isOffline ? 'tab-offline' : ''}`}
            onClick={() => onSelect(tab.id)}
            title={tab.url}
          >
            <div
              id={`tab-${tab.id}`}
              role="button"
              aria-current={tab.id === activeTabId ? 'true' : undefined}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              className="tab-hit-area"
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              {tab.favicon ? (
                <img className="tab-favicon" src={tab.favicon} alt="" />
              ) : (
                <span className="tab-favicon tab-favicon-placeholder" />
              )}
              <span className="tab-title">
                {tab.isPrivate && '🕶 '}
                {tab.isOffline && '📦 '}
                {tab.title || tab.url || 'New Tab'}
              </span>
              {tab.isLoading && <span className="tab-spinner" aria-label="Loading" />}
            </div>
            {/*
              A plain sibling button, not nested inside the role="tab"
              element above -- so it keeps its normal (default) place in
              the tab order rather than needing tabindex tricks. Delete/
              Backspace on the focused tab (see handleKeyDown above) is
              a second, faster way to close it without leaving the tab
              itself.
            */}
            <button
              className="tab-close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} aria-label="New tab">
        +
      </button>
    </div>
  );
}
