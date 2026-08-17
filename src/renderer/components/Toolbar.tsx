import { useEffect, useState, type RefObject } from 'react';
import type { TabState } from '../../shared/types';
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
