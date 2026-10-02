import { AuthError, AUTH_COOLDOWN_SECONDS } from '../lib/auth.mjs';
import { authService, body, checkOrigin, clientIp, cookie, device, failure, json, loginCookies, passkeyBinding, passkeyCookie, recoveryCookie, recoveryGrant, settings, token } from '../lib/http.mjs';

async function passkeys(auth) {
  const { PasskeyService } = await import('../lib/passkeys.mjs');
  return new PasskeyService(auth, { origin: settings().origin });
}

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, 'https://local.invalid').searchParams.get('action');
    if (req.method === 'GET' && action === 'me') {
      const sessionToken = token(req);
      const user = sessionToken ? await authService().session(sessionToken) : null;
      return json(res, user ? 200 : 401, user ? { user } : { error: sessionToken ? '登录已失效，请重新登录。' : '请先登录。', code: sessionToken ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED' });
    }
    if (req.method === 'GET' && action === 'public-config') return json(res, 200, await authService().publicConfig());
    if (req.method === 'GET' && action === 'passkeys') {
      if (!token(req)) throw new AuthError(401, '请先登录后再操作。');
      return json(res, 200, await (await passkeys(authService())).list(token(req)));
    }
    if (req.method === 'GET' && ['tickets', 'review-tickets', 'admin-state'].includes(action)) {
      if (!token(req)) throw new AuthError(401, '请先登录后再操作。');
      const auth = authService();
      if (action === 'admin-state') return json(res, 200, await auth.adminState(token(req)));
      return json(res, 200, { tickets: await auth.listTickets(token(req), action === 'review-tickets') });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw new AuthError(405, '不支持此请求方法。'); }
    checkOrigin(req);
    if (!['login', 'register', 'logout', 'bind-game', 'unbind-game', 'join-community', 'notifications-ack', 'admin-command', 'ticket-create', 'ticket-review', 'passkey-register-options', 'passkey-register-verify', 'passkey-auth-options', 'passkey-auth-verify', 'passkey-remove', 'passkey-recovery-options', 'passkey-recovery-verify', 'recovery-code-generate', 'recovery-code-confirm', 'recovery-code-verify', 'reset-password', 'change-password', 'phone-set'].includes(action)) throw new AuthError(404, '接口不存在。');
    const input = await body(req);
    if (!['login', 'register', 'logout', 'passkey-auth-options', 'passkey-auth-verify', 'passkey-recovery-options', 'passkey-recovery-verify', 'recovery-code-verify', 'reset-password'].includes(action) && !token(req)) throw new AuthError(401, '请先登录后再操作。');
    const auth = authService();
    const context = { deviceToken: device(req), userAgent: req.headers['user-agent'] || '', ip: clientIp(req) };
    if (action.startsWith('passkey-')) {
      const service = await passkeys(auth);
      if (['passkey-register-options', 'passkey-auth-options', 'passkey-recovery-options'].includes(action)) {
        const result = action === 'passkey-register-options' ? await service.registrationOptions(token(req), input, { ip: clientIp(req) }) :
          action === 'passkey-recovery-options' ? await service.recoveryOptions(input, { ip: clientIp(req) }) : await service.authenticationOptions(input, { ip: clientIp(req) });
        res.setHeader('Set-Cookie', passkeyCookie(result.bindingToken));
        return json(res, 200, { options: result.options });
      }
      if (action === 'passkey-register-verify') {
        const result = await service.verifyRegistration(token(req), input, passkeyBinding(req));
        res.setHeader('Set-Cookie', passkeyCookie('', true));
        return json(res, 200, result);
      }
      if (action === 'passkey-auth-verify') {
        const result = await service.verifyAuthentication(input, passkeyBinding(req), { ...context, previousToken: token(req) });
        res.setHeader('Set-Cookie', [...loginCookies(result), passkeyCookie('', true)]);
        return json(res, 200, { user: result.user });
      }
      if (action === 'passkey-recovery-verify') {
        const result = await service.verifyRecovery(input, passkeyBinding(req));
        res.setHeader('Set-Cookie', [recoveryCookie(result.grantToken), passkeyCookie('', true)]);
        return json(res, 200, { recoveryGranted: true, username: result.username, expiresInSeconds: result.expiresInSeconds });
      }
      return json(res, 200, await service.remove(token(req), input, { ip: clientIp(req) }));
    }
    if (action === 'bind-game') return json(res, 200, { user: await auth.bindGame(token(req), input) });
    if (action === 'unbind-game') return json(res, 200, { user: await auth.unbindGame(token(req)) });
    if (action === 'join-community') return json(res, 200, { user: await auth.joinCommunity(token(req), input) });
    if (action === 'notifications-ack') return json(res, 200, { user: await auth.acknowledgeNotifications(token(req), input) });
    if (action === 'admin-command') {
      if (typeof input?.command === 'string' && /^rsh(?:\s|$)/.test(input.command.trim())) {
        const { createDownloadService } = await import('../lib/downloads.mjs');
        return json(res, 200, await createDownloadService(auth).command(token(req), input.command));
      }
      return json(res, 200, await auth.adminCommand(token(req), input));
    }
    if (action === 'ticket-create') return json(res, 201, { ticket: await auth.createTicket(token(req), input) });
    if (action === 'ticket-review') return json(res, 200, { ticket: await auth.reviewTicket(token(req), input) });
    if (action === 'recovery-code-generate') return json(res, 200, await auth.generateRecoveryCode(token(req), input, clientIp(req)));
    if (action === 'recovery-code-confirm') return json(res, 200, { user: await auth.confirmRecoveryCode(token(req), input) });
    if (action === 'recovery-code-verify') {
      const result = await auth.verifyRecoveryCode(input, clientIp(req));
      res.setHeader('Set-Cookie', recoveryCookie(result.grantToken));
      return json(res, 200, { recoveryGranted: true, username: result.username, expiresInSeconds: result.expiresInSeconds });
    }
    if (action === 'reset-password') {
      const result = await auth.resetPassword(recoveryGrant(req), input, context);
      res.setHeader('Set-Cookie', [recoveryCookie('', true), cookie('', false, true)]);
      return json(res, 200, result);
    }
    if (action === 'change-password') {
      const result = await auth.changePassword(token(req), input, context);
      res.setHeader('Set-Cookie', [...loginCookies(result), recoveryCookie('', true)]);
      return json(res, 200, { user: result.user });
    }
    if (action === 'phone-set') return json(res, 200, { user: await auth.setPhone(token(req), input, clientIp(req)) });
    if (action === 'logout') {
      await auth.logout(token(req));
      await auth.cancelRecovery(recoveryGrant(req));
      res.setHeader('Set-Cookie', [cookie('', false, true), recoveryCookie('', true), passkeyCookie('', true)]);
      return json(res, 200, { ok: true });
    }
    const result = action === 'register' ? await auth.register(input, clientIp(req), context) : await auth.login(input, clientIp(req), token(req), context);
    res.setHeader('Set-Cookie', loginCookies(result));
    return json(res, action === 'register' ? 201 : 200, { user: result.user, cooldownSeconds: AUTH_COOLDOWN_SECONDS });
  } catch (error) { failure(res, error); }
}
