import { useState } from 'react';
import type { CaptureScope, CaptureScopeKind } from '../../../shared/sitearchiveTypes';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import {
  DEFAULT_CAPTURE_SCOPE,
  DEFAULT_SITE_SCOPE,
  SCOPE_SOFT_LIMITS,
} from '../../../shared/sitearchiveTypes';

interface Props {
  pageUrl: string;
  pageTitle: string;
  host: string;
  onCancel: () => void;
  onStart: (scope: CaptureScope) => void;
}

function formatMb(bytes: number | null): number | '' {
  return bytes === null ? '' : Math.round(bytes / (1024 * 1024));
}

/** Blank input === no limit. */
function parseLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function describeLimit(value: number | null, unit: string): string {
  return value === null ? `unlimited ${unit}` : `${value} ${unit}`;
}

export default function CaptureScopeDialog({ pageUrl, pageTitle, host, onCancel, onStart }: Props) {
  const [kind, setKind] = useState<CaptureScopeKind>('current-page');
  const [custom, setCustom] = useState<CaptureScope>({ ...DEFAULT_SITE_SCOPE, kind: 'custom' });
  const [confirmedOverLimit, setConfirmedOverLimit] = useState(false);

  const scope: CaptureScope =
    kind === 'current-page'
      ? { ...DEFAULT_CAPTURE_SCOPE, kind: 'current-page' }
      : kind === 'entire-site'
        ? { ...DEFAULT_SITE_SCOPE, kind: 'entire-site' }
        : custom;

  // Anything past the soft limits -- including removing a limit entirely --
  // needs an explicit acknowledgement, since a deep/wide crawl can take a
  // long time and produce a very large file.
  const isUnlimited = scope.maxDepth === null || scope.maxPages === null || scope.maxTotalBytes === null;
  const exceedsSoftLimits =
    isUnlimited ||
    (scope.maxDepth ?? 0) > SCOPE_SOFT_LIMITS.maxDepth ||
    (scope.maxPages ?? 0) > SCOPE_SOFT_LIMITS.maxPages ||
    (scope.maxTotalBytes ?? 0) > SCOPE_SOFT_LIMITS.maxTotalBytes;

  const canStart = !exceedsSoftLimits || confirmedOverLimit;

  const estimate =
    kind === 'current-page'
      ? 'Just this one page.'
      : `${scope.maxPages === null ? 'Every reachable page' : `Up to ${scope.maxPages} page${scope.maxPages === 1 ? '' : 's'}`}` +
        ` on ${host || 'this site'}, ` +
        `${scope.maxDepth === null ? 'any number of links' : `${scope.maxDepth} link${scope.maxDepth === 1 ? '' : 's'}`} deep, ` +
        `${scope.maxTotalBytes === null ? 'with no size limit.' : `stopping at ${formatMb(scope.maxTotalBytes)} MB.`}`;

  function patch(p: Partial<CaptureScope>) {
    setCustom((c) => ({ ...c, ...p, kind: 'custom' }));
    setConfirmedOverLimit(false);
  }

  const dialogRef = useDialogA11y(onCancel);

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div
        className="dialog capture-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Capture the Page"
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2>Capture the Page</h2>
        <div className="capture-target">
          <div className="capture-target-title">{pageTitle || pageUrl}</div>
          <div className="capture-target-url">{pageUrl}</div>
        </div>

        <fieldset className="scope-choices">
          <legend>What should be captured?</legend>

          <label className={kind === 'current-page' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'current-page'} onChange={() => setKind('current-page')} />
            <div>
              <strong>Current page only</strong>
              <span>Saves just this page and the files it needs to display.</span>
            </div>
          </label>

          <label className={kind === 'entire-site' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'entire-site'} onChange={() => setKind('entire-site')} />
            <div>
              <strong>Entire current website</strong>
              <span>
                Follows links on <code>{host}</code> only. Links to other sites are not followed.
              </span>
            </div>
          </label>

          <label className={kind === 'custom' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'custom'} onChange={() => setKind('custom')} />
            <div>
              <strong>Custom scope</strong>
              <span>Choose exactly how far to go.</span>
            </div>
          </label>
        </fieldset>

        {kind === 'custom' && (
          <div className="custom-scope">
            <p className="settings-note">Leave a field blank for no limit.</p>
            <label className="field-row">
              Maximum link depth
              <input
                type="number"
                min={0}
                max={25}
                placeholder="No limit"
                value={custom.maxDepth ?? ''}
                onChange={(e) => patch({ maxDepth: parseLimit(e.target.value) })}
              />
            </label>
            <label className="field-row">
              Maximum pages
              <input
                type="number"
                min={1}
                max={50000}
                placeholder="No limit"
                value={custom.maxPages ?? ''}
                onChange={(e) => patch({ maxPages: parseLimit(e.target.value) })}
              />
            </label>
            <label className="field-row">
              Maximum archive size (MB)
              <input
                type="number"
                min={1}
                placeholder="No limit"
                value={formatMb(custom.maxTotalBytes)}
                onChange={(e) => {
                  const mb = parseLimit(e.target.value);
                  patch({ maxTotalBytes: mb === null ? null : Math.max(1, mb) * 1024 * 1024 });
                }}
              />
            </label>
            <button
              type="button"
              className="remove-limits-button"
              title="No page, depth or size limit, and include documents, audio and video"
              onClick={() =>
                // "Everything" has to mean media too -- audio/video are off
                // by default, so clearing only the numeric limits would
                // still silently skip videos.
                patch({
                  maxDepth: null,
                  maxPages: null,
                  maxTotalBytes: null,
                  includeDocuments: true,
                  includeMedia: true,
                })
              }
            >
              Capture everything (no limits)
            </button>
            <label className="field-row">
              Additional allowed domains
              <input
                type="text"
                placeholder="docs.example.com, cdn.example.com"
                value={custom.allowedDomains.join(', ')}
                onChange={(e) =>
                  patch({ allowedDomains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                }
              />
            </label>
            <label className="field-row">
              Include these external domains
              <input
                type="text"
                placeholder="(none)"
                value={custom.includeExternalDomains.join(', ')}
                onChange={(e) =>
                  patch({ includeExternalDomains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={custom.includeDocuments}
                onChange={(e) => patch({ includeDocuments: e.target.checked })}
              />
              Include downloadable documents (PDF, DOCX, …)
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={custom.includeMedia} onChange={(e) => patch({ includeMedia: e.target.checked })} />
              Include audio and video files (can be very large)
            </label>
            <label className="field-row">
              Crawl delay (ms)
              <input
                type="number"
                min={0}
                max={10000}
                value={custom.crawlDelayMs}
                onChange={(e) => patch({ crawlDelayMs: Number(e.target.value) })}
              />
            </label>
            <label className="field-row">
              Concurrency
              <input
                type="number"
                min={1}
                max={6}
                value={custom.concurrency}
                onChange={(e) => patch({ concurrency: Number(e.target.value) })}
              />
            </label>
          </div>
        )}

        <p className="capture-estimate">{estimate}</p>

        {exceedsSoftLimits && (
          <label className="over-limit-warning">
            <input type="checkbox" checked={confirmedOverLimit} onChange={(e) => setConfirmedOverLimit(e.target.checked)} />
            {isUnlimited ? (
              <span>
                You've removed one or more limits ({describeLimit(scope.maxPages, 'pages')},{' '}
                {describeLimit(scope.maxDepth, 'levels deep')},{' '}
                {scope.maxTotalBytes === null ? 'unlimited size' : `${formatMb(scope.maxTotalBytes)} MB`}). On a large
                site this can run for a very long time and produce a very large file. You can pause or cancel at any
                point, and capture will stop on its own if the disk runs low on space. Continue anyway.
              </span>
            ) : (
              <span>
                This is a large capture (beyond the recommended {SCOPE_SOFT_LIMITS.maxPages} pages /{' '}
                {SCOPE_SOFT_LIMITS.maxDepth} depth / {formatMb(SCOPE_SOFT_LIMITS.maxTotalBytes)} MB). It may take a long
                time and produce a very large file. Continue anyway.
              </span>
            )}
          </label>
        )}

        <p className="capture-note">
          Some websites can't be reproduced perfectly offline — live search, server-side forms, real-time feeds, chat,
          streaming or DRM-protected media, and anything needing an active server session won't work in the archive. A
          full-page screenshot and the page text are always saved as fallbacks.
        </p>

        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!canStart} onClick={() => onStart(scope)}>
            Start Capture
          </button>
        </div>
      </div>
    </div>
  );
}
