import { useEffect, useState } from 'react';
import type { ArchiveDetail as ArchiveDetailType, ArchiveRecord } from '../../../shared/types';
import { useAppStore } from '../../state/store';
import { LoadingPanel, Spinner } from '../Progress';
import { useDialogA11y } from '../../hooks/useDialogA11y';

interface Props {
  archiveId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenLive: () => void;
}

export default function ArchiveDetail({ archiveId, onClose, onChanged, onOpenLive }: Props) {
  const setActiveTabId = useAppStore((s) => s.setActiveTabId);
  const [detail, setDetail] = useState<ArchiveDetailType | null>(null);
  const [versions, setVersions] = useState<ArchiveRecord[]>([]);
  const [titleDraft, setTitleDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [exporting, setExporting] = useState(false);
  const dialogRef = useDialogA11y(onClose);

  useEffect(() => {
    void window.archiveBrowser.library.getDetail(archiveId).then((d) => {
      setDetail(d);
      if (d) {
        setTitleDraft(d.title);
        setTagsDraft(d.tags.join(', '));
        void window.archiveBrowser.library.getVersions(d.canonicalUrl).then(setVersions);
      }
    });
  }, [archiveId]);

  // Show the panel immediately with a spinner rather than rendering
  // nothing until the detail query returns.
  if (!detail) {
    return (
      <div className="archive-detail-overlay" onClick={onClose}>
        <div className="archive-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Archive details">
          <LoadingPanel message="Loading archive details…" />
        </div>
      </div>
    );
  }

  return (
    <div className="archive-detail-overlay" onClick={onClose}>
      <div
        className="archive-detail"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Archive details: ${detail.title || detail.finalUrl}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <button className="archive-detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {detail.status === 'success' && (
          <img className="archive-detail-thumb" src={`archive://${detail.id}/screenshot.png`} alt="" />
        )}

        <label className="field-label" htmlFor="archive-detail-title">
          Title
        </label>
        <input id="archive-detail-title" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />

        <label className="field-label" htmlFor="archive-detail-tags">
          Tags (comma separated)
        </label>
        <input id="archive-detail-tags" value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} />

        <button
          onClick={async () => {
            await window.archiveBrowser.library.rename(detail.id, titleDraft);
            await window.archiveBrowser.library.tag(
              detail.id,
              tagsDraft
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            );
            onChanged();
          }}
        >
          Save
        </button>

        <dl className="archive-detail-meta">
          <dt>URL</dt>
          <dd>{detail.finalUrl}</dd>
          {detail.originalUrl !== detail.finalUrl && (
            <>
              <dt>Original URL</dt>
              <dd>{detail.originalUrl}</dd>
            </>
          )}
          {detail.referrerUrl && (
            <>
              <dt>Referrer</dt>
              <dd>{detail.referrerUrl}</dd>
            </>
          )}
          <dt>Visited</dt>
          <dd>{new Date(detail.visitedAt).toLocaleString()}</dd>
          <dt>Captured</dt>
          <dd>{new Date(detail.capturedAt).toLocaleString()}</dd>
          <dt>Status</dt>
          <dd>{detail.status}</dd>
          <dt>Size</dt>
          <dd>{(detail.sizeBytes / 1024).toFixed(1)} KB</dd>
          {detail.warnings.length > 0 && (
            <>
              <dt>Warnings</dt>
              <dd>
                {detail.warnings.map((w) => (
                  <div key={w.code}>{w.message}</div>
                ))}
              </dd>
            </>
          )}
        </dl>

        {versions.length > 1 && (
          <div className="archive-detail-versions">
            <h3>{versions.length} versions of this page</h3>
            <ul>
              {versions.map((v) => (
                <li key={v.id}>
                  {new Date(v.visitedAt).toLocaleString()} — {v.status}
                  {v.id === detail.id ? ' (viewing)' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="archive-detail-actions">
          <button
            disabled={!detail.hasMhtml && !detail.hasScreenshot && !detail.hasText}
            onClick={async () => {
              const tabId = await window.archiveBrowser.library.openOffline(detail.id);
              setActiveTabId(tabId);
              onOpenLive();
              onClose();
            }}
          >
            Open offline
          </button>
          <button
            onClick={async () => {
              const tabId = await window.archiveBrowser.library.openLive(detail.id);
              setActiveTabId(tabId);
              onOpenLive();
              onClose();
            }}
          >
            Open live page
          </button>
          <button onClick={() => window.archiveBrowser.library.revealInFolder(detail.id)}>Reveal in folder</button>
          <button
            disabled={exporting}
            onClick={async () => {
              // Exporting zips the archive directory, which is not instant
              // for a large page -- keep the button visibly busy.
              setExporting(true);
              try {
                await window.archiveBrowser.library.export(detail.id);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? <Spinner size={11} label="Exporting…" /> : 'Export…'}
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Delete this archived version? This cannot be undone.')) return;
              await window.archiveBrowser.library.delete(detail.id);
              onChanged();
              onClose();
            }}
          >
            Delete
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`Delete ALL archives for ${detail.domain}? This cannot be undone.`)) return;
              await window.archiveBrowser.library.deleteByDomain(detail.domain);
              onChanged();
              onClose();
            }}
          >
            Delete all for {detail.domain}
          </button>
        </div>
      </div>
    </div>
  );
}
