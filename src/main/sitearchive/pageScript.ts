// Scripts executed inside the page being captured, via
// webContents.executeJavaScript. These run in the page's own world, but
// nothing is injected the other direction -- the page gains no capability
// from this, and no preload/contextBridge is involved.
//
// Each export is a self-contained IIFE string so it can be evaluated
// without any bundler cooperation.

/**
 * Scroll the full height of the page in steps to trigger lazy-loading
 * (IntersectionObserver / loading="lazy" / scroll listeners), then restore
 * the user's original scroll position. Returns the original position so
 * the caller can assert it was restored.
 */
export const LAZY_LOAD_SWEEP_SCRIPT = `
(async function () {
  var originalX = window.scrollX, originalY = window.scrollY;
  try {
    var step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    var maxScroll = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    // Bound the sweep so an infinite-scroll page cannot loop forever.
    var maxSteps = 40;
    var steps = 0;
    for (var y = 0; y <= maxScroll && steps < maxSteps; y += step) {
      window.scrollTo(0, y);
      steps++;
      await new Promise(function (r) { setTimeout(r, 60); });
    }
    // Give any triggered loads a moment to start/settle.
    await new Promise(function (r) { setTimeout(r, 250); });
  } catch (e) {
    // Never let a lazy-load sweep break the capture.
  } finally {
    window.scrollTo(originalX, originalY);
  }
  return { originalX: originalX, originalY: originalY, restoredX: window.scrollX, restoredY: window.scrollY };
})()
`;

/** Restore a specific scroll position (used after element screenshots). */
export function restoreScrollScript(x: number, y: number): string {
  return `(function(){ window.scrollTo(${Math.round(x)}, ${Math.round(y)}); return [window.scrollX, window.scrollY]; })()`;
}

export const GET_SCROLL_SCRIPT = `(function(){ return { x: window.scrollX, y: window.scrollY }; })()`;

/**
 * Collect every resource URL the rendered page depends on, plus the list
 * of links for crawling, plus image elements that may need the screenshot
 * fallback. Returns plain JSON-serializable data.
 */
