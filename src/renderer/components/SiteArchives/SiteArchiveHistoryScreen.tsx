import { useEffect, useState } from 'react';
import type { SiteArchiveHistoryEntry } from '../../../shared/sitearchiveTypes';
import { scopeLabel } from '../Capture/scopeLabels';
import { LoadingPanel } from '../Progress';

interface Props {
  onOpenLive: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Persistent, app-wide list of completed .sitearchive captures -- separate
 * from the Library (which only tracks single-page auto-captures). Backed
 * by site_archive_captures / siteArchiveHistoryRepo.ts. A row here is just
 * an index; the archive's actual content is always the file itself, so a
 * missing file is shown, not hidden -- see fileExists below.
 */
export default function SiteArchiveHistoryScreen({ onOpenLive }: Props) {
  const [entries, setEntries] = useState<SiteArchiveHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setEntries(await window.archiveBrowser.siteArchiveHistory.list());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function openEntry(entry: SiteArchiveHistoryEntry) {
    if (!entry.fileExists) return;
    setBusyId(entry.archiveId);
    try {
      await window.archiveBrowser.siteArchive.openPath(entry.outputPath);
      onOpenLive();
    } finally {
      setBusyId(null);
    }
  }

  async function reveal(entry: SiteArchiveHistoryEntry) {
    await window.archiveBrowser.siteArchiveHistory.reveal(entry.archiveId);
  }

  async function remove(entry: SiteArchiveHistoryEntry) {
    setBusyId(entry.archiveId);
    try {
      await window.archiveBrowser.siteArchiveHistory.remove(entry.archiveId);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="library-screen">
      <div className="library-header">
        <h1>Saved Sites &amp; Forums</h1>
        <p className="settings-note">
          Every website or forum you've saved as a portable <code>.sitearchive</code> file. Removing an entry here
          only removes it from this list -- the file itself is untouched.
        </p>
      </div>

      {loading ? (
        <LoadingPanel message="Loading saved sites…" />
      ) : entries.length === 0 ? (
        <p className="settings-note">Nothing saved yet. Use "Capture the Page" to save a site or forum.</p>
      ) : (
        <ul className="site-archive-history-list">
          {entries.map((entry) => (
            <li key={entry.archiveId} className="site-archive-history-item">
              <div className="site-archive-history-main">
                <div className="site-archive-history-title">
                  {entry.siteTitle || entry.startUrl}
                  {!entry.isComplete && <span className="site-archive-history-badge">Incomplete</span>}
                  {!entry.fileExists && <span className="site-archive-history-badge site-archive-history-badge-missing">File not found</span>}
                </div>
                <div className="site-archive-history-url">{entry.startUrl}</div>
                <div className="site-archive-history-meta">
                  {scopeLabel(entry.scopeKind)} · {formatDate(entry.capturedAt)} · {entry.pageCount} page
                  {entry.pageCount === 1 ? '' : 's'}
                  {entry.threadCount !== null && `, ${entry.threadCount} thread${entry.threadCount === 1 ? '' : 's'}`}
                  {entry.assetCount > 0 && `, ${entry.assetCount} image${entry.assetCount === 1 ? '' : 's'}/file${entry.assetCount === 1 ? '' : 's'}`}
                  {' · '}
                  {formatBytes(entry.fileSizeBytes)}
                </div>
                {!entry.isComplete && entry.incompleteReason && (
                  <div className="site-archive-history-incomplete-reason">{entry.incompleteReason}</div>
                )}
              </div>
              <div className="site-archive-history-actions">
                {entry.fileExists ? (
                  <>
                    <button disabled={busyId === entry.archiveId} onClick={() => void openEntry(entry)}>
                      Open
                    </button>
                    <button disabled={busyId === entry.archiveId} onClick={() => void reveal(entry)}>
                      Reveal
                    </button>
                  </>
                ) : null}
                <button disabled={busyId === entry.archiveId} onClick={() => void remove(entry)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
