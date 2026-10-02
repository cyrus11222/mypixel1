import { GitHubStore, LocalStore } from './store.mjs';
import { AuthService, AuthError, REMEMBER_SECONDS, PASSWORD_HASH_PATTERN } from './auth.mjs';
import path from 'node:path';
import { SITE_ORIGIN } from './site-config.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
let service;
export class ConfigError extends AuthError {
  constructor(code, names, message) { super(503, message); this.code = code; this.names = names; }
}
export function cookieSettings() {
  const local = !process.env.VERCEL && process.env.AUTH_STORE === 'local';
  return { local, cookieName: local ? 'mypixel_session' : '__Host-mypixel_session' };
}
export function settings() {
  const { local, cookieName } = cookieSettings();
  const origin = process.env.APP_ORIGIN?.trim() || (local ? 'http://127.0.0.1:3000' : SITE_ORIGIN);
  let url; try { url = new URL(origin); } catch { /* Report only the variable name, never its value. */ }
  if (!url || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname) ||
      !['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:')) {
    throw new ConfigError('AUTH_CONFIG_INVALID', ['APP_ORIGIN'], '官网域名配置不正确：请服主在 Vercel 将 APP_ORIGIN 设为完整 HTTPS 域名（不含页面路径），然后重新部署。');
  }
  return { local, origin: url.origin, cookieName };
}
export function authService() {
  if (!service) {
    const { local } = settings();
    const required = local ? ['RATE_LIMIT_SECRET'] : ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN', 'RATE_LIMIT_SECRET', 'DATA_ENCRYPTION_KEY'];
    const missing = required.filter(name => !process.env[name]?.trim());
    if (missing.length) throw new ConfigError('AUTH_CONFIG_MISSING', missing, `账户服务尚未配置：请服主在 Vercel 填写 ${missing.join('、')} 并重新部署。`);
    if (process.env.RATE_LIMIT_SECRET.trim().length < 32) throw new ConfigError('AUTH_CONFIG_INVALID', ['RATE_LIMIT_SECRET'], '账户服务密钥配置不正确：RATE_LIMIT_SECRET 至少需要 32 个随机字符，请服主修改后重新部署。');
    if (!local && !/^[a-f0-9]{64}$/i.test(process.env.DATA_ENCRYPTION_KEY.trim())) throw new ConfigError('AUTH_CONFIG_INVALID', ['DATA_ENCRYPTION_KEY'], '账户加密密钥配置不正确：DATA_ENCRYPTION_KEY 需要 64 位十六进制随机字符，请服主修改后重新部署。');
    for (const name of ['ADMIN_PASSWORD_HASH', 'ADMIN_EXECUTION_KEY_HASH']) {
      if (process.env[name]?.trim() && !PASSWORD_HASH_PATTERN.test(process.env[name].trim())) throw new ConfigError('AUTH_CONFIG_INVALID', [name], `${name} 格式不正确，请使用提供的 scrypt 哈希值。`);
    }
    const store = local ? new LocalStore(path.resolve(process.env.LOCAL_DATA_FILE || 'data/user.txt')) : new GitHubStore({
      owner: process.env.GITHUB_OWNER.trim(), repo: process.env.GITHUB_REPO.trim(),
      branch: process.env.GITHUB_BRANCH?.trim() || 'main', token: process.env.GITHUB_TOKEN.trim(),
      encryptionKey: process.env.DATA_ENCRYPTION_KEY.trim()
    });
    service = new AuthService(store, { rateSecret: process.env.RATE_LIMIT_SECRET.trim(), adminPasswordHash: process.env.ADMIN_PASSWORD_HASH?.trim(), adminExecutionKeyHash: process.env.ADMIN_EXECUTION_KEY_HASH?.trim() });
  }
  return service;
}
export function token(req) {
  const name = cookieSettings().cookieName;
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  const candidate = value ? value.slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(candidate) ? candidate : '';
}
export function cookie(value, remember, clear = false) {
  const { local, cookieName } = cookieSettings();
  return `${cookieName}=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}${clear ? '; Max-Age=0' : remember ? `; Max-Age=${REMEMBER_SECONDS}` : ''}`;
}
function cookieValue(req, name) {
  const found = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : '';
}
function auxiliaryName(name) { return `${cookieSettings().local ? '' : '__Host-'}mypixel_${name}`; }
function deviceSignature(value) { return createHmac('sha256', process.env.RATE_LIMIT_SECRET?.trim() || '').update(`device-cookie:${value}`).digest('base64url'); }
export function device(req) {
  if (!process.env.RATE_LIMIT_SECRET?.trim()) return '';
  const value = cookieValue(req, auxiliaryName('device'));
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)) return '';
  const [candidate, signature] = value.split('.');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(deviceSignature(candidate))) ? candidate : '';
}
export function deviceCookie(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid internal device token.');
  return `${auxiliaryName('device')}=${value}.${deviceSignature(value)}; Path=/; HttpOnly; SameSite=Lax${cookieSettings().local ? '' : '; Secure'}; Max-Age=31536000`;
}
export function loginCookies(result) { return [cookie(result.token, result.remember), deviceCookie(result.deviceToken)]; }
export function passkeyBinding(req) {
  const value = cookieValue(req, auxiliaryName('passkey'));
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
export function passkeyCookie(value, clear = false) {
  if (!clear && !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid internal passkey binding.');
  return `${auxiliaryName('passkey')}=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Strict${cookieSettings().local ? '' : '; Secure'}; Max-Age=${clear ? 0 : 300}`;
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
  const retryAfterSeconds = status === 429 ? Math.max(1, Math.ceil(Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : 900)) : undefined;
  if (retryAfterSeconds) res.setHeader('Retry-After', String(retryAfterSeconds));
  // Log only allowlisted codes/variable names, never error stacks or raw values.
  const code = error.code || (status === 503 ? 'AUTH_SERVICE_UNAVAILABLE' : 'AUTH_REQUEST_REJECTED');
  if (status === 503) console.error('Account service unavailable:', JSON.stringify({ code, ...(error instanceof ConfigError ? { fields: error.names } : {}) }));
  const message = error instanceof AuthError ? error.message : error.publicMessage || '账户服务暂不可用，请服主查看 Vercel 函数日志中的错误代码。';
  json(res, status, { error: message, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}), ...(error instanceof AuthError && error.code === 'ACCOUNT_BANNED' ? { ban: error.ban } : {}), ...(error instanceof ConfigError ? { fields: error.names } : {}) });
}
export function checkOrigin(req) {
  if (req.headers.origin !== settings().origin || req.headers['sec-fetch-site'] === 'cross-site') throw new AuthError(403, '请求来源不正确，请从官网重新进入。');
}
export async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AuthError(415, '请使用 JSON 请求。');
  if (Number(req.headers['content-length']) > 24576) throw new AuthError(413, '请求内容过长。');
  // Vercel pre-parses JSON; local development uses a Node stream.
  if (req.body !== undefined) {
    if (Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) > 24576) throw new AuthError(413, '请求内容过长。');
    try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { throw new AuthError(400, '请求格式不正确。'); }
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 24576) throw new AuthError(413, '请求内容过长。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AuthError(400, '请求格式不正确。'); }
}
export function clientIp(req) {
  // Forwarded addresses are trusted only on Vercel, where the platform sets them.
  return process.env.VERCEL ? String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim() : req.socket?.remoteAddress || 'local';
}