export const COLLECT_RESOURCES_SCRIPT = `
(function () {
  function abs(u) {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch (e) { return null; }
  }

  var resources = [];
  function push(url, kind, note) {
    var a = abs(url);
    if (!a) return;
    if (a.indexOf('data:') === 0 || a.indexOf('blob:') === 0 || a.indexOf('about:') === 0) return;
    if (a.indexOf('http:') !== 0 && a.indexOf('https:') !== 0) return;
    resources.push({ url: a, kind: kind, note: note || null });
  }

  // Stylesheets
  var links = document.querySelectorAll('link[rel~="stylesheet"], link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="preload"][as="font"], link[rel~="manifest"]');
  for (var i = 0; i < links.length; i++) {
    var rel = (links[i].getAttribute('rel') || '').toLowerCase();
    var kind = rel.indexOf('stylesheet') >= 0 ? 'stylesheet' : (rel.indexOf('icon') >= 0 ? 'image' : 'other');
    push(links[i].getAttribute('href'), kind, rel);
  }

  // Images, including srcset candidates and <picture> sources
  var imgs = document.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    push(img.getAttribute('src'), 'image');
    // currentSrc is what the browser actually picked for this viewport.
    if (img.currentSrc) push(img.currentSrc, 'image');
    var ss = img.getAttribute('srcset');
    if (ss) {
      ss.split(',').forEach(function (part) {
        var u = part.trim().split(/\\s+/)[0];
        push(u, 'image');
      });
    }
  }
  var sources = document.querySelectorAll('picture source, video source, audio source');
  for (var i = 0; i < sources.length; i++) {
    push(sources[i].getAttribute('src'), 'media');
    var ss2 = sources[i].getAttribute('srcset');
    if (ss2) {
      ss2.split(',').forEach(function (part) {
        push(part.trim().split(/\\s+/)[0], 'image');
      });
    }
  }

  // Video poster images
  var videos = document.querySelectorAll('video[poster]');
  for (var i = 0; i < videos.length; i++) push(videos[i].getAttribute('poster'), 'image', 'poster');

  // Same-origin frames
  var frames = document.querySelectorAll('iframe[src], frame[src]');
  for (var i = 0; i < frames.length; i++) push(frames[i].getAttribute('src'), 'frame');

  // Scripts (only same-origin ones are useful offline)
  var scripts = document.querySelectorAll('script[src]');
  for (var i = 0; i < scripts.length; i++) push(scripts[i].getAttribute('src'), 'script');

  // CSS background images from computed styles, plus SVG use/image refs
  try {
    var all = document.querySelectorAll('*');
    var limit = Math.min(all.length, 5000);
    for (var i = 0; i < limit; i++) {
      var cs = window.getComputedStyle(all[i]);
      var props = ['backgroundImage', 'borderImageSource', 'listStyleImage', 'maskImage'];
      for (var p = 0; p < props.length; p++) {
        var v = cs[props[p]];
        if (v && v !== 'none') {
          var re = /url\\((['"]?)(.*?)\\1\\)/g, m;
          while ((m = re.exec(v)) !== null) push(m[2], 'image', 'css-background');
        }
      }
    }
  } catch (e) {}

  // Links for crawling. Anchors that look like a file download (an
  // explicit [download] attribute, or a URL shaped like an attachment --
  // a document extension, or a common attachment path/query convention
  // used by forum software that serves files with no extension at all,
  // e.g. attachment.php?attachmentid=7) are ALSO pushed into resources
  // below, so the existing subresource-fetch pipeline downloads their
  // bytes as an asset. They stay in linksOut too so the crawler can
  // recognize and skip them as pages rather than re-fetching HTML.
  var ATTACHMENT_EXT_RE = /\\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|txt|zip)$/i;
  var ATTACHMENT_PATH_RE = /\\/(attachments?|download|files?)\\//i;
  var ATTACHMENT_PARAM_RE = /\\b(attachmentid|attach|fileid|downloadid)=/i;
  function looksLikeAttachmentHref(u) {
    try {
      var parsed = new URL(u);
      return ATTACHMENT_EXT_RE.test(parsed.pathname) || ATTACHMENT_PATH_RE.test(parsed.pathname) || ATTACHMENT_PARAM_RE.test(parsed.search);
    } catch (e) {
      return false;
    }
  }

  var anchors = document.querySelectorAll('a[href]');
  var linksOut = [];
  for (var i = 0; i < anchors.length; i++) {
    var href = anchors[i].getAttribute('href');
    if (!href) continue;
    var a = abs(href);
    if (!a) continue;
    var insideForm = !!anchors[i].closest('form');
    var rel = (anchors[i].getAttribute('rel') || '').toLowerCase();
    var isDownload = anchors[i].hasAttribute('download');
    linksOut.push({
      url: a,
      text: (anchors[i].textContent || '').trim().slice(0, 200),
      rel: rel,
      insideForm: insideForm,
      download: isDownload
    });
    if (!insideForm && (isDownload || looksLikeAttachmentHref(a))) {
      push(a, 'attachment', isDownload ? 'download-link' : 'attachment-link');
    }
  }

  return {
    baseUrl: document.baseURI,
    title: document.title || '',
    resources: resources,
    links: linksOut
  };
})()
`;

/**
 * Serialize the current rendered DOM to HTML, with sensitive data removed
 * and every external resource reference rewritten to the archive scheme.
 *
 * `urlMapJson` maps absolute original URL -> archive-relative path.
 * Anything not in the map is left as-is and will simply fail to resolve
 * offline (the viewer serves a clearly-marked placeholder instead of
 * reaching the network).
 */
