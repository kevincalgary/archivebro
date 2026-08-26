// Best-effort forum post detection, run only for pages captured under a
// forum-* scope. Same raw-JS-string / executeJavaScript convention as
// pageScript.ts, deliberately kept separate so it never runs (and never
// costs anything) for an ordinary page or site capture.
//
// Detection targets the id="post-<n>" / id="post_<n>" convention used by
// vBulletin, XenForo and phpBB alike -- which covers the overwhelming
// majority of real forum software, including this feature's own
// real-world test target. A page with no matching elements yields an
// empty result: the page still gets ordinary whole-page text indexing,
// it just doesn't get post-level search granularity. This is a heuristic,
// not a parser for any specific forum software, and is expected to miss
// on unusual markup -- see README Known Limitations.
//
// Real-world wrinkles found capturing a live XenForo ("California" theme)
// forum, in the order they mattered:
//  1. The id="post-<n>" element is often an empty marker span, not the
//     post's actual content wrapper -- the real container is an ancestor
//     a few levels up (resolveContainer).
//  2. Many modern forum themes emit schema.org Comment/Person microdata
//     (itemprop="author"/"datePublished"/"position"/"text") for SEO. When
//     present, it's a far more reliable signal than guessing from class
//     names or link position -- e.g. an avatar image and a visible
//     username can be two separate links to the same profile URL, and
//     only one of them has readable text. Microdata is tried first;
//     class-name/link heuristics remain as a fallback for forums that
//     don't emit it.
//  3. A thread's own "last post by X" summary can appear structurally
//     close to (even inside the same <header> as) each post's own
//     author block on some themes, so a naive first-match query risks
//     attributing every post to whoever posted last in the whole thread.
//     Microdata scoping (querying inside the specific itemprop="author"
//     element) avoids this by construction; the link-based fallback
//     prefers a same-scope match with visible text as a weaker version
//     of the same idea.

