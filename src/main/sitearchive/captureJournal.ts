import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ArchivedAssetEntry,
  ArchivedPageEntry,
  ArchivedResponseEntry,
  CaptureFailureEntry,
  CaptureScope,
  ForumPostEntry,
  RouteMapEntry,
} from '../../shared/sitearchiveTypes';
import { logger } from '../util/logger';
import { normalizeUrl } from './urlNormalize';

/**
 * Crash-recovery journal for a running site capture.
 *
 * A `.sitearchive` is only zipped and renamed into place once the whole
 * crawl finishes, which is what guarantees a half-written archive can
 * never appear at that path -- but it also means a multi-hour crawl that
 * dies at minute 150 produces nothing at all. That happened: a 151-minute,
 * 810-page, 2.6 GB crawl left a full staging tree and no output.
 *
 * Everything the crawl captures is already written to the staging tree as
 * it goes, so the *bytes* were never the problem. What died with the
 * process was the bookkeeping held in memory: which pages exist, which
 * assets dedupe to which hash, the route map, and the crawl queue. This
 * journal writes that bookkeeping to disk as it is produced, so a killed
 * capture can be replayed back into a builder and either finished as a
 * partial archive or resumed where it stopped.
 *
 * Ordering rule, which the whole design rests on: **bytes are written to
 * the staging tree first, and the journal record is appended only after
 * that succeeds.** A crash can therefore leave a file the journal never
 * mentions (harmless -- the manifest is the authority and unlisted
 * entries are ignored), but never a journal record pointing at a file
 * that isn't there.
 */

export const CHECKPOINT_META_FILE = 'checkpoint-meta.json';
export const CHECKPOINT_JOURNAL_FILE = 'checkpoint.jsonl';
/**
 * Names the process currently appending to this staging dir's journal, if
 * any. Written while a `CaptureJournal` is open and removed when it closes
 * -- including in the ordinary success/failure/cancel paths, since those
 * all close the journal in a `finally`. A lock file that survives is
 * therefore either a genuinely live capture (same or another app instance,
 * possibly sharing this OS temp directory) or one that died without
 * unwinding -- {@link isStagingDirLive} tells those apart by checking
 * whether the named pid is still running.
 */
export const CHECKPOINT_LOCK_FILE = 'checkpoint.lock.json';

/** Bumped when the journal's record shapes change incompatibly. */
export const CHECKPOINT_VERSION = 1;

export interface CaptureCheckpointMeta {
  checkpointVersion: number;
  archiveId: string;
  appVersion: string;
  startUrl: string;
  outputPath: string;
  scope: CaptureScope;
  startedAt: string;
}

export type JournalRecord =
  | { t: 'page'; e: ArchivedPageEntry }
  | { t: 'asset'; e: ArchivedAssetEntry }
  /** A dedupe hit on an existing asset, adding one more source URL. */
  | { t: 'assetUrl'; sha: string; url: string }
  | { t: 'response'; e: ArchivedResponseEntry }
  | { t: 'route'; e: RouteMapEntry }
  | { t: 'forumPost'; e: ForumPostEntry }
  | { t: 'failure'; e: CaptureFailureEntry }
  /** A URL admitted to the crawl queue. */
  | { t: 'enq'; url: string; norm: string; depth: number; on: string | null }
  /** That URL taken off the queue for capture. */
  | { t: 'deq'; norm: string }
  /** Running crawl counters, appended once per completed page. */
  | { t: 'stat'; bytesDownloaded: number; warnings: number; total: number; title: string };

export interface ReplayedQueueItem {
  url: string;
  depth: number;
  discoveredOn: string | null;
}

export interface ReplayedCheckpoint {
  meta: CaptureCheckpointMeta;
  pages: ArchivedPageEntry[];
  assets: Map<string, ArchivedAssetEntry>;
  responses: Map<string, ArchivedResponseEntry>;
  routes: Map<string, RouteMapEntry>;
  forumPosts: ForumPostEntry[];
  failures: CaptureFailureEntry[];
  queue: ReplayedQueueItem[];
  queuedOrDone: Set<string>;
  pagesDiscovered: number;
  pagesCompleted: number;
  bytesDownloaded: number;
  warningCount: number;
  siteTitle: string;
  totalUncompressed: number;
  /** Records that could not be parsed -- expected to be 0 or 1 (see below). */
  malformedLines: number;
}