export function serializeDomScript(urlMapJson: string, archiveOrigin: string): string {
  return `
(function () {
  var URL_MAP = ${urlMapJson};
  var ARCHIVE_ORIGIN = ${JSON.stringify(archiveOrigin)};

  function abs(u) {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch (e) { return null; }
  }
  function mapped(u) {
    var a = abs(u);
    if (!a) return null;
    var m = URL_MAP[a];
    return m ? (ARCHIVE_ORIGIN + '/' + m) : null;
  }

  // Stamp every element we will need to pair up with its clone. Index
  // -based pairing is not safe here: replacing a <canvas> with an <img>
  // changes the clone's element list, which would silently misalign every
  // element after it. A uid survives cloning and cannot drift.
  var UID_ATTR = 'data-archive-uid';
  var uidCounter = 0;
  var pairable = document.querySelectorAll('img, canvas, input, textarea, select');
  for (var u = 0; u < pairable.length; u++) {
    pairable[u].setAttribute(UID_ATTR, 'u' + (uidCounter++));
  }

  var doc = document.documentElement.cloneNode(true);

  function liveByUid(uid) { return document.querySelector('[' + UID_ATTR + '="' + uid + '"]'); }
  function cloneByUid(uid) { return doc.querySelector('[' + UID_ATTR + '="' + uid + '"]'); }

  // --- Strip sensitive data before anything else touches this tree ---

  // Password fields: never persist a value, and never leave the value
  // attribute behind either.
  var pwd = doc.querySelectorAll('input[type="password"]');
  for (var i = 0; i < pwd.length; i++) {
    pwd[i].removeAttribute('value');
    pwd[i].setAttribute('value', '');
    pwd[i].setAttribute('data-archive-cleared', 'password');
  }

  // Fields that commonly hold credentials/payment data even when not
  // type=password, identified by autocomplete/name/type hints.
  var SENSITIVE_RE = /(pass|passwd|pwd|secret|token|api[-_]?key|auth|session|credit|card|cvv|cvc|iban|ssn|social|routing|account[-_]?number|otp|2fa|mfa|security[-_]?code)/i;
  var inputs = doc.querySelectorAll('input, textarea, select');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var name = (el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '') + ' ' + (el.getAttribute('autocomplete') || '');
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (SENSITIVE_RE.test(name) || type === 'password' || /^cc-|^new-password|^current-password/.test((el.getAttribute('autocomplete') || '').toLowerCase())) {
      el.removeAttribute('value');
      el.setAttribute('value', '');
      if (el.tagName === 'TEXTAREA') el.textContent = '';
      el.setAttribute('data-archive-cleared', 'sensitive');
    }
  }

  // Hidden inputs frequently carry CSRF tokens / session identifiers.
  var hidden = doc.querySelectorAll('input[type="hidden"]');
  for (var i = 0; i < hidden.length; i++) {
    hidden[i].setAttribute('value', '');
    hidden[i].setAttribute('data-archive-cleared', 'hidden');
  }

  // --- Preserve the CURRENT values of non-sensitive controls ---
  // A cloned node does not carry live user input, so copy it across from
  // the live tree by index, skipping anything cleared above.
  try {
    var liveInputs = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < liveInputs.length; i++) {
      var live = liveInputs[i];
      var cl = cloneByUid(live.getAttribute(UID_ATTR));
      if (!cl) continue;
      if (cl.getAttribute('data-archive-cleared')) continue;
      var t = (live.getAttribute('type') || '').toLowerCase();
      if (live.tagName === 'SELECT') {
        var opts = cl.querySelectorAll('option');
        for (var o = 0; o < opts.length; o++) {
          if (live.options[o] && live.options[o].selected) opts[o].setAttribute('selected', 'selected');
          else opts[o].removeAttribute('selected');
        }
      } else if (t === 'checkbox' || t === 'radio') {
        if (live.checked) cl.setAttribute('checked', 'checked'); else cl.removeAttribute('checked');
      } else if (live.tagName === 'TEXTAREA') {
        cl.textContent = live.value || '';
      } else if (t !== 'file' && t !== 'password') {
        cl.setAttribute('value', live.value == null ? '' : String(live.value));
      }
    }
  } catch (e) {}

  // --- Canvas: replace with its rendered pixels ---
  // A cloned <canvas> is blank, so serialize the live one to a data URL
  // and swap in an <img>. Tainted canvases throw -- those fall back to the
  // element-screenshot path handled by the main process.
  var canvasFallbacks = [];
  try {
    var liveCanvases = document.querySelectorAll('canvas');
    for (var i = 0; i < liveCanvases.length; i++) {
      var lc = liveCanvases[i];
      var cc = cloneByUid(lc.getAttribute(UID_ATTR));
      if (!cc) continue;
      var rect = lc.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var dataUrl = null;
      try { dataUrl = lc.toDataURL('image/png'); } catch (e) { dataUrl = null; }
      if (dataUrl && dataUrl.length > 128) {
        var img = doc.ownerDocument.createElement('img');
        img.setAttribute('src', dataUrl);
        img.setAttribute('width', String(Math.round(rect.width)));
        img.setAttribute('height', String(Math.round(rect.height)));
        img.setAttribute('data-archive-from', 'canvas');
        if (cc.parentNode) cc.parentNode.replaceChild(img, cc);
      } else {
        // Mark it so the main process can screenshot the live element.
        var marker = 'archive-canvas-' + i;
        cc.setAttribute('data-archive-needs-screenshot', marker);
        lc.setAttribute('data-archive-needs-screenshot', marker);
        canvasFallbacks.push({ marker: marker, index: i, width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    }
  } catch (e) {}

  // --- Rewrite resource references to the archive ---
  function rewriteAttr(nodes, attr) {
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i].getAttribute(attr);
      if (!v) continue;
      var m = mapped(v);
      if (m) {
        nodes[i].setAttribute('data-archive-original-' + attr, abs(v) || v);
        nodes[i].setAttribute(attr, m);
      }
    }
  }

  rewriteAttr(doc.querySelectorAll('link[href]'), 'href');
  rewriteAttr(doc.querySelectorAll('script[src]'), 'src');
  rewriteAttr(doc.querySelectorAll('video[poster]'), 'poster');
  rewriteAttr(doc.querySelectorAll('source[src]'), 'src');
  rewriteAttr(doc.querySelectorAll('iframe[src], frame[src]'), 'src');

  // --- Cross-origin frames ---
  // A same-origin frame's content is reachable and gets archived like any
  // other resource. A cross-origin one cannot be read or safely archived,
  // so leaving it pointing at the live web would either fail silently or
  // (worse) look like it should work. Replace it with a clearly marked
  // placeholder that says what was there, so the gap is visible and
  // honest rather than a mysterious blank box.
  try {
    var liveFrames = document.querySelectorAll('iframe[src], frame[src]');
    for (var i = 0; i < liveFrames.length; i++) {
      var lf = liveFrames[i];
      var srcAttr = lf.getAttribute('src') || '';
      var absSrc = abs(srcAttr);
      if (!absSrc) continue;

      var sameOrigin = false;
      try { sameOrigin = new URL(absSrc).origin === location.origin; } catch (e) { sameOrigin = false; }
      if (sameOrigin) continue;
      // Already rewritten into the archive (its content was captured).
      if (URL_MAP[absSrc]) continue;

      var cf = cloneByUid(lf.getAttribute(UID_ATTR));
      // Frames aren't in the uid set, so fall back to matching by src.
      if (!cf) {
        var candidates = doc.querySelectorAll('iframe, frame');
        for (var c = 0; c < candidates.length; c++) {
          var candSrc = candidates[c].getAttribute('data-archive-original-src') || candidates[c].getAttribute('src');
          if (candSrc && (candSrc === srcAttr || abs(candSrc) === absSrc)) { cf = candidates[c]; break; }
        }
      }
      if (!cf || !cf.parentNode) continue;

      var rect = lf.getBoundingClientRect();
      var ph = doc.ownerDocument.createElement('div');
      var host = '';
      try { host = new URL(absSrc).host; } catch (e) { host = 'another site'; }
      ph.setAttribute('data-archive-placeholder', 'cross-origin-frame');
      ph.setAttribute('data-archive-original-src', absSrc);
      ph.setAttribute(
        'style',
        'display:flex;align-items:center;justify-content:center;text-align:center;' +
          'box-sizing:border-box;padding:12px;border:1px dashed #999;border-radius:4px;' +
          'background:#f4f4f4;color:#666;font:12px/1.5 sans-serif;' +
          'width:' + (rect.width > 0 ? Math.round(rect.width) + 'px' : '100%') + ';' +
          'height:' + (rect.height > 0 ? Math.round(rect.height) + 'px' : '150px') + ';'
      );
      ph.textContent = 'Embedded content from ' + host + ' was not archived (it belongs to another site).';
      cf.parentNode.replaceChild(ph, cf);
    }
  } catch (e) {}

  // Images: prefer the resolved currentSrc the browser actually used.
  // Paired by uid, so the <img> elements substituted in for canvases
  // above cannot shift this alignment.
  var liveImgs = document.querySelectorAll('img');
  for (var i = 0; i < liveImgs.length; i++) {
    var li = liveImgs[i];
    var ci = cloneByUid(li.getAttribute(UID_ATTR));
    if (!ci) continue;
    if (ci.getAttribute('data-archive-from') === 'canvas') continue;
    var candidate = li.currentSrc || ci.getAttribute('src');
    var m = candidate ? mapped(candidate) : null;
    if (m) {
      ci.setAttribute('data-archive-original-src', abs(candidate) || candidate);
      ci.setAttribute('src', m);
      // srcset would re-introduce network URLs; the single mapped src is
      // what the browser picked at capture time.
      ci.removeAttribute('srcset');
      ci.removeAttribute('sizes');
      ci.removeAttribute('loading');
    } else if (candidate && candidate.indexOf('data:') !== 0) {
      // Could not archive this image normally -- mark it so the main
      // process can try the rendered-element screenshot fallback.
      var marker = 'archive-img-' + i;
      ci.setAttribute('data-archive-needs-screenshot', marker);
      li.setAttribute('data-archive-needs-screenshot', marker);
      ci.setAttribute('data-archive-original-src', abs(candidate) || candidate);
    }
  }
  // <picture> sources would override our rewritten <img src>.
  var pictureSources = doc.querySelectorAll('picture source');
  for (var i = 0; i < pictureSources.length; i++) {
    if (pictureSources[i].parentNode) pictureSources[i].parentNode.removeChild(pictureSources[i]);
  }

  // Inline style attributes containing url(...)
  var styled = doc.querySelectorAll('[style]');
  for (var i = 0; i < styled.length; i++) {
    var s = styled[i].getAttribute('style');
    if (!s || s.indexOf('url(') < 0) continue;
    styled[i].setAttribute('style', s.replace(/url\\((['"]?)(.*?)\\1\\)/g, function (full, q, u) {
      var m = mapped(u);
      return m ? 'url("' + m + '")' : full;
    }));
  }

  // <base> would re-point every relative URL at the live site.
  var bases = doc.querySelectorAll('base');
  for (var i = 0; i < bases.length; i++) if (bases[i].parentNode) bases[i].parentNode.removeChild(bases[i]);

  // Service workers must not run in archived mode.
  var swScripts = doc.querySelectorAll('script');
  for (var i = 0; i < swScripts.length; i++) {
    var txt = swScripts[i].textContent || '';
    if (txt.indexOf('serviceWorker') >= 0 && txt.indexOf('register') >= 0) {
      swScripts[i].textContent = '/* service worker registration removed for offline archive */';
    }
  }

  // Forms: archived forms are read-only. Neutralize the action so a
  // submit cannot reach the network, and record what it was.
  var forms = doc.querySelectorAll('form');
  for (var i = 0; i < forms.length; i++) {
    var action = forms[i].getAttribute('action');
    if (action) forms[i].setAttribute('data-archive-original-action', abs(action) || action);
    forms[i].setAttribute('action', 'about:blank#archived-form');
    forms[i].setAttribute('data-archive-readonly', 'true');
    forms[i].setAttribute('onsubmit', 'return false;');
  }

  // The pairing uids were bookkeeping only -- strip them from the clone so
  // they don't leak into the archived HTML. (Live-document uids are
  // removed by the caller once element screenshots are done.)
  var stamped = doc.querySelectorAll('[' + UID_ATTR + ']');
  for (var s = 0; s < stamped.length; s++) stamped[s].removeAttribute(UID_ATTR);

  var html = '<!doctype html>\\n' + doc.outerHTML;
  return { html: html, canvasFallbacks: canvasFallbacks };
})()
`;
}

