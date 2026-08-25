// A tiny local fixture "website" so core capture/navigation tests don't
// depend on the real internet (flaky, slow, and not something we should
// be hammering in CI). Each route below exercises one behavior from the
// test matrix: plain navigation, redirects, SPA route changes, dynamic
// content, lazy images, and a broken resource. Plain CommonJS so it can be
// run standalone (`npm run fixtures:serve`) or required directly from
// Playwright tests without a separate build step.

const http = require('node:http');

function html(title, body) {
  return `<!doctype html><html><head><title>${title}</title>
  <link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">
  </head><body>${body}</body></html>`;
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const routes = {
  '/': () => ({ status: 200, body: html('Fixture Home', '<h1>Fixture Home</h1><a href="/page-two">Page Two</a>') }),
  '/page-two': () => ({ status: 200, body: html('Fixture Page Two', '<h1>Page Two</h1><a href="/">Home</a>') }),
  '/redirect-source': () => ({ status: 302, headers: { Location: '/redirect-target' }, body: '' }),
  '/redirect-target': () => ({ status: 200, body: html('Redirect Target', '<h1>You were redirected here</h1>') }),
  '/spa': () => ({
    status: 200,
    body: html(
      'SPA Shell',
      `<div id="app"><h1>SPA Route: /</h1></div>
      <script>
        function render() {
          document.getElementById('app').innerHTML = '<h1>SPA Route: ' + location.pathname + location.hash + '</h1>';
          document.title = 'SPA ' + (location.hash || '/');
        }
        window.addEventListener('popstate', render);
        window.goTo = function (path) { history.pushState({}, '', path); render(); };
        render();
      </script>`,
    ),
  }),
  '/dynamic-content': () => ({
    status: 200,
    body: html(
      'Dynamic Content',
      `<h1 id="status">Loading…</h1>
      <script>setTimeout(function(){ document.getElementById('status').textContent = 'Loaded'; }, 500);</script>`,
    ),
  }),
  '/lazy-images': () => ({
    status: 200,
    body: html(
      'Lazy Images',
      '<h1>Lazy Images</h1>' +
        Array.from({ length: 5 })
          .map((_, i) => `<img loading="lazy" width="100" height="100" src="/pixel.png?n=${i}" alt="img-${i}">`)
          .join(''),
    ),
  }),
  '/broken-resource': () => ({
    status: 200,
    body: html('Broken Resource', '<h1>Broken Resource</h1><img src="/does-not-exist.png" alt="missing">'),
  }),
  // A page big enough on both axes that rasterizing it at the display's
  // device pixel ratio costs far more memory than the capture budget is
  // supposed to allow. Real marketing pages are routinely this size.
  '/tall-page': () => ({
    status: 200,
    body: html(
      'Tall Page',
      '<h1>Tall Page</h1>' +
        Array.from({ length: 120 })
          .map((_, i) => `<p style="height:100px;width:2400px;margin:0">block ${i}</p>`)
          .join(''),
    ),
  }),
  // Library search-ranking test (tests/e2e/library-and-deletion.spec.ts):
  // the same rare term appears in this page's <title> ...
  '/search-rank-title': () => ({
    status: 200,
    body: html('Zzyzxwidget Page', '<h1>Zzyzxwidget Page</h1><p>Nothing else interesting here.</p>'),
  }),
  // ... and only in this page's body text, never its title, so a search
  // for the term can prove relevance ranking put the title match first.
  '/search-rank-body': () => ({
    status: 200,
    body: html(
      'Unrelated Title',
      '<p>This paragraph is mostly filler, but it does mention zzyzxwidget once, in passing.</p>',
    ),
  }),
};

function startFixtureServer(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/pixel.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PIXEL_PNG);
        return;
      }
      const route = routes[url.pathname];
      if (!route) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const { status, headers, body } = route();
      res.writeHead(status, { 'Content-Type': 'text/html', ...headers });
      res.end(body);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}

module.exports = { startFixtureServer };

if (require.main === module) {
  startFixtureServer(4173).then(({ url }) => {
    console.log(`Fixture server running at ${url}`);
  });
}
