/* Worker の入口
 *
 * このサイトは「静的アセット付き Worker」として配信している。
 * site/ の中身に当たる要求は Cloudflare 側で直接返され、ここには来ない
 * （その分は課金対象にならない）。当たらなかったものだけが降りてくるので、
 * /api/bukken を処理して、それ以外はアセット側の 404 に委ねる。
 */
import { handleBukken } from './bukken.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/bukken') {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      return handleBukken(request, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
