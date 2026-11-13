// Serves the built site at / and the reference page (the original artboard) at /__reference/.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReference } from './reference/build.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain', '.png': 'image/png', '.json': 'application/json' };

function inside(base, file) {
  const relative = path.relative(base, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveFile(base, url) {
  const candidate = path.join(base, url);
  if (!inside(base, candidate)) return null;
  try {
    // Check the real path too, so a symlink cannot serve files outside this root.
    const file = fs.realpathSync(candidate);
    return inside(base, file) && fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function createSiteServer(dist, reference) {
  dist = fs.realpathSync(dist);
  reference = fs.realpathSync(reference);
  return http.createServer((req, res) => {
    let requestUrl, url;
    try {
      requestUrl = new URL(req.url, 'http://x');
      url = decodeURIComponent(requestUrl.pathname);
    } catch {
      res.writeHead(400); res.end('bad request'); return;
    }
    let base = dist;
    if (url.startsWith('/__reference/')) { base = reference; url = url.slice('/__reference'.length); }
    if (url.endsWith('/')) url += 'index.html';
    const file = resolveFile(base, url);
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    // /?drip=400 sends the page the way a slow connection would: the part needed to draw the
    // first view, a pause, the main script, a pause, then the layers that are not on screen yet.
    const drip = Number(requestUrl.searchParams.get('drip'));
    if (drip > 0 && file.endsWith('index.html') && base === dist) {
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { res.destroy(); return; }
      const cut1 = html.indexOf('</script>', html.indexOf('<script id="first-paint">')) + 9;
      const cut2 = html.indexOf('</script>', html.indexOf('<script>', cut1)) + 9;
      res.write(html.slice(0, cut1));
      setTimeout(() => { res.write(html.slice(cut1, cut2)); setTimeout(() => res.end(html.slice(cut2)), drip); }, drip);
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.join(root, 'dist');
  const reference = buildReference();
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dist/ is missing: run "npm run build" first'); process.exit(1); }
  const port = Number(process.env.PORT || 4173);
  createSiteServer(dist, reference).listen(port, '127.0.0.1', () => console.log(`serving dist/ and the reference on http://127.0.0.1:${port}`));
}
