/**
 * Shared progress affordances.
 *
 * Two rules these follow throughout the app:
 *  - If we know how much work is left, show a determinate bar with real
 *    numbers. If we don't, show an indeterminate one -- never a fake
 *    percentage that pretends to know.
 *  - Anything that can take more than a moment gets *motion*, so a slow
 *    operation is visibly working rather than looking frozen.
 */

interface SpinnerProps {
  /** Pixel size of the spinner. */
  size?: number;
  label?: string;
  className?: string;
}

export function Spinner({ size = 14, label, className }: SpinnerProps) {
  return (
    <span className={`spinner-wrap ${className ?? ''}`}>
      <span
        className="spinner"
        style={{ width: size, height: size, borderWidth: Math.max(1.5, size / 8) }}
        role="progressbar"
        aria-label={label ?? 'Loading'}
        aria-busy="true"
      />
      {label && <span className="spinner-label">{label}</span>}
    </span>
  );
}

interface ProgressBarProps {
  /**
   * Completed units. Omit (or pass null) for an indeterminate bar, used
   * when the total genuinely isn't known yet.
   */
  value?: number | null;
  total?: number | null;
  label?: string;
  /** Right-aligned detail text, e.g. "12 of 30". */
  detail?: string;
  variant?: 'default' | 'success' | 'danger' | 'warn';
}

export function ProgressBar({ value, total, label, detail, variant = 'default' }: ProgressBarProps) {
  const isDeterminate =
    typeof value === 'number' && typeof total === 'number' && Number.isFinite(total) && total > 0;

  const pct = isDeterminate ? Math.max(0, Math.min(100, (value! / total!) * 100)) : null;

  return (
    <div className="progress">
      {(label || detail) && (
        <div className="progress-header">
          {label && <span className="progress-label">{label}</span>}
          {detail && <span className="progress-detail">{detail}</span>}
        </div>
      )}
      <div
        className={`progress-track progress-${variant}`}
        role="progressbar"
        aria-label={label ?? 'Progress'}
        {...(isDeterminate
          ? { 'aria-valuenow': Math.round(pct!), 'aria-valuemin': 0, 'aria-valuemax': 100 }
          : { 'aria-busy': 'true' })}
      >
        <div
          className={isDeterminate ? 'progress-fill' : 'progress-fill progress-fill-indeterminate'}
          style={isDeterminate ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

/**
 * Full-surface busy overlay for operations that block a whole screen --
 * opening a large archive, for example, which has to read and
 * checksum-verify entries before anything can be shown.
 */
export function BusyOverlay({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card">
        <Spinner size={28} />
        <div className="busy-message">{message}</div>
        {detail && <div className="busy-detail">{detail}</div>}
      </div>
    </div>
  );
}

/** Inline centered spinner for a panel that has nothing to show yet. */
export function LoadingPanel({ message = 'Loading…' }: { message?: string }) {
  return (
    <div className="loading-panel" role="status" aria-live="polite">
      <Spinner size={20} />
      <span>{message}</span>
    </div>
  );
}
