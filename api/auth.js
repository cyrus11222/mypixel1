import { AuthError, AUTH_COOLDOWN_SECONDS } from '../lib/auth.mjs';
import { authService, body, checkOrigin, clientIp, cookie, failure, json, token } from '../lib/http.mjs';

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, 'https://local.invalid').searchParams.get('action');
    if (req.method === 'GET' && action === 'me') {
      const sessionToken = token(req);
      const user = sessionToken ? await authService().session(sessionToken) : null;
      return json(res, user ? 200 : 401, user ? { user } : { error: sessionToken ? '登录已失效，请重新登录。' : '请先登录。', code: sessionToken ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED' });
    }
    if (req.method === 'GET' && action === 'public-config') return json(res, 200, await authService().publicConfig());
    if (req.method === 'GET' && ['tickets', 'review-tickets', 'admin-state'].includes(action)) {
      if (!token(req)) throw new AuthError(401, '请先登录后再操作。');
      const auth = authService();
      if (action === 'admin-state') return json(res, 200, await auth.adminState(token(req)));
      return json(res, 200, { tickets: await auth.listTickets(token(req), action === 'review-tickets') });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw new AuthError(405, '不支持此请求方法。'); }
    checkOrigin(req);
    if (!['login', 'register', 'logout', 'bind-game', 'unbind-game', 'join-community', 'notifications-ack', 'admin-command', 'ticket-create', 'ticket-review'].includes(action)) throw new AuthError(404, '接口不存在。');
    const input = await body(req);
    if (!['login', 'register', 'logout'].includes(action) && !token(req)) throw new AuthError(401, '请先登录后再操作。');
    const auth = authService();
    if (action === 'bind-game') return json(res, 200, { user: await auth.bindGame(token(req), input) });
    if (action === 'unbind-game') return json(res, 200, { user: await auth.unbindGame(token(req)) });
    if (action === 'join-community') return json(res, 200, { user: await auth.joinCommunity(token(req), input) });
    if (action === 'notifications-ack') return json(res, 200, { user: await auth.acknowledgeNotifications(token(req), input) });
    if (action === 'admin-command') return json(res, 200, await auth.adminCommand(token(req), input));
    if (action === 'ticket-create') return json(res, 201, { ticket: await auth.createTicket(token(req), input) });
    if (action === 'ticket-review') return json(res, 200, { ticket: await auth.reviewTicket(token(req), input) });
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
