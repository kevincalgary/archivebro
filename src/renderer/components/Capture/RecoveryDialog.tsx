import { useEffect, useRef, useState } from 'react';
import type { RecoverableCaptureSummary } from '../../../shared/sitearchiveTypes';
import { Spinner } from '../Progress';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { scopeLabel } from './scopeLabels';

interface Props {
  captures: RecoverableCaptureSummary[];
  /** archiveId of the capture an action is currently in flight for, if any. */
  busyId: string | null;
  errorById: Record<string, string>;
  onResume: (archiveId: string) => void;
  onFinish: (archiveId: string) => void;
  onDiscard: (archiveId: string) => void;
  onDismiss: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/**
 * One recoverable capture's row, including its own two-step Discard
 * confirmation (in-line rather than a second dialog or a native prompt --
 * both a native `dialog.showMessageBox` and a nested HTML dialog would be
 * untestable/awkward here, and this keeps the destructive action just as
 * deliberate: it takes two distinct clicks either way).
 */
function RecoveryItem({
  capture,
  busy,
  error,
  onResume,
  onFinish,
  onDiscard,
}: {
  capture: RecoverableCaptureSummary;
  busy: boolean;
  error?: string;
  onResume: () => void;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const discardButtonRef = useRef<HTMLButtonElement>(null);

  // The Discard/Cancel pair replaces the Resume/Finish/Discard row
  // in place; without this, focus is left on a button that no longer
  // exists in the accessibility tree once React re-renders this swap.
  useEffect(() => {
    if (confirmingDiscard) discardButtonRef.current?.focus();
  }, [confirmingDiscard]);

  return (
    <div className="recovery-item">
      <div className="capture-target">
        <div className="capture-target-title">{capture.startUrl}</div>
        <div className="capture-target-url">
          {scopeLabel(capture.scopeKind)} · last activity {formatWhen(capture.lastActivityMs)}
        </div>
      </div>

      <div className="recovery-item-stats">
        <strong>{capture.pagesCompleted}</strong> page{capture.pagesCompleted === 1 ? '' : 's'} captured
        {capture.failureCount > 0 && (
          <>
            , <strong>{capture.failureCount}</strong> failure{capture.failureCount === 1 ? '' : 's'}
          </>
        )}{' '}
        · {formatBytes(capture.bytesOnDisk)} on disk
      </div>
      <div className="recovery-item-output" title={capture.outputPath}>
        Will be saved to {capture.outputPath}
      </div>

      {error && <p className="capture-error">{error}</p>}

      <div className="recovery-item-actions">
        {busy && <Spinner size={12} />}
        {confirmingDiscard ? (
          <>
            <span className="recovery-confirm-label">Discard everything captured so far?</span>
            <button className="danger" disabled={busy} onClick={onDiscard} ref={discardButtonRef}>
              Discard
            </button>
            <button disabled={busy} onClick={() => setConfirmingDiscard(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={onResume}>
              Resume
            </button>
            <button
              disabled={busy || !capture.canFinish}
              title={capture.canFinish ? undefined : 'Nothing was captured yet, so there is nothing to save.'}
              onClick={onFinish}
            >
              Finish
            </button>
            <button className="danger" disabled={busy} onClick={() => setConfirmingDiscard(true)}>
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Offers Finish / Resume / Discard for every capture left interrupted by a
 * crash or a failure that couldn't reach the final write. Shown once at
 * startup if any exist; all of the actual recovery logic (detecting,
 * finishing, resuming, discarding) lives in the main process -- this is
 * purely a display and confirmation layer over it.
 */
export default function RecoveryDialog({ captures, busyId, errorById, onResume, onFinish, onDiscard, onDismiss }: Props) {
  const dialogRef = useDialogA11y(onDismiss);

  return (
    <div className="dialog-overlay">
      <div className="dialog recovery-dialog" role="dialog" aria-modal="true" aria-label="Interrupted captures" ref={dialogRef} tabIndex={-1}>
        <h2>Interrupted capture{captures.length === 1 ? '' : 's'}</h2>
        <p className="recovery-intro">
          {captures.length === 1
            ? "A previous capture didn't finish."
            : `${captures.length} previous captures didn't finish.`}{' '}
          You can pick up where it left off, save what was captured so far, or discard it.
        </p>

        <div className="recovery-list">
          {captures.map((c) => (
            <RecoveryItem
              key={c.archiveId}
              capture={c}
              busy={busyId === c.archiveId}
              error={errorById[c.archiveId]}
              onResume={() => onResume(c.archiveId)}
              onFinish={() => onFinish(c.archiveId)}
              onDiscard={() => onDiscard(c.archiveId)}
            />
          ))}
        </div>

        <div className="dialog-actions">
          <button onClick={onDismiss}>Not now</button>
        </div>
      </div>
    </div>
  );
}
