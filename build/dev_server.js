/* ローカル確認用のサーバー
 *
 *   node build/dev_server.js [ポート]
 *
 * `ローカルで開く.bat`（python -m http.server）との違いは2つ:
 *   - functions/ 以下の Pages Functions を実際に動かす。
 *     /api/bukken を使う機能は python 版では確認できない。
 *   - charset を付けて返すので日本語が化けない。
 *
 * 本番は Cloudflare Pages が同じことをする。ここはあくまで確認用。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..', 'site');
const PORT = Number(process.argv[2] || 8788);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* Workers の caches.default の代わり。確認用なのでメモリに置くだけ。 */
const memo = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = memo.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) { memo.set(req.url, res.clone()); },
  },
};

async function handleFunction(req, res, parsed) {
  const mod = await import(
    url.pathToFileURL(path.join(__dirname, '..', 'functions', 'api', 'bukken.js')).href
  );
  const request = new Request('http://localhost:' + PORT + parsed.path);
  const out = await mod.onRequestGet({ request, waitUntil: () => {} });
  res.writeHead(out.status, { 'content-type': out.headers.get('content-type') });
  res.end(await out.text());
}

http
  .createServer(async (req, res) => {
    const parsed = url.parse(req.url);

    if (parsed.pathname === '/api/bukken') {
      try {
        await handleFunction(req, res, parsed);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: e.message }));
      }
      return;
    }

    const rel = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}/`));
