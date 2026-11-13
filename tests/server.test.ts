// Exercise the test server over HTTP, keeping request paths intact for traversal checks.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSiteServer } from '../e2e/serve.mjs';

describe('the local test server', () => {
  let root = '';
  let server: http.Server | undefined;
  let port: number;
  const page = '<!doctype html><script id="first-paint">0</script><script>0</script><p>site</p>';

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'perspective-server-'));
    const dist = path.join(root, 'dist'), reference = path.join(root, '.reference');
    for (const [base, sibling] of [[dist, 'dist-private'], [reference, '.reference-private']]) {
      fs.mkdirSync(path.join(base, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(base, 'index.html'), base === dist ? page : 'reference');
      fs.writeFileSync(path.join(base, 'assets', 'with space.txt'), 'asset');
      fs.mkdirSync(path.join(root, sibling));
      fs.writeFileSync(path.join(root, sibling, 'secret.txt'), 'private marker');
      fs.symlinkSync(path.join(root, sibling), path.join(base, 'escape'), 'junction');
    }
    server = createSiteServer(dist, reference);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function request(requestPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: requestPath, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('test server request timed out')));
    });
  }

  it('serves the site and reference indexes', async () => {
    expect(await request('/')).toEqual({ status: 200, body: page });
    expect(await request('/__reference/')).toEqual({ status: 200, body: 'reference' });
  });

  it('serves nested assets with encoded filenames under both roots', async () => {
    for (const prefix of ['', '/__reference']) {
      expect(await request(prefix + '/assets/with%20space.txt')).toEqual({ status: 200, body: 'asset' });
    }
  });

  it('preserves the slow-response option', async () => {
    expect(await request('/?drip=1')).toEqual({ status: 200, body: page });
  });

  it('returns 400 for malformed URL escapes and continues serving requests', async () => {
    for (const url of ['/%', '/%GG', '/%C3%28', '/__reference/%E0%A4%A']) {
      expect((await request(url)).status, url).toBe(400);
      expect(await request('/')).toEqual({ status: 200, body: page });
    }
  });

  it('rejects traversal into siblings sharing a served directory prefix', async () => {
    for (const url of ['/..%2fdist-private/secret.txt', '/__reference/..%2f.reference-private/secret.txt']) {
      expect((await request(url)).status, url).toBe(404);
    }
  });

  it('rejects symlinks that lead outside either served directory', async () => {
    for (const prefix of ['', '/__reference']) {
      expect((await request(prefix + '/escape/secret.txt')).status).toBe(404);
    }
  });

  it('returns 404 for missing files and directories', async () => {
    for (const prefix of ['', '/__reference']) {
      for (const url of ['/missing.txt', '/assets', '/assets/']) {
        expect((await request(prefix + url)).status, prefix + url).toBe(404);
      }
    }
  });
});
