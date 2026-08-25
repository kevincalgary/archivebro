import { useCallback, useEffect, useState } from 'react';
import type { LibraryQuery, LibraryResultItem } from '../../../shared/types';
import ArchiveCard from './ArchiveCard';
import ArchiveDetail from './ArchiveDetail';
import { LoadingPanel, Spinner } from '../Progress';

interface Props {
  onOpenLive: () => void;
}

const PAGE_SIZE = 40;

export default function LibraryScreen({ onOpenLive }: Props) {
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState<LibraryQuery['status'] | ''>('');
  const [sort, setSort] = useState<LibraryQuery['sort']>('newest');
  const [items, setItems] = useState<LibraryResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runQuery = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.archiveBrowser.library.query({
        search: search || undefined,
        domain: domain || undefined,
        status: status || undefined,
        sort,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setItems(result.items);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [search, domain, status, sort]);

  useEffect(() => {
    const handle = setTimeout(() => void runQuery(), 200);
    return () => clearTimeout(handle);
  }, [runQuery]);

  const domains = Array.from(new Set(items.map((i) => i.domain))).sort();

  return (
    <div className="library-screen">
      <div className="library-header">
        <h1>Library</h1>
        <input
          className="library-search"
          placeholder="Search title, URL, or page text…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as LibraryQuery['status'] | '')}>
          <option value="">Any status</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="skipped-excluded">Skipped (excluded)</option>
          <option value="skipped-private">Skipped (private)</option>
        </select>
        {search.trim().length > 0 ? (
          <span className="library-sort-note" title="Search results are ranked by relevance, not the sort below">
            Sorted by relevance
          </span>
        ) : (
          <select value={sort} onChange={(e) => setSort(e.target.value as LibraryQuery['sort'])}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="domain">Domain</option>
            <option value="size">Size</option>
          </select>
        )}
      </div>

      <div className="library-meta">
        {loading ? (
          <Spinner size={12} label="Searching archives…" />
        ) : (
          `${total} archived page${total === 1 ? '' : 's'}`
        )}
      </div>

      <div className="library-grid">
        {/* Keep showing the previous results while a new search runs, so
            the grid doesn't blank out on every keystroke. */}
        {items.map((item) => (
          <ArchiveCard key={item.id} archive={item} onOpen={() => setSelectedId(item.id)} />
        ))}
        {loading && items.length === 0 && <LoadingPanel message="Searching archives…" />}
        {!loading && items.length === 0 && (
          <div className="library-empty">
            No archives yet. Browse normally and pages will be saved here automatically after a few seconds on each
            page.
          </div>
        )}
      </div>

      {selectedId && (
        <ArchiveDetail
          archiveId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void runQuery()}
          onOpenLive={onOpenLive}
        />
      )}
    </div>
  );
}
