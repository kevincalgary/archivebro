// Forum-specific link classification: pagination, attachments, avatars,
// print/alternate views, and thread/section identity.
//
// These are heuristics layered on top of the generic crawler-trap/
// non-content predicates in urlNormalize.ts, not a replacement for them --
// a link is still checked against those first. Everything here is pure and
// Electron-free so it can be unit-tested directly, matching urlNormalize.ts.

import { DOCUMENT_EXTENSIONS, extensionOf } from './urlNormalize';

/** Path/query shapes that identify "page N of the same listing/thread". */
const PAGINATION_PATH_RE = /\/page\/(\d+)(\/|$)/i;
const PAGINATION_PARAM_RE = /\b(page|pg|p)=(\d+)\b/i;
const PAGINATION_OFFSET_RE = /\b(start|offset)=(\d+)\b/i;
/** Link text alone can also signal pagination even when the URL shape doesn't. */
const PAGINATION_TEXT_RE = /^(next|prev(ious)?|»|«|›|‹|»|«|\d{1,4})$/i;

/**
 * Whether a link looks like it navigates to another page of the *same*
 * logical listing or thread (not a different one). Checked before the
 * generic crawler-trap heuristic so a legitimate `?page=47` on a long
 * thread is never mistaken for a generated URL permutation.
 */
export function looksLikeForumPagination(rawUrl: string, linkText?: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (PAGINATION_PATH_RE.test(u.pathname)) return true;
    if (PAGINATION_PARAM_RE.test(u.search)) return true;
    if (PAGINATION_OFFSET_RE.test(u.search)) return true;
  } catch {
    return false;
  }
  if (linkText && PAGINATION_TEXT_RE.test(linkText.trim())) return true;
  return false;
}

const ATTACHMENT_PATH_RE = /\/(attachments?|download|files?)\//i;
const ATTACHMENT_PARAM_RE = /\b(attachmentid|attach|fileid|downloadid)=/i;

/**
 * Whether a link points at a downloadable file rather than a browsable
 * page -- either by extension, or by the path/query shapes forum software
 * commonly uses for attachment downloads that carry no file extension at
 * all (e.g. `attachment.php?attachmentid=7`).
 */
export function looksLikeAttachment(rawUrl: string): boolean {
  if (DOCUMENT_EXTENSIONS.has(extensionOf(rawUrl))) return true;
  try {
    const u = new URL(rawUrl);
    return ATTACHMENT_PATH_RE.test(u.pathname) || ATTACHMENT_PARAM_RE.test(u.search);
  } catch {
    return false;
  }
}

const AVATAR_EMOJI_RE = /\/(avatars?|customavatars|emoji|emoticons?|smilies|smileys)\//i;

/** Whether a resource URL looks like a user avatar or an emoji/smilie image, used to keep these in scope for fetching even under a narrow forum scope. */
export function looksLikeAvatarOrEmoji(rawUrl: string): boolean {
  try {
    return AVATAR_EMOJI_RE.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

const PRINT_VIEW_PARAM_RE = /\b(mode|view|do)=print\b/i;
const PRINT_VIEW_PATH_RE = /\/(print|printthread|printpage)(\/|\.|$)/i;

/**
 * Whether a link is a print/plain-alternate view of a page that's already
 * reachable in its normal form. These are never crawled -- they duplicate
 * content the ordinary page link already covers, at a different URL that
 * URL-normalization alone wouldn't collapse.
 */
export function looksLikePrintOrAlternateView(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return PRINT_VIEW_PARAM_RE.test(u.search) || PRINT_VIEW_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * A stable identity for "the same thread" that collapses pagination:
 * strips `/page/N` path segments and `page=`/`pg=`/`p=`/`start=`/`offset=`
 * query params, leaving everything else (including other query params
 * that genuinely select different content, e.g. `?t=123`) intact.
 *
 * Takes an already-normalized URL (see urlNormalize.normalizeUrl) so
 * ordering/tracking-param differences don't produce spurious distinct keys.
 */
export function threadKeyOf(normalizedUrl: string): string {
  return stripPaginationFromUrl(normalizedUrl);
}

/** Same idea as threadKeyOf, for a forum section/subforum listing. */
export function sectionKeyOf(normalizedUrl: string): string {
  return stripPaginationFromUrl(normalizedUrl);
}

function stripPaginationFromUrl(normalizedUrl: string): string {
  let u: URL;
  try {
    u = new URL(normalizedUrl);
  } catch {
    return normalizedUrl;
  }
  u.pathname = u.pathname.replace(/\/page\/\d+(\/|$)/i, '$1').replace(/\/+$/, '') || '/';
  const kept = [...u.searchParams.entries()].filter(
    ([k]) => !/^(page|pg|p|start|offset)$/i.test(k),
  );
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}