/** Remove the pairing/marker bookkeeping attributes from the live page. */
export const CLEANUP_LIVE_ATTRS_SCRIPT = `
(function () {
  try {
    var stamped = document.querySelectorAll('[data-archive-uid], [data-archive-needs-screenshot]');
    for (var i = 0; i < stamped.length; i++) {
      stamped[i].removeAttribute('data-archive-uid');
      stamped[i].removeAttribute('data-archive-needs-screenshot');
    }
  } catch (e) {}
  return true;
})()
`;

/**
 * Extract visible text for search. Form values are stripped first so
 * anything the user typed but did not submit never lands in the archive.
 */
export const EXTRACT_TEXT_SCRIPT = `
(function () {
  try {
    var clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return '';
    var inputs = clone.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].setAttribute('value', '');
      inputs[i].removeAttribute('value');
      if (inputs[i].tagName === 'TEXTAREA') inputs[i].textContent = '';
    }
    var drop = clone.querySelectorAll('script, style, noscript');
    for (var j = 0; j < drop.length; j++) drop[j].remove();
    return (clone.innerText || clone.textContent || '').slice(0, 5000000);
  } catch (e) {
    return '';
  }
})()
`;

/**
 * Measure an element marked for the screenshot fallback, in CSS pixels
 * relative to the top-left of the page. Scrolls it into view first (the
 * caller restores the original scroll afterwards).
 *
 * Returns null when the element must NOT be screenshotted -- zero size,
 * not rendered, invisible, or a tracking pixel.
 */
