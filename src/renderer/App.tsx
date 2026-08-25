import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from './state/store';
import TabBar from './components/TabBar';
import Toolbar from './components/Toolbar';
import BrowserSurface from './components/BrowserSurface';
import LibraryScreen from './components/Library/LibraryScreen';
import SettingsScreen from './components/Settings/SettingsScreen';
import CaptureScopeDialog from './components/Capture/CaptureScopeDialog';
import CaptureProgressDialog from './components/Capture/CaptureProgressDialog';
import RecoveryDialog from './components/Capture/RecoveryDialog';
import { BusyOverlay } from './components/Progress';
import PermissionPrompt, { type PermissionRequest } from './components/PermissionPrompt';
import type { CaptureProgress, CaptureScope, RecoverableCaptureSummary } from '../shared/sitearchiveTypes';
import type { UpdateStatus } from '../shared/types';

export default function App() {
  const { tabs, activeTabId, screen, setTabs, upsertTab, removeTab, setActiveTabId, setScreen, setSettings } =
    useAppStore();
  const addressBarRef = useRef<HTMLInputElement | null>(null);

  // --- Portable .sitearchive capture state ---
  const [scopeDialog, setScopeDialog] = useState<{ url: string; title: string; host: string } | null>(null);
  const [captureProgress, setCaptureProgress] = useState<CaptureProgress | null>(null);

  // Opening an archive reads and checksum-verifies entries out of the ZIP
  // before anything can render, which is not instant for a large one --
  // so it gets a visible busy state rather than appearing to do nothing.
  const [openingArchive, setOpeningArchive] = useState<string | null>(null);

  // Queue rather than a single slot: a page can request several
  // permissions at once, and each must get its own explicit answer.
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const permissionRequest = permissionQueue[0] ?? null;

  // --- Recovering an interrupted .sitearchive capture ---
  // Checked once at startup (see the mount effect below), not on a poll or
  // on every focus -- so dismissing it can't just bring it right back, and
  // a resolved capture can't be prompted for twice in the same session.
  const [recoverable, setRecoverable] = useState<RecoverableCaptureSummary[] | null>(null);
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null);
  const [recoveryErrors, setRecoveryErrors] = useState<Record<string, string>>({});

  // --- Auto-update ---
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);

  const openArchivePath = useCallback(async (archivePath: string) => {
    setOpeningArchive(archivePath);
    try {
      await window.archiveBrowser.siteArchive.openPath(archivePath);
      setCaptureProgress(null);
      setScreen('browser');
    } catch {
      // The main process already showed a specific error dialog.
    } finally {
      setOpeningArchive(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void window.archiveBrowser.tabs.list().then(setTabs);
    void window.archiveBrowser.settings.get().then(setSettings);
    void window.archiveBrowser.captureRecovery.list().then((list) => {
      if (list.length > 0) setRecoverable(list);
    });
    void window.archiveBrowser.updates.getStatus().then(setUpdateStatus);

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

    const offPermission = window.archiveBrowser.events.onPermissionRequest((request) => {
      setPermissionQueue((q) => [...q, request]);
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

    const offUpdateStatus = window.archiveBrowser.events.onUpdateStatus((status) => {
      setUpdateStatus(status);
      // A fresh downloaded-update notice deserves to be seen again even if
      // an earlier one (e.g. from a prior version) was dismissed this
      // session.
      if (status.state === 'downloaded') setUpdateBannerDismissed(false);
    });

    return () => {
      offTabState();
      offTabClosed();
      offTabActivated();
      offMenu();
      offCaptureProgress();
      offPermission();
      offArchiveRequest();
      offUpdateStatus();
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

  // Anything that renders an HTML overlay must hide the native tab view,
  // or it will be painted over. Keep this list in sync with the overlays
  // rendered at the bottom of this component.
  const modalOpen = Boolean(scopeDialog || captureProgress || openingArchive || permissionRequest || recoverable);

  const handleResumeRecovery = async (archiveId: string) => {
    setRecoveryBusyId(archiveId);
    try {
      const res = await window.archiveBrowser.captureRecovery.resume(archiveId);
      if (res.ok) {
        // The live progress dialog takes over from here (see the
        // onSiteCaptureProgress listener above); showing both at once
        // would be confusing.
        setRecoverable(null);
      } else {
        setRecoveryErrors((e) => ({
          ...e,
          [archiveId]: 'This capture could not be resumed. It may already be running elsewhere, or its checkpoint is unreadable.',
        }));
      }
    } finally {
      setRecoveryBusyId(null);
    }
  };

  const handleFinishRecovery = async (archiveId: string) => {
    setRecoveryBusyId(archiveId);
    try {
      const res = await window.archiveBrowser.captureRecovery.finish(archiveId);
      if (res.ok) {
        // The completed-capture progress dialog takes over from here.
        setRecoverable(null);
      } else {
        setRecoveryErrors((e) => ({
          ...e,
          [archiveId]: 'This capture could not be finished. Its checkpoint may be corrupt or already gone.',
        }));
      }
    } finally {
      setRecoveryBusyId(null);
    }
  };

  const handleDiscardRecovery = async (archiveId: string) => {
    setRecoveryBusyId(archiveId);
    try {
      const res = await window.archiveBrowser.captureRecovery.discard(archiveId);
      if (res.discarded) {
        setRecoverable((list) => {
          const next = (list ?? []).filter((c) => c.archiveId !== archiveId);
          return next.length > 0 ? next : null;
        });
      }
      // A refused discard (still running elsewhere) leaves the item in
      // place with no error text -- it simply didn't disappear, which is
      // enough signal without a confusing message on what is a rare race.
    } finally {
      setRecoveryBusyId(null);
    }
  };

  return (
    <div className="app-shell">
      {updateStatus?.state === 'downloaded' && !updateBannerDismissed && (
        <div className="update-banner">
          <span>Version {updateStatus.version} is ready — restart to update.</span>
          <button onClick={() => window.archiveBrowser.updates.installNow()}>Restart and update</button>
          <button className="update-banner-dismiss" onClick={() => setUpdateBannerDismissed(true)}>
            Not now
          </button>
        </div>
      )}
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
        {/*
          Tab content is a native WebContentsView composited ON TOP of this
          window's HTML, so any HTML modal would be hidden behind the live
          page. Collapsing the surface to zero size while a modal is open is
          what actually makes dialogs visible to the user.
        */}
        <BrowserSurface active={screen === 'browser' && !modalOpen} />
        {screen === 'library' && <LibraryScreen onOpenLive={() => setScreen('browser')} />}
        {screen === 'settings' && <SettingsScreen />}

        {openingArchive && (
          <BusyOverlay
            message="Opening website archive…"
            detail={`Verifying contents of ${openingArchive.split('/').pop()}`}
          />
        )}
      </div>

      {permissionRequest && (
        <PermissionPrompt
          key={permissionRequest.requestId}
          request={permissionRequest}
          onRespond={async (allow, remember) => {
            // Drop it from the queue first so the next prompt (if any)
            // appears immediately and can't be double-answered.
            setPermissionQueue((q) => q.filter((r) => r.requestId !== permissionRequest.requestId));
            await window.archiveBrowser.permissions.respond({
              requestId: permissionRequest.requestId,
              allow,
              remember,
              permissionKind: permissionRequest.permission,
            });
          }}
        />
      )}

      {scopeDialog && (
        <CaptureScopeDialog
          pageUrl={scopeDialog.url}
          pageTitle={scopeDialog.title}
          host={scopeDialog.host}
          onCancel={() => setScopeDialog(null)}
          onStart={async (scope: CaptureScope) => {
            setScopeDialog(null);
            if (!activeTabId) return;
            // Progress (including the job id) arrives via the capture
            // progress event, so nothing needs to be tracked here.
            await window.archiveBrowser.siteCapture.start(activeTabId, scope);
          }}
        />
      )}

      {captureProgress && (
        <CaptureProgressDialog
          progress={captureProgress}
          // The job id comes from the progress payload itself rather than
          // separate state, so pause/resume/cancel always target the job
          // actually being reported -- even for a capture this renderer
          // didn't start.
          onPause={() => window.archiveBrowser.siteCapture.pause(captureProgress.jobId)}
          onResume={() => window.archiveBrowser.siteCapture.resume(captureProgress.jobId)}
          onCancel={() => window.archiveBrowser.siteCapture.cancel(captureProgress.jobId)}
          onClose={() => setCaptureProgress(null)}
          onOpenArchive={(p) => void openArchivePath(p)}
          onRevealArchive={(p) => void window.archiveBrowser.siteArchive.revealInFolder(p)}
          onRetryFailed={async () => {
            // Resume-only retry: re-attempts exactly the recorded failures
            // against the already-finished archive, rather than re-running
            // the whole capture and re-fetching pages that already
            // succeeded. Progress arrives through the same capture-progress
            // event a fresh capture uses, so the dialog just keeps showing
            // (with kind: 'retry' distinguishing the two in its title).
            const archivePath = captureProgress?.result?.archivePath;
            if (!archivePath) return;
            await window.archiveBrowser.siteCapture.retryFailed(archivePath);
          }}
        />
      )}

      {recoverable && (
        <RecoveryDialog
          captures={recoverable}
          busyId={recoveryBusyId}
          errorById={recoveryErrors}
          onResume={(id) => void handleResumeRecovery(id)}
          onFinish={(id) => void handleFinishRecovery(id)}
          onDiscard={(id) => void handleDiscardRecovery(id)}
          onDismiss={() => setRecoverable(null)}
        />
      )}
    </div>
  );
}
