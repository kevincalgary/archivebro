import type { CaptureStatus } from '../../shared/types';

interface Props {
  status: CaptureStatus | null;
  paused: boolean;
}

const LABELS: Record<CaptureStatus, string> = {
  idle: '',
  pending: 'Capture scheduled…',
  capturing: 'Capturing page…',
  success: 'Page archived',
  failed: 'Archive failed',
  'skipped-excluded': 'Not archived (excluded domain or paused)',
  'skipped-private': 'Not archived (private tab)',
  'skipped-non-http': 'Not archived (not a web page)',
};

const ICONS: Record<CaptureStatus, string> = {
  idle: '',
  pending: '⏳',
  capturing: '💾',
  success: '✅',
  failed: '⚠️',
  'skipped-excluded': '🚫',
  'skipped-private': '🕶',
  'skipped-non-http': '—',
};

export default function CaptureIndicator({ status, paused }: Props) {
  if (paused) {
    return (
      <span
        className="capture-indicator"
        title="Automatic archiving paused for this tab"
        role="status"
        aria-label="Automatic archiving paused for this tab"
      >
        ⏸
      </span>
    );
  }
  if (!status || status === 'idle') return null;

  // The pending/capturing states animate (see .capture-pending /
  // .capture-capturing in global.css) so background archiving is visibly
  // in progress rather than looking like a static icon.
  return (
    <span
      className={`capture-indicator capture-${status}`}
      title={LABELS[status]}
      role="status"
      aria-live="polite"
      aria-label={LABELS[status]}
    >
      {ICONS[status]}
    </span>
  );
}
