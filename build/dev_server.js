/* ローカル確認用のサーバー
 *
 *   node build/dev_server.js [ポート]
 *
 * 本番と同じく worker/index.js を入口にして、site/ を配る ASSETS を
 * こちら側で用意する。/api/bukken も実際に動く。
 *
 * `ローカルで開く.bat`（python -m http.server）との違い:
 *   - Worker を通すので /api/bukken が使える（python 版では 404 になる）
 *   - charset を付けて返すので日本語が化けない
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

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

/* 本番で Cloudflare がやっている静的アセットの配信を肩代わりする */
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    try {
      const buf = await fs.promises.readFile(file);
      return new Response(buf, {
        headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' },
      });
    } catch {
      /* 本番の既定（not_found_handling 未指定）と同じく、本文の無い404 */
      return new Response(null, { status: 404 });
    }
  },
};

(async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'index.js')).href))
    .default;

  http
    .createServer(async (req, res) => {
      const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method });
      let out;
      try {
        out = await worker.fetch(request, { ASSETS }, { waitUntil: () => {} });
      } catch (e) {
        out = new Response(JSON.stringify({ ok: false, message: e.message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    })
    .listen(PORT, () => console.log(`http://localhost:${PORT}/`));
})();
