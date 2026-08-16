import type { CaptureProgress } from '../../../shared/sitearchiveTypes';

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

  return (
    <div className="dialog-overlay">
      <div className="dialog capture-progress-dialog" role="dialog" aria-label="Capture progress">
        <h2>
          {progress.state === 'completed'
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

        <dl className="capture-stats">
          <div>
            <dt>Pages discovered</dt>
            <dd>{progress.pagesDiscovered}</dd>
          </div>
          <div>
            <dt>Pages saved</dt>
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
            <span className="capture-current-label">
              {progress.state === 'paused' ? 'Paused at' : progress.state === 'finalizing' ? 'Finalizing' : 'Now capturing'}
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
