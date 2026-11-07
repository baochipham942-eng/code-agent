/* global process, console */
// Deterministic 5-page fixture for managed-browser multi-step runs. No external network.
// Usage: node tests/fixtures/browser-doomloop/server.mjs [port]  (prints FIXTURE_URL=...)
import http from 'node:http';

const nav = '<nav><a href="/">Home</a> | <a href="/form">Form</a> | <a href="/reveal">Reveal</a> | <a href="/delayed">Delayed</a> | <a href="/upload">Upload</a></nav>';
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${nav}<h1>${title}</h1>${body}</body></html>`;
const bootAt = Date.now();

const pages = {
  '/': () => page('Fixture Home', '<p>Welcome. Secret code A: ALPHA-17.</p>'),
  '/form': () => page('Fixture Form', '<form onsubmit="event.preventDefault();document.getElementById(\'out\').textContent=\'Hello, \'+document.getElementById(\'name\').value"><label>Name <input id="name" name="name"></label><button type="submit" id="go">Greet</button></form><p id="out"></p>'),
  '/reveal': () => page('Fixture Reveal', '<button id="reveal" onclick="document.getElementById(\'secret\').textContent=\'Secret code B: BRAVO-42\'">Show secret</button><p id="secret"></p>'),
  // Same URL, text changes ~4s after load: re-reading with identical args yields different results.
  '/delayed': () => page('Fixture Delayed', '<p id="status">Status: loading</p><script>setTimeout(()=>{document.getElementById("status").textContent="Status: ready. Secret code C: CHARLIE-99"},4000)</script>'),
  '/upload': () => page('Fixture Upload', '<input type="file" id="f"><p>Upload any file to continue.</p>'),
};

export function startFixture(port = 0) {
  const server = http.createServer((req, res) => {
    const handler = pages[(req.url ?? '/').split('?')[0]];
    if (!handler) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(handler());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, bootAt })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startFixture(Number(process.argv[2] ?? 0));
  console.log(`FIXTURE_URL=http://127.0.0.1:${port}`);
}
