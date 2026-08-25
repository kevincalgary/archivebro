import { useEffect, useRef, useState } from 'react';
import type { CaptureProgress } from '../../../shared/sitearchiveTypes';
import { ProgressBar, Spinner } from '../Progress';
import { useDialogA11y } from '../../hooks/useDialogA11y';

interface Props {
  progress: CaptureProgress;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onClose: () => void;
  onOpenArchive: (path: string) => void;
  onRevealArchive: (path: string) => void;
  onRetryFailed: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const SCOPE_LABEL: Record<string, string> = {
  'current-page': 'Current page only',
  'entire-site': 'Entire website',
  custom: 'Custom scope',
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/** Ticks once a second while a capture is running, for the elapsed clock. */
function useElapsed(running: boolean): number {
  const startRef = useRef<number>(Date.now());
  const [, force] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return Date.now() - startRef.current;
}

export default function CaptureProgressDialog({
  progress,
  onPause,
  onResume,
  onCancel,
  onClose,
  onOpenArchive,
  onRevealArchive,
  onRetryFailed,
}: Props) {
  const isDone = progress.state === 'completed' || progress.state === 'failed' || progress.state === 'cancelled';
  const result = progress.result;
  const revealLabel = navigator.platform.toLowerCase().includes('mac') ? 'Reveal in Finder' : 'Show in File Explorer';
  const elapsed = useElapsed(!isDone);

  // Progress is measured against pages *discovered so far*, which is the
  // only honest denominator during a crawl: the total isn't knowable up
  // front, and discovering new links legitimately makes the bar recede.
  // Finalizing (zipping + checksums) has no countable unit, so it gets an
  // indeterminate bar rather than a made-up percentage.
  const showDeterminate = !isDone && progress.state !== 'finalizing' && progress.pagesDiscovered > 0;
  // Escape only closes once there's nothing left to lose -- cancelling an
  // in-progress capture is a deliberate, consequential action that stays
  // behind its own Cancel button, not a side effect of dismissing.
  const dialogRef = useDialogA11y(isDone ? onClose : undefined);

  return (
    <div className="dialog-overlay">
      <div
        className="dialog capture-progress-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Capture progress"
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2>
          {progress.kind === 'retry'
            ? progress.state === 'completed'
              ? 'Retry complete'
              : progress.state === 'failed'
                ? 'Retry failed'
                : progress.state === 'cancelled'
                  ? 'Retry cancelled'
                  : 'Retrying failed pages…'
            : progress.state === 'completed'
              ? 'Capture complete'
              : progress.state === 'failed'
                ? 'Capture failed'
                : progress.state === 'cancelled'
                  ? 'Capture cancelled'
                  : 'Capturing website…'}
        </h2>

        <div className="capture-target">
          <div className="capture-target-title">{progress.siteTitle || progress.startUrl}</div>
          <div className="capture-target-url">{progress.startUrl}</div>
          <div className="capture-scope-label">{SCOPE_LABEL[progress.scopeKind] ?? progress.scopeKind}</div>
        </div>

        {/* One progress section in a fixed position, so the bar doesn't
            jump around the dialog when the capture finishes. */}
        <div className="capture-progress-section">
          {isDone ? (
            <ProgressBar
              value={1}
              total={1}
              label={
                progress.state === 'completed' ? 'Finished' : progress.state === 'cancelled' ? 'Cancelled' : 'Stopped'
              }
              detail={`${progress.pagesCompleted} page${progress.pagesCompleted === 1 ? '' : 's'} · ${formatDuration(elapsed)}`}
              variant={progress.state === 'completed' ? 'success' : progress.state === 'failed' ? 'danger' : 'warn'}
            />
          ) : (
            <ProgressBar
              value={showDeterminate ? progress.pagesCompleted : null}
              total={showDeterminate ? progress.pagesDiscovered : null}
              label={
                progress.state === 'finalizing'
                  ? 'Writing archive file'
                  : progress.state === 'paused'
                    ? 'Paused'
                    : progress.kind === 'retry'
                      ? 'Retrying pages'
                      : 'Capturing pages'
              }
              detail={
                showDeterminate
                  ? `${progress.pagesCompleted} of ${progress.pagesDiscovered} ${progress.kind === 'retry' ? 'retried' : 'found'} · ${formatDuration(elapsed)}`
                  : formatDuration(elapsed)
              }
              variant={progress.state === 'paused' ? 'warn' : 'default'}
            />
          )}
        </div>

        <dl className="capture-stats">
          <div>
            <dt>{progress.kind === 'retry' ? 'Pages to retry' : 'Pages discovered'}</dt>
            <dd>{progress.pagesDiscovered}</dd>
          </div>
          <div>
            <dt>{progress.kind === 'retry' ? 'Retried' : 'Pages saved'}</dt>
            <dd>{progress.pagesCompleted}</dd>
          </div>
          <div>
            <dt>Downloaded</dt>
            <dd>{formatBytes(progress.bytesDownloaded)}</dd>
          </div>
          <div>
            <dt>Warnings</dt>
            <dd>{progress.warningCount}</dd>
          </div>
          <div>
            <dt>Failures</dt>
            <dd>{progress.failureCount}</dd>
          </div>
        </dl>

        {!isDone && (
          <div className="capture-current">
            {progress.state !== 'paused' && <Spinner size={11} className="capture-current-spinner" />}
            <span className="capture-current-label">
              {progress.state === 'paused'
                ? 'Paused at'
                : progress.state === 'finalizing'
                  ? 'Finalizing'
                  : progress.kind === 'retry'
                    ? 'Now retrying'
                    : 'Now capturing'}
            </span>
            <span className="capture-current-url">{progress.currentUrl ?? '—'}</span>
          </div>
        )}

        {progress.state === 'failed' && progress.error && <p className="capture-error">{progress.error}</p>}

        {result && (
          <div className="capture-result">
            <div className="capture-result-row">
              <strong>{result.pageCount}</strong> pages, <strong>{result.assetCount}</strong> assets,{' '}
              <strong>{formatBytes(result.fileSizeBytes)}</strong>
            </div>
            <div className="capture-result-path" title={result.archivePath}>
              {result.archivePath}
            </div>
            {result.failures.length > 0 && (
              <details className="capture-failures">
                <summary>{result.failures.length} page(s) or resource(s) could not be captured</summary>
                <ul>
                  {result.failures.slice(0, 50).map((f, i) => (
                    <li key={`${f.url}-${i}`}>
                      <code>{f.url}</code> — {f.kind}: {f.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="dialog-actions">
          {!isDone && progress.state !== 'finalizing' && (
            <>
              {progress.state === 'paused' ? (
                <button onClick={onResume}>Resume</button>
              ) : (
                <button onClick={onPause}>Pause</button>
              )}
              <button className="danger" onClick={onCancel}>
                Cancel
              </button>
            </>
          )}

          {isDone && (
            <>
              {result && result.failures.length > 0 && <button onClick={onRetryFailed}>Retry failed pages</button>}
              {result && <button onClick={() => onRevealArchive(result.archivePath)}>{revealLabel}</button>}
              {result && (
                <button className="primary" onClick={() => onOpenArchive(result.archivePath)}>
                  Open Archive
                </button>
              )}
              <button onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