/**
 * Append-only writer. One JSON object per line.
 *
 * Writes are awaited rather than fired into a stream buffer: the whole
 * point is to survive the process being killed, and buffered records that
 * never reached the OS would be exactly the ones describing the most
 * recent work. The volume is modest -- roughly 30,000 records across a
 * 151-minute crawl -- so the cost is irrelevant next to rendering pages.
 */
export class CaptureJournal {
  private handle: fs.FileHandle | null = null;

  private constructor(readonly stagingDir: string) {}

  /** Start a new journal, writing the metadata sidecar first. */
  static async create(stagingDir: string, meta: Omit<CaptureCheckpointMeta, 'checkpointVersion'>): Promise<CaptureJournal> {
    const journal = new CaptureJournal(stagingDir);
    const full: CaptureCheckpointMeta = { checkpointVersion: CHECKPOINT_VERSION, ...meta };
    await fs.writeFile(path.join(stagingDir, CHECKPOINT_META_FILE), JSON.stringify(full, null, 2), 'utf8');
    journal.handle = await fs.open(path.join(stagingDir, CHECKPOINT_JOURNAL_FILE), 'a');
    await journal.writeLock();
    return journal;
  }

  /** Reopen an existing journal to append to it, for a resumed capture. */
  static async reopen(stagingDir: string): Promise<CaptureJournal> {
    const journal = new CaptureJournal(stagingDir);
    journal.handle = await fs.open(path.join(stagingDir, CHECKPOINT_JOURNAL_FILE), 'a');
    await journal.writeLock();
    return journal;
  }

