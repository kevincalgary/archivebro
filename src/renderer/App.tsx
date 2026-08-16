import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from './state/store';
import TabBar from './components/TabBar';
import Toolbar from './components/Toolbar';
import BrowserSurface from './components/BrowserSurface';
import LibraryScreen from './components/Library/LibraryScreen';
import SettingsScreen from './components/Settings/SettingsScreen';
import CaptureScopeDialog from './components/Capture/CaptureScopeDialog';
import CaptureProgressDialog from './components/Capture/CaptureProgressDialog';
import type { CaptureProgress, CaptureScope } from '../shared/sitearchiveTypes';

export default function App() {
  const { tabs, activeTabId, screen, setTabs, upsertTab, removeTab, setActiveTabId, setScreen, setSettings } =
    useAppStore();
  const addressBarRef = useRef<HTMLInputElement | null>(null);

  // --- Portable .sitearchive capture state ---
  const [scopeDialog, setScopeDialog] = useState<{ url: string; title: string; host: string } | null>(null);
  const [captureProgress, setCaptureProgress] = useState<CaptureProgress | null>(null);
  const [captureJobId, setCaptureJobId] = useState<string | null>(null);

  const openArchivePath = useCallback(async (archivePath: string) => {
    try {
      await window.archiveBrowser.siteArchive.openPath(archivePath);
      setCaptureProgress(null);
      setScreen('browser');
    } catch {
      // The main process already showed a specific error dialog.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void window.archiveBrowser.tabs.list().then(setTabs);
    void window.archiveBrowser.settings.get().then(setSettings);

    const offTabState = window.archiveBrowser.events.onTabState((state) => {
      upsertTab(state);
    });
    const offTabClosed = window.archiveBrowser.events.onTabClosed((tabId) => {
      removeTab(tabId);
    });
    // Main activates tabs on its own (opening an archive, popups, "Open
    // Live Version"), so follow it rather than assuming the UI is the only
    // thing that ever changes the active tab.
    const offTabActivated = window.archiveBrowser.events.onTabActivated((tabId) => {
      setActiveTabId(tabId);
      setScreen('browser');
    });
    const offMenu = window.archiveBrowser.events.onMenuAction(async (action) => {
      if (action === 'new-tab') {
        const id = await window.archiveBrowser.tabs.create();
        await window.archiveBrowser.tabs.activate(id);
        setActiveTabId(id);
        setScreen('browser');
      } else if (action === 'new-private-tab') {
        const id = await window.archiveBrowser.tabs.createPrivate();
        await window.archiveBrowser.tabs.activate(id);
        setActiveTabId(id);
        setScreen('browser');
      } else if (action.startsWith('close-tab:')) {
        const id = action.slice('close-tab:'.length);
        await window.archiveBrowser.tabs.close(id);
      } else if (action === 'focus-address-bar') {
        setScreen('browser');
        addressBarRef.current?.focus();
        addressBarRef.current?.select();
      } else if (action === 'open-library') {
        setScreen('library');
      } else if (action === 'open-settings') {
        setScreen('settings');
      } else if (action === 'capture-page') {
        const id = useAppStore.getState().activeTabId;
        if (!id) return;
        const info = await window.archiveBrowser.siteCapture.estimate(id);
        if (info.canCapture) setScopeDialog({ url: info.url, title: info.title, host: info.host });
      } else if (action === 'open-sitearchive') {
        await window.archiveBrowser.siteArchive.open().catch(() => null);
        setScreen('browser');
      }
    });

    const offCaptureProgress = window.archiveBrowser.events.onSiteCaptureProgress((progress) => {
      setCaptureProgress(progress);
    });

    // Requests that originate inside an archived page (which has no IPC
    // access): opening the live version, an external link, or a
    // double-clicked .sitearchive file.
    const offArchiveRequest = window.archiveBrowser.events.onSiteArchiveOpenRequest(async (payload) => {
      if (payload.kind === 'open-live' && payload.url) {
        await window.archiveBrowser.siteArchive.openLive(payload.url);
      } else if (payload.kind === 'external' && payload.url) {
        await window.archiveBrowser.siteArchive.confirmExternal(payload.url);
      } else if (payload.kind === 'open-archive' && payload.path) {
        await openArchivePath(payload.path);
      }
    });

    return () => {
      offTabState();
      offTabClosed();
      offTabActivated();
      offMenu();
      offCaptureProgress();
      offArchiveRequest();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tabs.length > 0 && !activeTabId) {
      const first = tabs[0];
      if (first) setActiveTabId(first.id);
    }
  }, [tabs, activeTabId, setActiveTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="app-shell">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={async (id) => {
          await window.archiveBrowser.tabs.activate(id);
          setActiveTabId(id);
          setScreen('browser');
        }}
        onClose={async (id) => {
          await window.archiveBrowser.tabs.close(id);
        }}
        onNewTab={async () => {
          const id = await window.archiveBrowser.tabs.create();
          await window.archiveBrowser.tabs.activate(id);
          setActiveTabId(id);
          setScreen('browser');
        }}
      />
      <Toolbar
        tab={activeTab}
        screen={screen}
        addressBarRef={addressBarRef}
        onNavigate={async (input) => {
          if (activeTabId) await window.archiveBrowser.tabs.navigate(activeTabId, input);
        }}
        onBack={async () => activeTabId && window.archiveBrowser.tabs.goBack(activeTabId)}
        onForward={async () => activeTabId && window.archiveBrowser.tabs.goForward(activeTabId)}
        onReload={async () => activeTabId && window.archiveBrowser.tabs.reload(activeTabId)}
        onStop={async () => activeTabId && window.archiveBrowser.tabs.stop(activeTabId)}
        onNewPrivateTab={async () => {
          const id = await window.archiveBrowser.tabs.createPrivate();
          await window.archiveBrowser.tabs.activate(id);
          setActiveTabId(id);
          setScreen('browser');
        }}
        onToggleArchivePaused={async () => {
          if (activeTabId && activeTab) {
            await window.archiveBrowser.tabs.setArchivingPaused(activeTabId, !activeTab.isArchivingPaused);
          }
        }}
        onOpenLibrary={() => setScreen('library')}
        onOpenSettings={() => setScreen('settings')}
        captureBusy={
          captureProgress !== null &&
          !['completed', 'failed', 'cancelled'].includes(captureProgress.state)
        }
        onCapturePage={async () => {
          if (!activeTabId) return;
          const info = await window.archiveBrowser.siteCapture.estimate(activeTabId);
          if (!info.canCapture) return;
          setScopeDialog({ url: info.url, title: info.title, host: info.host });
        }}
      />
      <div className="app-content">
        {/* BrowserSurface is always mounted so its ResizeObserver keeps
            reporting bounds, but it only claims screen space (and the
            WebContentsView only becomes visible) while screen === 'browser'. */}
        <BrowserSurface active={screen === 'browser'} />
        {screen === 'library' && <LibraryScreen onOpenLive={() => setScreen('browser')} />}
        {screen === 'settings' && <SettingsScreen />}
      </div>

      {scopeDialog && (
        <CaptureScopeDialog
          pageUrl={scopeDialog.url}
          pageTitle={scopeDialog.title}
          host={scopeDialog.host}
          onCancel={() => setScopeDialog(null)}
          onStart={async (scope: CaptureScope) => {
            setScopeDialog(null);
            if (!activeTabId) return;
            const started = await window.archiveBrowser.siteCapture.start(activeTabId, scope);
            if (started.started && started.jobId) setCaptureJobId(started.jobId);
          }}
        />
      )}

      {captureProgress && (
        <CaptureProgressDialog
          progress={captureProgress}
          onPause={() => captureJobId && window.archiveBrowser.siteCapture.pause(captureJobId)}
          onResume={() => captureJobId && window.archiveBrowser.siteCapture.resume(captureJobId)}
          onCancel={() => captureJobId && window.archiveBrowser.siteCapture.cancel(captureJobId)}
          onClose={() => setCaptureProgress(null)}
          onOpenArchive={(p) => void openArchivePath(p)}
          onRevealArchive={(p) => void window.archiveBrowser.siteArchive.revealInFolder(p)}
          onRetryFailed={async () => {
            // Retrying re-runs a capture from the same starting point;
            // pages that succeeded are re-fetched too, which keeps the
            // resulting archive internally consistent rather than
            // stitching two partial crawls together.
            setCaptureProgress(null);
            if (!activeTabId) return;
            const info = await window.archiveBrowser.siteCapture.estimate(activeTabId);
            setScopeDialog({ url: info.url, title: info.title, host: info.host });
          }}
        />
      )}
    </div>
  );
}
