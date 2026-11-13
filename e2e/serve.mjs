// Serves the built site at / and the reference page (the original artboard) at /__reference/.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReference } from './reference/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const reference = buildReference();
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ is missing: run "npm run build" first'); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain', '.png': 'image/png', '.json': 'application/json' };
const port = Number(process.env.PORT || 4173);
http.createServer((req, res) => {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let base = dist;
  if (url.startsWith('/__reference/')) { base = reference; url = url.slice('/__reference'.length); }
  if (url.endsWith('/')) url += 'index.html';
  const file = path.join(base, url);
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  // /?drip=400 sends the page the way a slow connection would: the part needed to draw the
  // first view, a pause, the main script, a pause, then the layers that are not on screen yet.
  const drip = Number(new URL(req.url, 'http://x').searchParams.get('drip'));
  if (drip > 0 && file.endsWith('index.html') && base === dist) {
    const html = fs.readFileSync(file, 'utf8');
    const cut1 = html.indexOf('</script>', html.indexOf('<script id="first-paint">')) + 9;
    const cut2 = html.indexOf('</script>', html.indexOf('<script>', cut1)) + 9;
    res.write(html.slice(0, cut1));
    setTimeout(() => { res.write(html.slice(cut1, cut2)); setTimeout(() => res.end(html.slice(cut2)), drip); }, drip);
    return;
  }
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving dist/ and the reference on http://127.0.0.1:${port}`));
