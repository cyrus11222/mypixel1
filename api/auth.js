import { AuthError, AUTH_COOLDOWN_SECONDS } from '../lib/auth.mjs';
import { authService, body, checkOrigin, clientIp, cookie, failure, json, token } from '../lib/http.mjs';

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, 'https://local.invalid').searchParams.get('action');
    if (req.method === 'GET' && action === 'me') {
      const sessionToken = token(req);
      const user = sessionToken ? await authService().session(sessionToken) : null;
      return json(res, user ? 200 : 401, user ? { user } : { error: '请先登录。' });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw new AuthError(405, '不支持此请求方法。'); }
    checkOrigin(req);
    if (!['login', 'register', 'logout', 'bind-game', 'unbind-game', 'join-community'].includes(action)) throw new AuthError(404, '接口不存在。');
    const input = await body(req);
    if (['bind-game', 'unbind-game', 'join-community'].includes(action) && !token(req)) throw new AuthError(401, '请先登录后再操作。');
    const auth = authService();
    if (action === 'bind-game') return json(res, 200, { user: await auth.bindGame(token(req), input) });
    if (action === 'unbind-game') return json(res, 200, { user: await auth.unbindGame(token(req)) });
    if (action === 'join-community') return json(res, 200, { user: await auth.joinCommunity(token(req), input) });
    if (action === 'logout') {
      await auth.logout(token(req));
      res.setHeader('Set-Cookie', cookie('', false, true));
      return json(res, 200, { ok: true });
    }
    const result = action === 'register' ? await auth.register(input, clientIp(req)) : await auth.login(input, clientIp(req), token(req));
    res.setHeader('Set-Cookie', cookie(result.token, result.remember));
    return json(res, action === 'register' ? 201 : 200, { user: result.user, cooldownSeconds: AUTH_COOLDOWN_SECONDS });
  } catch (error) { failure(res, error); }
}
