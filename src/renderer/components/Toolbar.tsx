import { useEffect, useState, type RefObject } from 'react';
import type { TabState } from '../../shared/types';
import type { SiteArchiveSearchResult } from '../../shared/sitearchiveTypes';
import type { Screen } from '../state/store';
import CaptureIndicator from './CaptureIndicator';
import { Spinner } from './Progress';

interface Props {
  tab: TabState | null;
  screen: Screen;
  addressBarRef: RefObject<HTMLInputElement | null>;
  onNavigate: (input: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onNewPrivateTab: () => void;
  onToggleArchivePaused: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onCapturePage: () => void;
  captureBusy: boolean;
}

export default function Toolbar({
  tab,
  screen,
  addressBarRef,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onNewPrivateTab,
  onToggleArchivePaused,
  onOpenLibrary,
  onOpenSettings,
  onCapturePage,
  captureBusy,
}: Props) {
  const [inputValue, setInputValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (isFocused) return;
    // Offline tabs load their MHTML snapshot via a local file:// path (see
    // tabManager.ts openOfflineTab) -- show that as a friendly label
    // instead of a raw filesystem path in the address bar.
    if (tab?.isSiteArchive) {
      setInputValue(tab.siteArchiveTitle ? `${tab.siteArchiveTitle} (offline archive)` : 'Offline archive');
    } else if (tab?.isOffline) {
      setInputValue('Offline archive — no network access');
    } else {
      setInputValue(tab?.url ?? '');
    }
  }, [tab?.url, tab?.isOffline, tab?.isSiteArchive, tab?.siteArchiveTitle, isFocused]);

  // --- Search inside a .sitearchive (uses the FTS index shipped in index.sqlite) ---
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SiteArchiveSearchResult[]>([]);
  const tabId = tab?.id;

  // Switching to a different tab (or away from a site-archive tab
  // entirely) closes the panel rather than leaving a stale search open
  // against whatever tab happens to be active next.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
  }, [tabId]);

  useEffect(() => {
    if (!searchOpen || !tabId || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.archiveBrowser.siteArchive.search(tabId, searchQuery).then((results) => {
        if (!cancelled) setSearchResults(results);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchOpen, tabId, searchQuery]);

  async function goToSearchResult(pageId: string) {
    if (!tabId) return;
    await window.archiveBrowser.siteArchive.navigateToPage(tabId, pageId);
    setSearchOpen(false);
    setSearchQuery('');
  }

  return (
    <div className="toolbar">
      <button disabled={!tab?.canGoBack} onClick={onBack} aria-label="Back" title="Back (Cmd/Ctrl+[)">
        ←
      </button>
      <button disabled={!tab?.canGoForward} onClick={onForward} aria-label="Forward" title="Forward (Cmd/Ctrl+])">
        →
      </button>
      <button onClick={tab?.isLoading ? onStop : onReload} aria-label={tab?.isLoading ? 'Stop' : 'Reload'} title="Reload (Cmd/Ctrl+R)">
        {tab?.isLoading ? '✕' : '⟳'}
      </button>

      <form
        className="address-bar-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (inputValue.trim()) onNavigate(inputValue.trim());
          (e.target as HTMLFormElement).querySelector('input')?.blur();
        }}
      >
        {tab?.isPrivate && <span className="address-bar-badge">Private</span>}
        {/* Always-visible offline indicator while viewing an archive. */}
        {tab?.isSiteArchive && (
          <span className="address-bar-badge address-bar-badge-offline" title="Network access is blocked for this tab">
            🔒 Offline Archive
          </span>
        )}
        <input
          ref={addressBarRef}
          className="address-bar-input"
          value={inputValue}
          placeholder="Search or enter address"
          disabled={screen !== 'browser' || tab?.isOffline}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onChange={(e) => setInputValue(e.target.value)}
        />
      </form>

      {tab?.isSiteArchive && (
        <div className="sitearchive-search">
          <button
            className={searchOpen ? 'toggle-active' : ''}
            onClick={() => setSearchOpen((open) => !open)}
            aria-label="Search inside this archive"
            title="Search inside this archive"
          >
            🔍
          </button>
          {searchOpen && (
            <div className="sitearchive-search-panel">
              <input
                autoFocus
                className="sitearchive-search-input"
                value={searchQuery}
                placeholder="Search this archive…"
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchOpen(false);
                }}
              />
              {searchResults.length > 0 && (
                <ul className="sitearchive-search-results">
                  {searchResults.map((r) => (
                    <li key={r.pageId}>
                      <button className="sitearchive-search-result" onClick={() => void goToSearchResult(r.pageId)}>
                        <span className="sitearchive-search-result-title">{r.title || r.normalizedUrl}</span>
                        {r.snippet && <span className="sitearchive-search-result-snippet">{r.snippet}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searchQuery.trim().length > 0 && searchResults.length === 0 && (
                <p className="sitearchive-search-empty">No matches in this archive.</p>
              )}
            </div>
          )}
        </div>
      )}

      <button
        className={`capture-page-button ${captureBusy ? 'capture-page-button-busy' : ''}`}
        onClick={onCapturePage}
        disabled={!tab || tab.isOffline || captureBusy || !/^https?:/i.test(tab?.url ?? '')}
        title="Save this page or the whole website as a portable offline archive"
      >
        {captureBusy ? <Spinner size={11} label="Capturing…" /> : 'Capture the Page'}
      </button>

      {tab && !tab.isOffline && <CaptureIndicator status={tab.lastCaptureStatus} paused={tab.isArchivingPaused} />}

      {tab && !tab.isOffline && (
        <button
          className={tab.isArchivingPaused ? 'toggle-active' : ''}
          onClick={onToggleArchivePaused}
          title={tab.isArchivingPaused ? 'Resume automatic archiving for this tab' : 'Pause automatic archiving for this tab'}
        >
          {tab.isArchivingPaused ? '⏸ Paused' : '● Archiving'}
        </button>
      )}

      <button onClick={onNewPrivateTab} title="New private tab (Cmd/Ctrl+Shift+N)">
        🕶 Private
      </button>
      <button onClick={onOpenLibrary} title="Library (Cmd/Ctrl+Shift+L)">
        📚 Library
      </button>
      <button onClick={onOpenSettings} title="Settings (Cmd/Ctrl+,)">
        ⚙
      </button>
    </div>
  );
}
