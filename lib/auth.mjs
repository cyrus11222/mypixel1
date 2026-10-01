import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;
export const AUTH_COOLDOWN_SECONDS = 60;
export const GAME_BINDING_LOCK_MS = 30 * 24 * 60 * 60 * 1000;
export const COMMUNITY_AGREEMENT_VERSION = '2026-10-01-v1';
export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function normalizeGameId(value) {
  if (typeof value !== 'string' || /\p{C}/u.test(value)) throw new AuthError(400, '请输入完整游戏 ID：3–32 个字符，可包含文字、数字、空格、下划线、点或连字符。');
  const gameId = value.trim().normalize('NFC');
  if ([...gameId].length < 3 || [...gameId].length > 32 || !/^[\p{L}\p{N} _.\-]+$/u.test(gameId)) throw new AuthError(400, '请输入完整游戏 ID：3–32 个字符，可包含文字、数字、空格、下划线、点或连字符。');
  return gameId;
}
export const gameIdKey = gameId => gameId.toLowerCase().normalize('NFC');
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
    const account = typeof username === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(username.trim()) ? username.trim().toLowerCase() : null;
    const buckets = [{ key: keyed('ip:' + ip), max: 25 }];
    const cooldownKeys = [keyed('auth-cooldown-ip:' + ip)];
    if (account) {
      buckets.push({ key: keyed('account:' + account), max: 10 });
      cooldownKeys.push(keyed('auth-cooldown-account:' + account));
    }
    if (action === 'register') buckets.push({ key: keyed('register:' + ip), max: 5 });
    await this.store.mutate(db => {
      const now = this.now();
      db.limits = db.limits.filter(l => l.resetAt > now);
      if (db.limits.length > 2000) throw new AuthError(429, '请求繁忙，请稍后再试。');
      const cooldownUntil = Math.max(0, ...db.limits.filter(l => cooldownKeys.includes(l.key)).map(l => l.resetAt));
      if (cooldownUntil > now) {
        const error = new AuthError(429, `请等待 ${Math.ceil((cooldownUntil - now) / 1000)} 秒后再登录或注册。`);
        error.code = 'AUTH_COOLDOWN'; error.retryAfterSeconds = Math.ceil((cooldownUntil - now) / 1000); throw error;
      }
      for (const b of buckets) {
        const l = db.limits.find(l => l.key === b.key);
        if (l && l.count >= b.max) {
          const error = new AuthError(429, '尝试次数过多，请稍后再试。');
          error.retryAfterSeconds = Math.ceil((l.resetAt - now) / 1000); throw error;
        }
      }
      for (const key of cooldownKeys) db.limits.push({ key, count: 1, resetAt: now + AUTH_COOLDOWN_SECONDS * 1000 });
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
  publicUser(user) {
    return {
      username: user.username,
      gameBinding: user.gameBinding ? { gameId: user.gameBinding.gameId, boundAt: user.gameBinding.boundAt, lockedUntil: user.gameBinding.lockedUntil } : null,
      developerCommunity: user.developerCommunity ? { joinedAt: user.developerCommunity.joinedAt, agreementVersion: user.developerCommunity.agreementVersion } : null
    };
  }
  clean(db) { for (const u of db.users) u.sessions = u.sessions.filter(s => s.expiresAt > this.now()); }
  async register(body, ip) {
    await this.limit(ip, body?.username, 'register');
    const { username, password, remember } = this.validate(body);
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
    await this.limit(ip, body?.username, 'login');
    const { username, password, remember } = this.validate(body);
    const user = (await this.store.read()).users.find(u => u.key === username.toLowerCase());
    const valid = await verifyPassword(password, user?.passwordHash || await this.dummy);
    if (!user || !valid) throw new AuthError(401, '用户名或密码不正确。');
    const session = this.newSession(remember);
    const publicUser = await this.store.mutate(db => {
      const current = db.users.find(u => u.id === user.id && u.passwordHash === user.passwordHash);
      if (!current) throw new AuthError(401, '账户已变更，请重新登录。');
      this.clean(db);
      current.sessions = current.sessions.filter(s => s.hash !== tokenHash(previousToken || '')).slice(-9);
      current.sessions.push({ hash: session.hash, expiresAt: session.expiresAt });
      return this.publicUser(current);
    });
    return { user: publicUser, token: session.token, remember };
  }
  sessionUser(db, token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError(401, '请先登录后再操作。');
    const hash = tokenHash(token);
    const user = db.users.find(u => u.sessions.some(s => s.hash === hash && s.expiresAt > this.now()));
    if (!user) throw new AuthError(401, '登录已失效，请重新登录。');
    return user;
  }
  ensureBindingUnlocked(user) {
    if (user.gameBinding && this.now() < user.gameBinding.lockedUntil) throw new AuthError(409, `游戏账号绑定后 30 天内不可修改或删除，可于 ${new Date(user.gameBinding.lockedUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）操作。`);
  }
  async bindGame(token, body) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      const gameId = normalizeGameId(body?.gameId); const key = gameIdKey(gameId);
      // This stores a player's declaration; it is not proof of Minecraft ownership.
      if (user.gameBinding?.key === key) return this.publicUser(user);
      this.ensureBindingUnlocked(user);
      if (db.users.some(other => other.id !== user.id && other.gameBinding?.key === key)) throw new AuthError(409, '这个游戏 ID 已绑定其他网站账户，请检查完整游戏 ID。');
      const now = this.now();
      user.gameBinding = { gameId, key, boundAt: now, lockedUntil: now + GAME_BINDING_LOCK_MS };
      user.developerCommunity = null;
      return this.publicUser(user);
    });
  }
  async unbindGame(token) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      this.ensureBindingUnlocked(user);
      user.gameBinding = null; user.developerCommunity = null;
      return this.publicUser(user);
    });
  }
  async joinCommunity(token, body) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      if (!user.gameBinding) throw new AuthError(409, '请先在用户中心绑定游戏账号，再加入玩家开发者社区。');
      if (body?.accepted !== true || body?.agreementVersion !== COMMUNITY_AGREEMENT_VERSION) throw new AuthError(400, '请阅读并同意当前版本的玩家开发者社区协议。');
      if (user.developerCommunity?.agreementVersion === COMMUNITY_AGREEMENT_VERSION) return this.publicUser(user);
      user.developerCommunity = { joinedAt: this.now(), agreementVersion: COMMUNITY_AGREEMENT_VERSION };
      return this.publicUser(user);
    });
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
    try {
      await this.store.mutate(db => {
        // Recheck on every CAS retry so invalid or expired sessions never write.
        this.sessionUser(db, token);
        this.clean(db);
        for (const user of db.users) user.sessions = user.sessions.filter(session => session.hash !== hash);
      });
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) return;
      throw error;
    }
  }
}