  /**
   * Best-effort: a lock we fail to write just means `isStagingDirLive`
   * can't protect this capture from a concurrent recovery elsewhere,
   * which is the same (pre-existing) exposure every staging dir already
   * had before this lock existed -- not worth aborting the capture over.
   */
  private async writeLock(): Promise<void> {
    try {
      await fs.writeFile(
        path.join(this.stagingDir, CHECKPOINT_LOCK_FILE),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch (err) {
      logger.warn('sitearchive.journal_lock_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async append(record: JournalRecord): Promise<void> {
    if (!this.handle) return;
    try {
      await this.handle.write(`${JSON.stringify(record)}\n`);
    } catch (err) {
      // A failed journal write must never abort a capture that is
      // otherwise working -- it costs recoverability, not the crawl.
      logger.warn('sitearchive.journal_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
    await fs.rm(path.join(this.stagingDir, CHECKPOINT_LOCK_FILE), { force: true }).catch(() => undefined);
  }
}

/**
 * Whether the pid named in a staging dir's lock file is still running.
 *
 * Used to tell a capture that is genuinely still being written to --
 * possibly by another app instance sharing this OS temp directory -- apart
 * from one whose process died without closing its journal. A missing or
 * unreadable lock is treated as "not live": either no capture has ever run
 * here, or one shut down cleanly and removed it.
 */
export async function isStagingDirLive(stagingDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stagingDir, CHECKPOINT_LOCK_FILE), 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.pid !== 'number') return false;
    return isProcessAlive(parsed.pid);
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the pid exists and is
    // reachable, which is the standard cross-platform liveness check.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else -- still
    // alive, just not ours to signal. Anything else (ESRCH, etc.) means no
    // such process.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read a staging directory's metadata sidecar, if it has a usable one. */
export async function readCheckpointMeta(stagingDir: string): Promise<CaptureCheckpointMeta | null> {
  try {
    const raw = await fs.readFile(path.join(stagingDir, CHECKPOINT_META_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.checkpointVersion !== CHECKPOINT_VERSION) return null;
    if (typeof parsed.archiveId !== 'string' || typeof parsed.outputPath !== 'string') return null;
    if (typeof parsed.startUrl !== 'string' || !isRecord(parsed.scope)) return null;
    return parsed as unknown as CaptureCheckpointMeta;
  } catch {
    return null;
  }
}

/**
 * Rebuild capture state from a staging directory's journal.
 *
 * Returns null when the directory has no usable checkpoint at all (an
 * older capture from before journalling, or a corrupt sidecar).
 */
export async function replayCheckpoint(stagingDir: string): Promise<ReplayedCheckpoint | null> {
  const meta = await readCheckpointMeta(stagingDir);
  if (!meta) return null;

  let raw: string;
  try {
    raw = await fs.readFile(path.join(stagingDir, CHECKPOINT_JOURNAL_FILE), 'utf8');
  } catch {
    raw = '';
  }

  const state: ReplayedCheckpoint = {
    meta,
    pages: [],
    assets: new Map(),
    responses: new Map(),
    routes: new Map(),
    forumPosts: [],
    failures: [],
    queue: [],
    queuedOrDone: new Set(),
    pagesDiscovered: 0,
    pagesCompleted: 0,
    bytesDownloaded: 0,
    warningCount: 0,
    siteTitle: '',
    totalUncompressed: 0,
    malformedLines: 0,
  };

  // Queue reconstruction: every URL is enqueued at most once (the crawler
  // guards on queuedOrDone), so "enqueued and not yet dequeued", in
  // enqueue order, is an exact reconstruction of the pending queue.
  const enqueued: ReplayedQueueItem[] = [];
  const enqueuedNorms: string[] = [];
  const dequeued = new Set<string>();
  // A dequeued URL is "resolved" once a 'page' or 'failure' record names
  // it -- capturePageSafely always appends exactly one of those once it
  // finishes, however the attempt turned out. A URL that is dequeued but
  // never resolved is the one that was actually in flight when the
  // process died.
  const resolved = new Set<string>();

  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let record: JournalRecord;
    try {
      record = JSON.parse(line) as JournalRecord;
    } catch {
      // Only the final line can be truncated -- a killed process cuts the
      // append mid-write. Anything else would mean real corruption, which
      // we still tolerate by skipping rather than losing the whole crawl.
      state.malformedLines += 1;
      continue;
    }
    applyRecord(state, record, enqueued, enqueuedNorms, dequeued, resolved);
  }

  for (let i = 0; i < enqueued.length; i += 1) {
    const norm = enqueuedNorms[i]!;
    if (!dequeued.has(norm)) {
      state.queue.push(enqueued[i]!);
    } else if (!resolved.has(norm)) {
      // Taken off the queue for capture, and then the process died before
      // recording any outcome for it. Without this it simply vanishes --
      // not in pages, not in failures, not in the resumed queue -- from
      // both a finalized partial archive and a resumed crawl. Deliberately
      // not re-queued: this is also the page most likely to have caused
      // the death (see the 'deq' comment in crawler.ts).
      const item = enqueued[i]!;
      state.failures.push({
        url: item.url,
        kind: 'interrupted',
        message: 'Capture was interrupted while this page was being captured.',
        discoveredOn: item.discoveredOn,
      });
    }
  }

  if (state.malformedLines > 0) {
    logger.warn('sitearchive.journal_malformed_lines', {
      count: state.malformedLines,
      archiveId: meta.archiveId,
    });
  }

  return state;
}

function applyRecord(
  state: ReplayedCheckpoint,
  record: JournalRecord,
  enqueued: ReplayedQueueItem[],
  enqueuedNorms: string[],
  dequeued: Set<string>,
  resolved: Set<string>,
): void {
  switch (record.t) {
    case 'page':
      state.pages.push(record.e);
      state.pagesCompleted += 1;
      // originalUrl (pre-redirect) is what was actually dequeued, so it
      // normalizes to the same value as the 'deq' record even when the
      // page itself redirected somewhere else.
      resolved.add(normalizeUrl(record.e.originalUrl) ?? record.e.originalUrl);
      break;
    case 'asset':
      state.assets.set(record.e.sha256, record.e);
      break;
    case 'assetUrl': {
      const asset = state.assets.get(record.sha);
      if (asset && !asset.sourceUrls.includes(record.url)) asset.sourceUrls.push(record.url);
      break;
    }
    case 'response':
      state.responses.set(record.e.sha256, record.e);
      break;
    case 'route':
      state.routes.set(record.e.normalizedUrl, record.e);
      break;
    case 'forumPost':
      state.forumPosts.push(record.e);
      break;
    case 'failure':
      state.failures.push(record.e);
      resolved.add(normalizeUrl(record.e.url) ?? record.e.url);
      break;
    case 'enq':
      enqueued.push({ url: record.url, depth: record.depth, discoveredOn: record.on });
      enqueuedNorms.push(record.norm);
      state.queuedOrDone.add(record.norm);
      state.pagesDiscovered += 1;
      break;
    case 'deq':
      dequeued.add(record.norm);
      break;
    case 'stat':
      state.bytesDownloaded = record.bytesDownloaded;
      state.warningCount = record.warnings;
      state.totalUncompressed = record.total;
      if (record.title) state.siteTitle = record.title;
      break;
    default:
      // An unknown record type from a future version: ignore it rather
      // than discarding an otherwise-replayable crawl.
      break;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