export function measureElementScript(marker: string): string {
  return `
(async function () {
  var el = document.querySelector('[data-archive-needs-screenshot="' + ${JSON.stringify(marker)} + '"]');
  if (!el) return null;

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  // Let layout, lazy-loading, and any transition settle.
  await new Promise(function (r) { setTimeout(r, 180); });
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}

  var rect = el.getBoundingClientRect();
  var cs = window.getComputedStyle(el);

  // Reject anything that isn't genuinely visible on screen.
  if (rect.width < 2 || rect.height < 2) return { rejected: 'zero-size' };
  // Tracking pixels: tiny images used for analytics, never real content.
  if (rect.width <= 3 && rect.height <= 3) return { rejected: 'tracking-pixel' };
  if (cs.display === 'none' || cs.visibility === 'hidden') return { rejected: 'not-visible' };
  if (parseFloat(cs.opacity || '1') < 0.05) return { rejected: 'not-visible' };

  // A broken <img> reports naturalWidth 0 once it has finished loading --
  // screenshotting it would just capture the browser's broken-image icon.
  if (el.tagName === 'IMG' && el.complete && (!el.naturalWidth || el.naturalWidth === 0)) {
    return { rejected: 'broken-image' };
  }

  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
    viewportX: rect.left,
    viewportY: rect.top,
    tagName: el.tagName.toLowerCase(),
    naturalWidth: el.naturalWidth || 0,
    naturalHeight: el.naturalHeight || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    originalSrc: el.getAttribute('data-archive-original-src') || el.getAttribute('src') || null,
    hasLinkAncestor: !!el.closest('a[href]')
  };
})()
`;
}

/** Replace a screenshot-marked element in the serialized HTML. */
export function replaceMarkedElementScript(marker: string, archiveUrl: string, isPlaceholder: boolean): string {
  return `
(function () {
  var el = document.querySelector('[data-archive-needs-screenshot="' + ${JSON.stringify(marker)} + '"]');
  if (el) el.removeAttribute('data-archive-needs-screenshot');
  return true;
})()
`;
}
