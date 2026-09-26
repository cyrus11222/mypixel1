import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;
export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, OPTIONS);
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const pieces = encoded.split('$');
  const candidate = await scrypt(password, Buffer.from(pieces[4], 'hex'), 64, OPTIONS);
  return timingSafeEqual(candidate, Buffer.from(pieces[5], 'hex'));
}
export class AuthService {
  constructor(store, { now = Date.now, rateSecret } = {}) {
    if (!rateSecret || rateSecret.length < 32) throw new Error('RATE_LIMIT_SECRET must contain at least 32 characters.');
    this.store = store; this.now = now; this.rateSecret = rateSecret;
    this.dummy = hashPassword(randomBytes(32).toString('hex'));
  }
  validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(body.username.trim()) ||
        typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128 ||
        typeof body.remember !== 'boolean') throw new AuthError(400, '用户名需为 3–20 位字母、数字或下划线；密码需为 10–128 个字符。');
    return { username: body.username.trim(), password: body.password, remember: body.remember };
  }
  async limit(ip, username, action) {
    const keyed = text => createHmac('sha256', this.rateSecret).update(text).digest('hex');
    const buckets = [{ key: keyed('ip:' + ip), max: 25 }, { key: keyed('account:' + username.toLowerCase()), max: 10 }];
    if (action === 'register') buckets.push({ key: keyed('register:' + ip), max: 5 });
    const now = this.now();
    await this.store.mutate(db => {
      db.limits = db.limits.filter(l => l.resetAt > now);
      if (db.limits.length > 2000) throw new AuthError(429, '请求繁忙，请稍后再试。');
      for (const b of buckets) {
        const l = db.limits.find(l => l.key === b.key);
        if (l && l.count >= b.max) throw new AuthError(429, '尝试次数过多，请 15 分钟后再试。');
      }
      for (const b of buckets) {
        let l = db.limits.find(l => l.key === b.key);
        if (!l) { l = { key: b.key, count: 0, resetAt: now + 900_000 }; db.limits.push(l); }
        l.count++;
      }
    });
  }
  newSession(remember) {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: tokenHash(token), expiresAt: this.now() + (remember ? REMEMBER_SECONDS : SESSION_SECONDS) * 1000 };
  }
  publicUser(user) { return { username: user.username }; }
  clean(db) { for (const u of db.users) u.sessions = u.sessions.filter(s => s.expiresAt > this.now()); }
  async register(body, ip) {
    const { username, password, remember } = this.validate(body);
    await this.limit(ip, username, 'register');
    const key = username.toLowerCase(); const passwordHash = await hashPassword(password);
    const session = this.newSession(remember);
    const user = { id: randomUUID(), username, key, passwordHash, createdAt: new Date(this.now()).toISOString(), sessions: [{ hash: session.hash, expiresAt: session.expiresAt }] };
    await this.store.mutate(db => {
      if (db.users.some(u => u.key === key)) throw new AuthError(409, '该用户名已被使用，请选择其他用户名或登录。');
      this.clean(db); db.users.push(user);
    });
    return { user: this.publicUser(user), token: session.token, remember };
  }
  async login(body, ip, previousToken) {
    const { username, password, remember } = this.validate(body);
    await this.limit(ip, username, 'login');
    const user = (await this.store.read()).users.find(u => u.key === username.toLowerCase());
    const valid = await verifyPassword(password, user?.passwordHash || await this.dummy);
    if (!user || !valid) throw new AuthError(401, '用户名或密码不正确。');
    const session = this.newSession(remember);
    await this.store.mutate(db => {
      const current = db.users.find(u => u.id === user.id && u.passwordHash === user.passwordHash);
      if (!current) throw new AuthError(401, '账户已变更，请重新登录。');
      this.clean(db);
      current.sessions = current.sessions.filter(s => s.hash !== tokenHash(previousToken || '')).slice(-9);
      current.sessions.push({ hash: session.hash, expiresAt: session.expiresAt });
    });
    return { user: this.publicUser(user), token: session.token, remember };
  }
  async session(token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = tokenHash(token);
    const user = (await this.store.read()).users.find(u => u.sessions.some(s => s.hash === hash && s.expiresAt > this.now()));
    return user ? this.publicUser(user) : null;
  }
  async logout(token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const hash = tokenHash(token);
    await this.store.mutate(db => { this.clean(db); for (const u of db.users) u.sessions = u.sessions.filter(s => s.hash !== hash); });
  }
}