/** Evaluates to an array of { anchor, author, authorProfileUrl, timestamp, postNumber, text }. */
export const DETECT_FORUM_POSTS_SCRIPT = `
(function () {
  function textOf(el) { return el ? (el.textContent || '').trim() : ''; }
  function metaOrText(el) {
    if (!el) return null;
    var v = el.tagName === 'META' ? el.getAttribute('content') : textOf(el);
    return v ? v : null;
  }

  var POST_ID_RE = /^post[-_]?(\\d+)$/i;
  /** Below this, an anchor element is treated as a marker rather than the post's own content wrapper. */
  var MIN_CONTENT_CHARS = 40;
  /** How far up from a near-empty anchor to look for its real content container. */
  var MAX_ANCESTOR_HOPS = 8;

  function findPostAnchors() {
    var candidates = document.querySelectorAll('[id]');
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i].id;
      if (POST_ID_RE.test(id)) out.push(candidates[i]);
    }
    return out;
  }

  /**
   * Resolves the element that actually holds a post's content, starting
   * from its id="post-<n>" anchor. If the anchor itself already has
   * substantial text, it IS the container (the common case). Otherwise
   * walks up looking for an ancestor that both looks post-shaped (by
   * class name) and has real content; falls back to the first ancestor
   * with enough text, then to the anchor itself if nothing qualifies.
   */
  function resolveContainer(anchorEl) {
    if (textOf(anchorEl).length >= MIN_CONTENT_CHARS) return anchorEl;

    var node = anchorEl.parentElement;
    var hops = 0;
    var fallback = null;
    while (node && hops < MAX_ANCESTOR_HOPS) {
      var text = textOf(node);
      if (text.length >= MIN_CONTENT_CHARS) {
        if (!fallback) fallback = node;
        if (/message|post|card/i.test(node.className || '')) return node;
      }
      node = node.parentElement;
      hops++;
    }
    return fallback || anchorEl;
  }

  /** schema.org Comment microdata, when the theme emits it -- see the file header comment. */
  function findAuthorViaMicrodata(container) {
    var authorEl = container.querySelector('[itemprop="author"]');
    if (!authorEl) return null;
    var name = metaOrText(authorEl.querySelector('[itemprop="name"]'));
    var urlEl = authorEl.querySelector('[itemprop="url"]');
    var url = urlEl ? urlEl.getAttribute('href') || metaOrText(urlEl) : null;
    if (!name && !url) return null;
    return { name: name, profileUrl: url };
  }

  function findTimestampViaMicrodata(container) {
    return metaOrText(container.querySelector('[itemprop="datePublished"]'));
  }

  function findPostNumberViaMicrodata(container) {
    var el = container.querySelector('[itemprop="position"]');
    var v = metaOrText(el);
    var n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) ? null : n;
  }

  /** True if el is inside a <header> that is itself inside root. */
  function isInsideHeader(el, root) {
    var node = el;
    while (node && node !== root) {
      if (node.tagName === 'HEADER') return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Fallback for forums with no schema.org microdata: like
   * container.querySelector(selector), but among matches prefers one
   * outside a <header> with visible text, then any with visible text,
   * then whatever's left -- an avatar image wrapped in the same profile
   * link as the visible username is common, and would otherwise win by
   * DOM order and report an empty name.
   */
  function queryPreferred(container, selector) {
    var all = container.querySelectorAll(selector);
    var bestOutside = null;
    var bestWithText = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var outside = !isInsideHeader(el, container);
      var hasText = textOf(el).length > 0;
      if (outside && hasText) return el;
      if (outside && !bestOutside) bestOutside = el;
      if (hasText && !bestWithText) bestWithText = el;
    }
    return bestOutside || bestWithText || (all.length > 0 ? all[0] : null);
  }

  function findAuthor(container) {
    var viaMicrodata = findAuthorViaMicrodata(container);
    if (viaMicrodata) return viaMicrodata;

    var profileLink = queryPreferred(
      container,
      'a[href*="/members/"], a[href*="/member/"], a[href*="/user/"], a[href*="/profile/"], .username a, .author a, .postauthor a'
    );
    if (profileLink) {
      return { name: textOf(profileLink) || null, profileUrl: profileLink.getAttribute('href') || null };
    }
    var nameEl = queryPreferred(container, '.username, .author, .postauthor');
    if (nameEl) return { name: textOf(nameEl) || null, profileUrl: null };
    return { name: null, profileUrl: null };
  }

  function findTimestamp(container) {
    var viaMicrodata = findTimestampViaMicrodata(container);
    if (viaMicrodata) return viaMicrodata;

    var timeEl = queryPreferred(container, 'time[datetime]');
    if (timeEl) return timeEl.getAttribute('datetime');
    var timeElNoAttr = queryPreferred(container, 'time');
    if (timeElNoAttr) return textOf(timeElNoAttr) || null;
    return null;
  }

  function findPostNumber(container, fallbackIndex) {
    var viaMicrodata = findPostNumberViaMicrodata(container);
    if (viaMicrodata !== null) return viaMicrodata;

    var numEl = queryPreferred(container, 'a[href*="#post"], .post-number, .postcount, .message-number');
    var text = numEl ? textOf(numEl) : '';
    var m = /#?(\\d{1,7})/.exec(text);
    if (m) return parseInt(m[1], 10);
    return fallbackIndex + 1;
  }

  function findBody(container) {
    var bodyEl = container.querySelector('[itemprop="text"], .postcontent, .post-content, .message-body, .messageText, article');
    var clone = (bodyEl || container).cloneNode(true);
    var strip = clone.querySelectorAll('script, style, input, textarea, select, header, .signature, .quote, blockquote');
    for (var i = 0; i < strip.length; i++) strip[i].parentNode && strip[i].parentNode.removeChild(strip[i]);
    return (clone.innerText || clone.textContent || '').trim().slice(0, 20000);
  }

  var anchors = findPostAnchors();
  var out = [];
  for (var i = 0; i < anchors.length; i++) {
    var anchorEl = anchors[i];
    var container = resolveContainer(anchorEl);
    var author = findAuthor(container);
    out.push({
      anchor: anchorEl.id,
      author: author.name,
      authorProfileUrl: author.profileUrl,
      timestamp: findTimestamp(container),
      postNumber: findPostNumber(container, i),
      text: findBody(container)
    });
  }
  return out;
})()
`;
