// A multi-page fixture website for .sitearchive capture tests.
//
// Every route here exists to exercise one specific behavior from the test
// matrix: relative/absolute links, nested pages, redirects, fragments,
// query strings, CSS/images/fonts/SVG, lazy loading, JS-generated links,
// SPA routes, duplicate assets, missing resources, cross-origin links,
// forms and destructive-looking links, and recursive link loops.
//
// Plain CommonJS so it runs standalone or from Playwright with no build.

const http = require('node:http');
const zlib = require('node:zlib');

/**
 * Build a real, valid solid-colour PNG.
 *
 * Generated rather than hard-coded as base64 so the CRCs are always
 * correct -- a hand-edited PNG with a stale chunk CRC silently fails to
 * decode in the browser, which makes image tests lie about what they're
 * exercising.
 */
function makePng(width, height, [r, g, b]) {
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines: one filter byte (0 = none) then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_RED = makePng(16, 16, [226, 92, 92]);
const PNG_BLUE = makePng(16, 16, [74, 144, 226]);
const PNG_GREEN = makePng(16, 16, [74, 194, 107]);
// A minimal valid WOFF header is enough to prove font bytes round-trip.
const FONT_BYTES = Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(508, 7)]);

const SVG_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="28" fill="#4a90e2"/><text x="30" y="38" font-size="24" text-anchor="middle" fill="#fff">A</text></svg>`;

const STYLES = `
body { font-family: sans-serif; margin: 0; padding: 24px; background: #fff; color: #111; }
h1 { color: #4a90e2; }
.hero { width: 200px; height: 120px; background-image: url('/img/bg.png'); background-size: cover; }
@font-face { font-family: 'FixtureFont'; src: url('/font/fixture.woff') format('woff'); }
.fancy { font-family: 'FixtureFont', sans-serif; }
nav a { margin-right: 12px; }
`;

function layout(title, body, extraHead = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/img/logo.svg">
${extraHead}
</head><body>
<nav>
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/products/widget">Widget</a>
  <a href="/deep/one">Deep</a>
</nav>
${body}
</body></html>`;
}

const routes = {
  '/': () => ({
    body: layout(
      'Fixture Site Home',
      `<h1>Fixture Site Home</h1>
       <img src="/img/logo.svg" width="60" height="60" alt="logo">
       <img src="/img/red.png" alt="red">
       <div class="hero"></div>
       <p class="fancy">Styled with a web font.</p>
       <ul>
         <li><a href="about">Relative link to About</a></li>
         <li><a href="/products/widget">Absolute path to Widget</a></li>
         <li><a href="http://127.0.0.1:1/offsite">Cross-origin link (never followed)</a></li>
         <li><a href="/about#section-two">Link with fragment</a></li>
         <li><a href="/search?q=hello&amp;page=2">Link with query string</a></li>
         <li><a href="/missing-page">Link to a page that 404s</a></li>
         <li><a href="/logout">Log out (destructive; must not be followed)</a></li>
         <li><a href="/loop/a">Recursive loop start</a></li>
         <li><a href="/redirect-to-about">Redirect to About</a></li>
       </ul>
       <form action="/submit" method="post">
         <input type="text" name="comment" value="typed but not submitted">
         <input type="password" name="password" value="hunter2">
         <input type="hidden" name="csrf_token" value="SECRET-CSRF-VALUE">
         <input type="checkbox" name="agree" checked>
         <select name="choice"><option value="a">A</option><option value="b" selected>B</option></select>
         <button type="submit">Submit</button>
         <a href="/delete-account">Delete account</a>
       </form>`,
    ),
  }),

  '/about': () => ({
    body: layout(
      'About the Fixture',
      `<h1>About</h1>
       <img src="/img/logo.svg" width="60" height="60" alt="logo again (duplicate asset)">
       <p>Nested and relative navigation lives here.</p>
       <h2 id="section-two">Section Two</h2>
       <p>Fragment target.</p>
       <a href="../">Relative link back up to Home</a>`,
    ),
  }),

  '/products/widget': () => ({
    body: layout(
      'Widget',
      `<h1>Widget</h1>
       <img src="../img/blue.png" alt="relative-from-nested">
       <img src="/img/logo.svg" width="40" height="40" alt="duplicate svg">
       <p><a href="./gadget">Sibling relative link</a></p>
       <p><a href="/">Home</a></p>`,
    ),
  }),

  '/products/gadget': () => ({
    body: layout('Gadget', `<h1>Gadget</h1><p>A sibling product page.</p><a href="/">Home</a>`),
  }),

  '/deep/one': () => ({
    body: layout('Deep One', `<h1>Deep One</h1><a href="/deep/two">Deeper</a>`),
  }),
  '/deep/two': () => ({
    body: layout('Deep Two', `<h1>Deep Two</h1><a href="/deep/three">Deeper still</a>`),
  }),
  '/deep/three': () => ({
    body: layout('Deep Three', `<h1>Deep Three</h1><a href="/deep/four">Even deeper</a>`),
  }),
  '/deep/four': () => ({
    body: layout('Deep Four', `<h1>Deep Four</h1><p>Depth limit should stop before here on shallow crawls.</p>`),
  }),

  // Recursive loop: a -> b -> a. Must terminate via normalized dedupe.
  '/loop/a': () => ({ body: layout('Loop A', `<h1>Loop A</h1><a href="/loop/b">To B</a>`) }),
  '/loop/b': () => ({ body: layout('Loop B', `<h1>Loop B</h1><a href="/loop/a">Back to A</a>`) }),

  '/search': (url) => ({
    body: layout('Search', `<h1>Search</h1><p>Query: ${escapeHtml(url.searchParams.get('q') || '')}</p>`),
  }),

  '/redirect-to-about': () => ({ status: 302, headers: { Location: '/about' }, body: '' }),
  '/redirect-loop-a': () => ({ status: 302, headers: { Location: '/redirect-loop-b' }, body: '' }),
  '/redirect-loop-b': () => ({ status: 302, headers: { Location: '/redirect-loop-a' }, body: '' }),

  '/lazy': () => ({
    body: layout(
      'Lazy Loading',
      `<h1>Lazy Loading</h1>
       <div style="height:1500px">Scroll down…</div>
       <img id="lazy-img" loading="lazy" data-src="/img/blue.png" src="/img/red.png" width="8" height="8" alt="lazy">
       <div id="lazy-text">not-yet-loaded</div>
       <script>
         var obs = new IntersectionObserver(function (entries) {
           entries.forEach(function (e) {
             if (e.isIntersecting) {
               document.getElementById('lazy-text').textContent = 'lazy-content-loaded';
               obs.disconnect();
             }
           });
         });
         obs.observe(document.getElementById('lazy-text'));
       </script>`,
    ),
  }),

  '/js-links': () => ({
    body: layout(
      'JS Generated Links',
      `<h1>JS Generated Links</h1>
       <div id="container"></div>
       <script>
         var a = document.createElement('a');
         a.href = '/products/gadget';
         a.textContent = 'Link created by JavaScript';
         document.getElementById('container').appendChild(a);
       </script>`,
    ),
  }),

  '/spa': () => ({
    body: layout(
      'SPA Shell',
      `<h1 id="view">SPA: /</h1>
       <a href="#/route-one">Route One</a>
       <a href="#/route-two">Route Two</a>
       <script>
         function render() { document.getElementById('view').textContent = 'SPA: ' + (location.hash || '/'); }
         window.addEventListener('hashchange', render);
         render();
       </script>`,
    ),
  }),

  // A same-origin frame (archivable) next to a cross-origin one (not),
  // so the placeholder behaviour can be tested.
  '/frames': () => ({
    body: layout(
      'Frames',
      `<h1>Frames</h1>
       <iframe id="same" src="/frame-content" width="300" height="120"></iframe>
       <iframe id="cross" src="http://127.0.0.1:1/embedded" width="300" height="120"></iframe>`,
    ),
  }),
  '/frame-content': () => ({
    body: layout('Frame Content', '<p id="inner">Same-origin frame content</p>'),
  }),

  '/broken-assets': () => ({
    body: layout(
      'Broken Assets',
      `<h1>Broken Assets</h1>
       <img src="/img/does-not-exist.png" alt="missing image">
       <link rel="stylesheet" href="/css/missing.css">`,
    ),
  }),

  // Pages used by the image screenshot fallback tests.
  '/images': () => ({
    body: layout(
      'Image Variations',
      `<h1>Image Variations</h1>
       <div class="private-info">SECRET-ACCOUNT-NUMBER-12345</div>
       <img id="normal" src="/img/red.png" width="80" height="80" alt="normal">
       <img id="objectfit" src="/img/blue.png" width="80" height="40" style="object-fit:cover" alt="object-fit">
       <img id="rounded" src="/img/red.png" width="80" height="80" style="border-radius:50%;clip-path:circle(40px)" alt="rounded">
       <img id="rotated" src="/img/blue.png" width="80" height="80" style="transform:rotate(25deg)" alt="rotated">
       <a id="wrapping-link" href="/about"><img id="linked" src="/img/red.png" width="60" height="60" alt="linked"></a>
       <img id="tracker" src="/img/red.png" width="1" height="1" alt="tracking pixel">
       <img id="broken" src="/img/does-not-exist.png" width="80" height="80" alt="broken">
       <canvas id="canvas" width="80" height="80"></canvas>
       <img id="blobimg" width="80" height="80" alt="blob">
       <div id="cssbg" style="width:80px;height:80px;background-image:url('/img/blue.png')"></div>
       <script>
         var c = document.getElementById('canvas').getContext('2d');
         c.fillStyle = '#e25c5c'; c.fillRect(0, 0, 80, 80);
         c.fillStyle = '#fff'; c.fillRect(20, 20, 40, 40);
         // A blob: URL image. It renders fine for the user, but the
         // archiver cannot re-fetch a blob: URL, so this is exactly the
         // case the rendered-element screenshot fallback exists for.
         var bytes = new Uint8Array([${[...PNG_GREEN].join(',')}]);
         var blob = new Blob([bytes], { type: 'image/png' });
         document.getElementById('blobimg').src = URL.createObjectURL(blob);
       </script>`,
    ),
  }),
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ASSETS = {
  '/css/site.css': { body: STYLES, type: 'text/css' },
  '/img/logo.svg': { body: SVG_LOGO, type: 'image/svg+xml' },
  '/img/red.png': { body: PNG_RED, type: 'image/png' },
  '/img/blue.png': { body: PNG_BLUE, type: 'image/png' },
  '/img/bg.png': { body: PNG_BLUE, type: 'image/png' },
  '/font/fixture.woff': { body: FONT_BYTES, type: 'font/woff' },
};

function startSiteFixtureServer(port = 0) {
  let requestCount = 0;
  const requestLog = [];

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requestCount += 1;
      requestLog.push({ method: req.method, url: req.url });

      // Any non-GET request is a test failure signal: the crawler must
      // never issue one. Recorded so tests can assert on it.
      const url = new URL(req.url ?? '/', 'http://localhost');

      const asset = ASSETS[url.pathname];
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
        res.end(asset.body);
        return;
      }

      const route = routes[url.pathname];
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(layout('Not Found', '<h1>404</h1>'));
        return;
      }

      const out = route(url);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8', ...(out.headers ?? {}) });
      res.end(out.body);
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        url: `http://127.0.0.1:${actualPort}`,
        getRequestCount: () => requestCount,
        getRequestLog: () => requestLog.slice(),
      });
    });
  });
}

module.exports = { startSiteFixtureServer };

if (require.main === module) {
  startSiteFixtureServer(4174).then(({ url }) => console.log(`Site fixture running at ${url}`));
}
