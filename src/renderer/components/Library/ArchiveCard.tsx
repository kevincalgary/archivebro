import { Fragment } from 'react';
import type { LibraryResultItem } from '../../../shared/types';
import { SNIPPET_MARK_START, SNIPPET_MARK_END } from '../../../shared/types';

interface Props {
  archive: LibraryResultItem;
  onOpen: () => void;
}

/**
 * Splits a search snippet on FTS5's own match markers (not HTML) and
 * wraps the matched spans in <mark>. Alternating parts are plain/matched
 * because snippet() always emits them as start-match-end triples.
 */
function renderSnippet(snippet: string) {
  const parts = snippet.split(new RegExp(`[${SNIPPET_MARK_START}${SNIPPET_MARK_END}]`));
  return parts.map((part, i) => (
    <Fragment key={i}>{i % 2 === 1 ? <mark>{part}</mark> : part}</Fragment>
  ));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ArchiveCard({ archive, onOpen }: Props) {
  return (
    <button className={`archive-card archive-status-${archive.status}`} onClick={onOpen}>
      <div className="archive-card-thumb">
        {archive.status === 'success' ? (
          <img src={`archive://${archive.id}/screenshot.png`} alt="" loading="lazy" />
        ) : (
          <div className="archive-card-thumb-placeholder">{archive.status}</div>
        )}
      </div>
      <div className="archive-card-title">{archive.title || archive.finalUrl}</div>
      <div className="archive-card-domain">{archive.domain}</div>
      {archive.snippet && <div className="archive-card-snippet">{renderSnippet(archive.snippet)}</div>}
      <div className="archive-card-meta">
        <span>{formatDate(archive.visitedAt)}</span>
        <span>{formatSize(archive.sizeBytes)}</span>
      </div>
      {archive.tags.length > 0 && (
        <div className="archive-card-tags">
          {archive.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
