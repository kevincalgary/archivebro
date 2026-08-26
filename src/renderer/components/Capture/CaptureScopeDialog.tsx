import { useEffect, useState } from 'react';
import type { CaptureScope, CaptureScopeKind } from '../../../shared/sitearchiveTypes';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import {
  DEFAULT_CAPTURE_SCOPE,
  DEFAULT_SITE_SCOPE,
  DEFAULT_FORUM_THREAD_SCOPE,
  DEFAULT_FORUM_SECTION_SCOPE,
  DEFAULT_FORUM_WHOLE_SCOPE,
  SCOPE_SOFT_LIMITS,
} from '../../../shared/sitearchiveTypes';

interface Props {
  tabId: string;
  pageUrl: string;
  pageTitle: string;
  host: string;
  onCancel: () => void;
  onStart: (scope: CaptureScope) => void;
}

const FORUM_KINDS: CaptureScopeKind[] = ['forum-thread', 'forum-section', 'forum-whole'];
function isForumKind(kind: CaptureScopeKind): boolean {
  return FORUM_KINDS.includes(kind);
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

export default function CaptureScopeDialog({ tabId, pageUrl, pageTitle, host, onCancel, onStart }: Props) {
  const [kind, setKind] = useState<CaptureScopeKind>('current-page');
  const [custom, setCustom] = useState<CaptureScope>({ ...DEFAULT_SITE_SCOPE, kind: 'custom' });
  const [forumScope, setForumScope] = useState<CaptureScope>(DEFAULT_FORUM_THREAD_SCOPE);
  const [confirmedOverLimit, setConfirmedOverLimit] = useState(false);
  const [confirmedForumWarning, setConfirmedForumWarning] = useState(false);
  const [forumEstimate, setForumEstimate] = useState<{ estimatedThreads: number | null; note: string } | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);

  const scope: CaptureScope =
    kind === 'current-page'
      ? { ...DEFAULT_CAPTURE_SCOPE, kind: 'current-page' }
      : kind === 'entire-site'
        ? { ...DEFAULT_SITE_SCOPE, kind: 'entire-site' }
        : isForumKind(kind)
          ? { ...forumScope, kind }
          : custom;

  // Pre-flight estimate for the two forum scopes that can reach more than
  // one thread. Re-fetched whenever the forum kind changes; always framed
  // as an approximation, never a promise -- see estimateForumLinkCount().
  useEffect(() => {
    if (kind !== 'forum-section' && kind !== 'forum-whole') {
      setForumEstimate(null);
      return;
    }
    let cancelled = false;
    setEstimateLoading(true);
    window.archiveBrowser.siteCapture
      .estimate(tabId, kind)
      .then((info) => {
        if (!cancelled) setForumEstimate(info.forumEstimate ?? null);
      })
      .catch(() => {
        if (!cancelled) setForumEstimate(null);
      })
      .finally(() => {
        if (!cancelled) setEstimateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, tabId]);

  // Anything past the soft limits -- including removing a limit entirely --
  // needs an explicit acknowledgement, since a deep/wide crawl can take a
  // long time and produce a very large file.
  const isUnlimited = scope.maxDepth === null || scope.maxPages === null || scope.maxTotalBytes === null;
  const exceedsSoftLimits =
    isUnlimited ||
    (scope.maxDepth ?? 0) > SCOPE_SOFT_LIMITS.maxDepth ||
    (scope.maxPages ?? 0) > SCOPE_SOFT_LIMITS.maxPages ||
    (scope.maxTotalBytes ?? 0) > SCOPE_SOFT_LIMITS.maxTotalBytes;

  const canStart = (!exceedsSoftLimits || confirmedOverLimit) && (!isForumKind(kind) || confirmedForumWarning);

  const estimate = isForumKind(kind)
    ? kind === 'forum-thread'
      ? 'Every page of this thread only -- no other threads.'
      : kind === 'forum-section'
        ? `This section's threads and pagination, up to ${scope.maxPages === null ? 'no page limit' : `${scope.maxPages} pages`}. Other sections are not included.`
        : `Every public section and thread on ${host || 'this forum'}, subject to the limits below.`
    : kind === 'current-page'
      ? 'Just this one page.'
      : `${scope.maxPages === null ? 'Every reachable page' : `Up to ${scope.maxPages} page${scope.maxPages === 1 ? '' : 's'}`}` +
        ` on ${host || 'this site'}, ` +
        `${scope.maxDepth === null ? 'any number of links' : `${scope.maxDepth} link${scope.maxDepth === 1 ? '' : 's'}`} deep, ` +
        `${scope.maxTotalBytes === null ? 'with no size limit.' : `stopping at ${formatMb(scope.maxTotalBytes)} MB.`}`;

  function patch(p: Partial<CaptureScope>) {
    setCustom((c) => ({ ...c, ...p, kind: 'custom' }));
    setConfirmedOverLimit(false);
  }

  function patchForum(p: Partial<CaptureScope>) {
    setForumScope((c) => ({ ...c, ...p }));
    setConfirmedOverLimit(false);
  }

  function selectForumKind(next: 'forum-thread' | 'forum-section' | 'forum-whole') {
    setKind(next);
    setForumScope((c) => ({
      ...(next === 'forum-thread' ? DEFAULT_FORUM_THREAD_SCOPE : next === 'forum-section' ? DEFAULT_FORUM_SECTION_SCOPE : DEFAULT_FORUM_WHOLE_SCOPE),
      // Preserve any toggles the user already set while switching between forum kinds.
      forumIncludeProfiles: c.forumIncludeProfiles,
      forumDownloadAttachments: c.forumDownloadAttachments,
      forumAttemptExternalImages: c.forumAttemptExternalImages,
    }));
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

          <label className={kind === 'forum-thread' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'forum-thread'} onChange={() => selectForumKind('forum-thread')} />
            <div>
              <strong>This forum thread</strong>
              <span>Every page of this thread's pagination, posts, images and attachments. No other threads.</span>
            </div>
          </label>

          <label className={kind === 'forum-section' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'forum-section'} onChange={() => selectForumKind('forum-section')} />
            <div>
              <strong>This forum section</strong>
              <span>This section's pagination and every thread listed in it. Other sections are not included.</span>
            </div>
          </label>

          <label className={kind === 'forum-whole' ? 'scope-choice scope-choice-active' : 'scope-choice'}>
            <input type="radio" name="scope" checked={kind === 'forum-whole'} onChange={() => selectForumKind('forum-whole')} />
            <div>
              <strong>Entire forum</strong>
              <span>
                Every public section and thread on <code>{host}</code>, subject to the limits below. Can take a long
                time and a lot of disk space on a large forum.
              </span>
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
            <label className="field-row">
              Always include these paths
              <input
                type="text"
                placeholder="/search, /login"
                value={(custom.allowedNonContentPaths ?? []).join(', ')}
                onChange={(e) =>
                  patch({ allowedNonContentPaths: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                }
              />
            </label>
            <p className="settings-note">
              Sign-in, search, account and similar routes are skipped by default. List any part of a path here (e.g.
              "/search") to capture matching pages anyway.
            </p>
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

        {isForumKind(kind) && (
          <div className="custom-scope">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={forumScope.forumIncludeProfiles ?? false}
                onChange={(e) => patchForum({ forumIncludeProfiles: e.target.checked })}
              />
              Follow links to member/author profile pages
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={forumScope.forumDownloadAttachments ?? true}
                onChange={(e) => patchForum({ forumDownloadAttachments: e.target.checked })}
              />
              Download attachments (files linked from posts)
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={forumScope.forumAttemptExternalImages ?? true}
                onChange={(e) => patchForum({ forumAttemptExternalImages: e.target.checked })}
              />
              Attempt images hosted on other sites
            </label>
            {kind !== 'forum-thread' && (
              <>
                <label className="field-row">
                  Maximum pages
                  <input
                    type="number"
                    min={1}
                    max={50000}
                    placeholder="No limit"
                    value={forumScope.maxPages ?? ''}
                    onChange={(e) => patchForum({ maxPages: parseLimit(e.target.value) })}
                  />
                </label>
                <label className="field-row">
                  Maximum archive size (MB)
                  <input
                    type="number"
                    min={1}
                    placeholder="No limit"
                    value={formatMb(forumScope.maxTotalBytes)}
                    onChange={(e) => {
                      const mb = parseLimit(e.target.value);
                      patchForum({ maxTotalBytes: mb === null ? null : Math.max(1, mb) * 1024 * 1024 });
                    }}
                  />
                </label>
              </>
            )}
            <label className="field-row">
              Request delay (ms)
              <input
                type="number"
                min={0}
                max={10000}
                value={forumScope.crawlDelayMs}
                onChange={(e) => patchForum({ crawlDelayMs: Number(e.target.value) })}
              />
            </label>
          </div>
        )}

        <p className="capture-estimate">{estimate}</p>

        {isForumKind(kind) && (kind === 'forum-section' || kind === 'forum-whole') && (
          <p className="capture-estimate">
            {estimateLoading ? 'Estimating…' : (forumEstimate?.note ?? 'Estimate unavailable for this page.')}
          </p>
        )}

        {isForumKind(kind) && (
          <label className="over-limit-warning">
            <input type="checkbox" checked={confirmedForumWarning} onChange={(e) => setConfirmedForumWarning(e.target.checked)} />
            <span>
              If this content requires your account to view, sharing this archive with anyone else could give them
              access to it too. Only proceed if you're comfortable with everyone you might share this archive with
              seeing what's captured. Continue.
            </span>
          </label>
        )}

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
