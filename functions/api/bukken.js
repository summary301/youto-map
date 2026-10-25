/* 物件ページから「座標だけ」を取り出す中継（Cloudflare Pages Functions）
 *
 *   GET /api/bukken?url=<物件ページのURL>
 *   →  { ok: true, lat, lon, source: "SUUMO", url }
 *
 * ブラウザから他サイトを直接読むことは CORS で出来ないため、ここで中継する。
 *
 * 方針:
 *   - 取り出すのは緯度経度だけ。物件名・価格・説明文などは一切返さない。
 *     用途地域の判定に要るのは座標だけで、それ以外を持ち出すと転載になる。
 *   - 行き先は下の ALLOW_HOSTS に挙げたホストだけ。任意のURLを踏めると
 *     踏み台（SSRF）になるため、許可リスト方式にしてある。
 *   - robots.txt が拒んでいる経路は DENY_PREFIXES で弾く。
 *     SUUMO の robots.txt（2026-10-25 確認・381行）は User-agent:* に対して
 *     /jj/ /mb/ /sp/ /edit/ /display/ /journal/ 系を禁じているが、
 *     物件詳細の /tochi/ /ikkodate/ /ms/ /chuko/ は対象外。Crawl-delay も
 *     bingbot にしか付いていない。
 *   - 同じ物件を何度引いても配布元を叩かないよう、結果を24時間キャッシュする。
 */

const ALLOW_HOSTS = {
  'suumo.jp': 'SUUMO',
  'www.suumo.jp': 'SUUMO',
};

/* robots.txt が User-agent:* に対して禁じている接頭辞 */
const DENY_PREFIXES = ['/jj/', '/mb/', '/sp/', '/edit/', '/display/', '/journal/'];

/* 物件詳細ページの印。一覧ページや内部APIを弾くために要求する */
const DETAIL_RE = /\/nc_\d+\/?$/;

/* 23区のおおよその範囲。ここを外れた座標は読み違いとして捨てる */
const BOUNDS = { minLat: 35.5, maxLat: 35.9, minLon: 139.5, maxLon: 139.95 };

const CACHE_SECONDS = 60 * 60 * 24;

/* HTTPヘッダに日本語は載らない（latin-1 しか通らない）ので ASCII で名乗る */
const UA =
  'youto-map/1.0 (+https://youto-map.summary301.workers.dev/; fetches one user-pasted page for its map coordinates)';

function fail(status, message, hint) {
  return json(status, { ok: false, message, hint });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/* 物件ページのURLとして受け付けてよいかを判定する */
function validate(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'URLとして読めませんでした。' };
  }
  if (u.protocol !== 'https:') return { error: 'https のURLだけを扱います。' };
  if (u.port) return { error: 'ポート番号付きのURLは扱いません。' };

  const site = ALLOW_HOSTS[u.hostname];
  if (!site) {
    return {
      error: `${u.hostname} には対応していません。`,
      hint: '現在対応しているのは SUUMO の物件詳細ページだけです。',
    };
  }
  if (DENY_PREFIXES.some((p) => u.pathname.startsWith(p))) {
    return { error: 'このページは配布元が取得を禁じている経路にあります。' };
  }
  if (!DETAIL_RE.test(u.pathname)) {
    return {
      error: '物件詳細ページのURLではないようです。',
      hint: '一覧ではなく、個別の物件ページ（末尾が nc_ で始まる番号）を貼ってください。',
    };
  }
  /* クエリや断片は持ち越さない（余計な情報を送らないため） */
  return { url: `https://${u.hostname}${u.pathname}`, site };
}

/* SUUMO の地図設定ブロックから座標を取り出す。
 * ページには markers の lat/lng と initIdo/initKeido が二重に入っているので、
 * ピンそのものである markers を優先し、無ければ初期表示座標に落とす。 */
function extractCoords(html) {
  const patterns = [
    /\{\s*lat\s*:\s*['"]([\d.]+)['"]\s*,\s*lng\s*:\s*['"]([\d.]+)['"]/,
    /initIdo\s*:\s*['"]([\d.]+)['"][\s\S]{0,80}?initKeido\s*:\s*['"]([\d.]+)['"]/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    return { lat, lon };
  }
  return null;
}

export async function onRequestGet({ request, waitUntil }) {
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) return fail(400, 'url パラメータがありません。');

  const v = validate(raw);
  if (v.error) return fail(400, v.error, v.hint);

  const cache = caches.default;
  const cacheKey = new Request(`https://youto-map.invalid/bukken?u=${encodeURIComponent(v.url)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(v.url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return fail(502, `物件ページを取得できませんでした（${e.message}）。`);
  }

  /* 転送先が許可外へ移っていないか、最終URLで確かめる */
  try {
    if (res.url && !ALLOW_HOSTS[new URL(res.url).hostname]) {
      return fail(502, '転送先が対応外のサイトでした。');
    }
  } catch {
    /* res.url が空のときは判定を省く */
  }

  if (res.status === 404) {
    return fail(404, '物件ページが見つかりませんでした。掲載が終了した可能性があります。');
  }
  if (!res.ok) {
    return fail(502, `物件ページの取得に失敗しました（HTTP ${res.status}）。`);
  }

  const len = Number(res.headers.get('content-length') || 0);
  if (len > 5_000_000) return fail(502, 'ページが大きすぎます。');

  const html = await res.text();
  const coords = extractCoords(html);
  if (!coords) {
    return fail(
      422,
      'このページから座標を読み取れませんでした。',
      '地図が載っていない物件か、配布元のページ構造が変わった可能性があります。住所で検索してください。'
    );
  }

  const { lat, lon } = coords;
  if (
    lat < BOUNDS.minLat || lat > BOUNDS.maxLat ||
    lon < BOUNDS.minLon || lon > BOUNDS.maxLon
  ) {
    return fail(422, '読み取った座標が東京23区の範囲外でした。', `緯度 ${lat}／経度 ${lon}`);
  }

  const out = json(200, { ok: true, lat, lon, source: v.site, url: v.url });
  const cacheable = out.clone();
  cacheable.headers.set('cache-control', `public, max-age=${CACHE_SECONDS}`);
  waitUntil(cache.put(cacheKey, cacheable));
  return out;
}
