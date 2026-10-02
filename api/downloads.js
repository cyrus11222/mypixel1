import { AuthError } from '../lib/auth.mjs';
import { authService, body, checkOrigin, common, failure, json, token } from '../lib/http.mjs';
import { createDownloadService } from '../lib/downloads.mjs';

export function createDownloadsHandler({ getService = () => createDownloadService(authService()), sessionToken = token, verifyOrigin = checkOrigin } = {}) {
  return async function downloads(req, res) {
    try {
      const url = new URL(req.url, 'https://local.invalid');
      const action = url.searchParams.get('action') || 'list';
      if (req.method === 'GET' && action === 'list') return json(res, 200, await getService().list());
      if (req.method === 'GET' && action === 'file') {
        const destination = await getService().download(url.searchParams.get('path'));
        common(res); res.statusCode = 302; res.setHeader('Location', destination); res.end(); return;
      }
      if (req.method === 'POST' && action === 'command') {
        verifyOrigin(req);
        const input = await body(req);
        return json(res, 200, await getService().command(sessionToken(req), input?.command));
      }
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); throw new AuthError(405, '不支持此请求方法。'); }
      throw new AuthError(404, '下载接口不存在。');
    } catch (error) { failure(res, error); }
  };
}

export default createDownloadsHandler();
