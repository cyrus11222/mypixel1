import { GitHubStore, LocalStore } from './store.mjs';
import { AuthService, AuthError, REMEMBER_SECONDS } from './auth.mjs';
import path from 'node:path';
let service;
export function settings() {
  const local = !process.env.VERCEL && process.env.AUTH_STORE === 'local';
  const origin = process.env.APP_ORIGIN || (local ? 'http://127.0.0.1:3000' : '');
  let url; try { url = new URL(origin); } catch { throw Error('APP_ORIGIN is required.'); }
  if (url.origin !== origin || (!local && url.protocol !== 'https:')) throw Error('APP_ORIGIN must be an exact HTTPS origin.');
  return { local, origin, cookieName: local ? 'mypixel_session' : '__Host-mypixel_session' };
}
export function authService() {
  if (!service) {
    const { local } = settings();
    const store = local ? new LocalStore(path.resolve(process.env.LOCAL_DATA_FILE || 'data/user.txt')) : new GitHubStore({
      owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO,
      branch: process.env.GITHUB_BRANCH || 'main', token: process.env.GITHUB_TOKEN
    });
    service = new AuthService(store, { rateSecret: process.env.RATE_LIMIT_SECRET });
  }
  return service;
}
export function token(req) {
  const name = settings().cookieName;
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return value ? value.slice(name.length + 1) : '';
}
export function cookie(value, remember, clear = false) {
  const { local, cookieName } = settings();
  return `${cookieName}=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}${clear ? '; Max-Age=0' : remember ? `; Max-Age=${REMEMBER_SECONDS}` : ''}`;
}
export function common(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}
export function json(res, status, body) {
  common(res); res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body));
}
export function failure(res, error) {
  const status = error instanceof AuthError ? error.status : 503;
  if (status === 429) res.setHeader('Retry-After', '900');
  // Never expose tokens, GitHub responses, account hashes or internal file paths.
  if (status === 503) console.error('Account service unavailable:', error.constructor.name);
  json(res, status, { error: status === 503 ? '账户服务暂不可用，请稍后重试或联系服主。' : error.message });
}
export function checkOrigin(req) {
  if (req.headers.origin !== settings().origin || req.headers['sec-fetch-site'] === 'cross-site') throw new AuthError(403, '请求来源不正确，请从官网重新进入。');
}
export async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AuthError(415, '请使用 JSON 请求。');
  if (Number(req.headers['content-length']) > 4096) throw new AuthError(413, '请求内容过长。');
  // Vercel pre-parses JSON; local development uses a Node stream.
  if (req.body !== undefined) {
    if (Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) > 4096) throw new AuthError(413, '请求内容过长。');
    try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { throw new AuthError(400, '请求格式不正确。'); }
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new AuthError(413, '请求内容过长。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AuthError(400, '请求格式不正确。'); }
}
export function clientIp(req) {
  // Forwarded addresses are trusted only on Vercel, where the platform sets them.
  return process.env.VERCEL ? String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim() : req.socket?.remoteAddress || 'local';
}
