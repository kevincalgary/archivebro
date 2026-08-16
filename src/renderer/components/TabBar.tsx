import type { TabState } from '../../shared/types';

interface Props {
  tabs: TabState[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onNewTab }: Props) {
  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tab.isPrivate ? 'tab-private' : ''} ${tab.isOffline ? 'tab-offline' : ''}`}
            onClick={() => onSelect(tab.id)}
            title={tab.url}
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
