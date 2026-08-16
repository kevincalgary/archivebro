import { useState } from 'react';
import type { CaptureScope, CaptureScopeKind } from '../../../shared/sitearchiveTypes';
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

function formatMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
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

  // Anything past the soft limits needs an explicit acknowledgement, since
  // a deep/wide crawl can take a long time and produce a very large file.
  const exceedsSoftLimits =
    scope.maxDepth > SCOPE_SOFT_LIMITS.maxDepth ||
    scope.maxPages > SCOPE_SOFT_LIMITS.maxPages ||
    scope.maxTotalBytes > SCOPE_SOFT_LIMITS.maxTotalBytes;

  const canStart = !exceedsSoftLimits || confirmedOverLimit;

  const estimate =
    kind === 'current-page'
      ? 'Just this one page.'
      : `Up to ${scope.maxPages} page${scope.maxPages === 1 ? '' : 's'} on ${host || 'this site'}, ` +
        `${scope.maxDepth} link${scope.maxDepth === 1 ? '' : 's'} deep, ` +
        `stopping at ${formatMb(scope.maxTotalBytes)} MB.`;

  function patch(p: Partial<CaptureScope>) {
    setCustom((c) => ({ ...c, ...p, kind: 'custom' }));
    setConfirmedOverLimit(false);
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog capture-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Capture the Page">
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
            <label className="field-row">
              Maximum link depth
              <input
                type="number"
                min={0}
                max={10}
                value={custom.maxDepth}
                onChange={(e) => patch({ maxDepth: Number(e.target.value) })}
              />
            </label>
            <label className="field-row">
              Maximum pages
              <input
                type="number"
                min={1}
                max={2000}
                value={custom.maxPages}
                onChange={(e) => patch({ maxPages: Number(e.target.value) })}
              />
            </label>
            <label className="field-row">
              Maximum archive size (MB)
              <input
                type="number"
                min={1}
                max={4096}
                value={formatMb(custom.maxTotalBytes)}
                onChange={(e) => patch({ maxTotalBytes: Math.max(1, Number(e.target.value)) * 1024 * 1024 })}
              />
            </label>
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
            This is a large capture (beyond the recommended {SCOPE_SOFT_LIMITS.maxPages} pages /{' '}
            {SCOPE_SOFT_LIMITS.maxDepth} depth / {formatMb(SCOPE_SOFT_LIMITS.maxTotalBytes)} MB). It may take a long time
            and produce a very large file. Continue anyway.
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
