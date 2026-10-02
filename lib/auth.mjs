import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { executionConfiguration, pendingExecution } from './ticket-execution.mjs';
import { reviewWindow } from './review-calendar.mjs';
const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;
export const AUTH_COOLDOWN_SECONDS = 60;
export const MAX_ACTIVE_SESSIONS = 50;
export const MAX_KNOWN_DEVICES = 100;
export const GAME_BINDING_LOCK_MS = 30 * 24 * 60 * 60 * 1000;
export const COMMUNITY_AGREEMENT_VERSION = '2026-10-02-v1';
export const RECOVERY_GRANT_SECONDS = 300;
export const ADMIN_USERNAME = 'admindevs';
export const PASSWORD_HASH_PATTERN = /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
export const DEFAULT_AGREEMENT = Object.freeze({
  version: COMMUNITY_AGREEMENT_VERSION, updatedAt: Date.parse('2026-10-02T00:00:00+08:00'),
  content: '玩家开发者协议：\n1. 加入玩家开发者社区不代表进入核心开发者社区\n2. 加入社区无解禁/免处罚功能 与普通玩家一样\n3. 开发者玩家不代表持久拥有op权限（含创造 日常游玩时均为生存模式[创造服除外]）\n4. 获得op 创造需向系统提交请求（系统工作日时仅晚上8：30-10：20可审核 休息日则全天都可审核{休息日参照成都市的}）\n5. 加入了玩家开发者社区不代表一定可以参加每年的PWDC(玩家开发者大会)，一切邀请决议最终解释权归Mypixel管理层所有\n6. 我们不允许任何形式的账户转借，出售及租赁行为，如有违反，我们会封禁您的开发者及社区账户和您的服务器登陆令牌\n7. 本协议一切最终解释权归Mypixel Club团队/SkyWolf Technology天狼科技所有'
});
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
export async function verifyPassword(password, encoded) {
  const pieces = encoded.split('$');
  const candidate = await scrypt(password, Buffer.from(pieces[4], 'hex'), 64, OPTIONS);
  return timingSafeEqual(candidate, Buffer.from(pieces[5], 'hex'));
}
export class AuthService {
  constructor(store, { now = Date.now, rateSecret, adminPasswordHash, adminExecutionKeyHash } = {}) {
    if (!rateSecret || rateSecret.length < 32) throw new Error('RATE_LIMIT_SECRET must contain at least 32 characters.');
    this.store = store; this.now = now; this.rateSecret = rateSecret;
    if ((adminPasswordHash && !PASSWORD_HASH_PATTERN.test(adminPasswordHash)) || (adminExecutionKeyHash && !PASSWORD_HASH_PATTERN.test(adminExecutionKeyHash))) throw new Error('Invalid administrator hash configuration.');
    this.adminPasswordHash = adminPasswordHash || null; this.adminExecutionKeyHash = adminExecutionKeyHash || null;
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
  publicUser(user, sessionToken) {
    const sessionHash = sessionToken ? tokenHash(sessionToken) : null;
    return {
      username: user.username,
      recovery: this.recoveryStatus(user),
      phone: user.phone || null,
      role: this.isAdmin(user) ? 'admin' : 'player',
      permissions: { adminCommands: this.isAdmin(user), reviewTickets: this.isAdmin(user) || user.ticketReviewer === true },
      notifications: (user.notifications || []).filter(notification => !notification.targetSessionHashes || notification.targetSessionHashes.includes(sessionHash)).map(({ id, type, message, createdAt, ticketId }) => ({ id, type, message, createdAt, ...(ticketId ? { ticketId } : {}) })),
      gameBinding: user.gameBinding ? { gameId: user.gameBinding.gameId, boundAt: user.gameBinding.boundAt, lockedUntil: user.gameBinding.lockedUntil } : null,
      developerCommunity: user.developerCommunity ? { joinedAt: user.developerCommunity.joinedAt, agreementVersion: user.developerCommunity.agreementVersion } : null
    };
  }
  clean(db) { for (const u of db.users) u.sessions = u.sessions.filter(s => s.expiresAt > this.now()); }
  async register(body, ip, context = {}) {
    await this.limit(ip, body?.username, 'register');
    const { username, password, remember } = this.validate(body);
    if (username.toLowerCase() === ADMIN_USERNAME) throw new AuthError(409, '此用户名为系统管理员保留，不能注册。');
    const key = username.toLowerCase(); const passwordHash = await hashPassword(password);
    const session = this.newSession(remember);
    const deviceToken = this.normalizeDeviceToken(context.deviceToken);
    const user = { id: randomUUID(), username, key, passwordHash, createdAt: new Date(this.now()).toISOString(), sessions: [] };
    const deviceHash = this.deviceHash(user.id, deviceToken);
    user.sessions.push({ hash: session.hash, expiresAt: session.expiresAt, deviceHash, remember });
    user.devices = [{ hash: deviceHash, label: this.deviceLabel(context.userAgent), createdAt: this.now(), lastSeenAt: this.now() }];
    await this.store.mutate(db => {
      if (db.users.some(u => u.key === key)) throw new AuthError(409, '该用户名已被使用，请选择其他用户名或登录。');
      this.clean(db); db.users.push(user);
    });
    return { user: this.publicUser(user, session.token), token: session.token, remember, deviceToken };
  }
  async login(body, ip, previousToken, context = {}) {
    await this.limit(ip, body?.username, 'login');
    const { username, password, remember } = this.validate(body);
    if (username.toLowerCase() === ADMIN_USERNAME) return this.loginAdmin(password, remember, previousToken, context);
    const user = (await this.store.read()).users.find(u => u.key === username.toLowerCase());
    const valid = await verifyPassword(password, user?.passwordHash || await this.dummy);
    if (!user || !valid) throw new AuthError(401, '用户名或密码不正确。');
    return this.finishAuthenticatedLogin(user.id, { ...context, previousToken, remember, expectedPasswordHash: user.passwordHash });
  }
  sessionUser(db, token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError(401, '请先登录后再操作。');
    const hash = tokenHash(token);
    const user = db.users.find(u => u.sessions.some(s => s.hash === hash && s.expiresAt > this.now()));
    if (!user) throw new AuthError(401, '登录已失效，请重新登录。');
    if (user.key === ADMIN_USERNAME && !this.isAdmin(user)) throw new AuthError(401, '管理员登录已失效，请重新登录。');
    this.checkBan(user);
    return user;
  }
  ensureBindingUnlocked(user) {
    if (user.gameBinding && this.now() < user.gameBinding.lockedUntil) throw new AuthError(409, `游戏账号绑定后 30 天内不可修改或删除，可于 ${new Date(user.gameBinding.lockedUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）操作。`);
  }
  async bindGame(token, body) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      this.requirePlayer(user);
      this.requireRecovery(user);
      const gameId = normalizeGameId(body?.gameId); const key = gameIdKey(gameId);
      // This stores a player's declaration; it is not proof of Minecraft ownership.
      if (user.gameBinding?.key === key) return this.publicUser(user, token);
      this.ensureBindingUnlocked(user);
      if (db.users.some(other => other.id !== user.id && other.gameBinding?.key === key)) throw new AuthError(409, '这个游戏 ID 已绑定其他网站账户，请检查完整游戏 ID。');
      const now = this.now();
      user.gameBinding = { gameId, key, boundAt: now, lockedUntil: now + GAME_BINDING_LOCK_MS };
      user.developerCommunity = null;
      return this.publicUser(user, token);
    });
  }
  async unbindGame(token) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      this.requirePlayer(user);
      this.requireRecovery(user);
      this.ensureBindingUnlocked(user);
      user.gameBinding = null; user.developerCommunity = null;
      return this.publicUser(user, token);
    });
  }
  async joinCommunity(token, body) {
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      this.requirePlayer(user);
      this.requireRecovery(user);
      const agreement = this.agreement(db);
      if (!user.gameBinding) throw new AuthError(409, '请先在用户中心绑定游戏账号，再加入玩家开发者社区。');
      if (body?.accepted !== true || body?.agreementVersion !== agreement.version) throw new AuthError(400, '协议已更新，请重新阅读并同意当前版本的玩家开发者社区协议。');
      if (user.developerCommunity?.agreementVersion === agreement.version) return this.publicUser(user, token);
      user.developerCommunity = { joinedAt: this.now(), agreementVersion: agreement.version };
      return this.publicUser(user, token);
    });
  }
  async session(token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    try { return this.publicUser(this.sessionUser(await this.store.read(), token), token); }
    catch (error) { if (error instanceof AuthError && error.status === 401) return null; throw error; }
  }
  isAdmin(user) {
    return Boolean(this.adminPasswordHash && user.key === ADMIN_USERNAME && user.role === 'admin' &&
      user.passwordHash === this.adminPasswordHash && user.adminCredentialHash === tokenHash(this.adminPasswordHash));
  }
  requireAdmin(user) { if (!this.isAdmin(user)) throw new AuthError(403, '仅系统管理员可执行此操作。'); }
  requirePlayer(user) { if (this.isAdmin(user)) throw new AuthError(403, '管理员账户不能绑定游戏账号或加入玩家开发者社区。'); }
  requireReviewer(user) { if (!this.isAdmin(user) && user.ticketReviewer !== true) throw new AuthError(403, '需要工单管理员权限。'); }
  activeBan(user) { return user.ban && (user.ban.until === null || user.ban.until > this.now()) ? user.ban : null; }
  checkBan(user) {
    const ban = this.activeBan(user); if (!ban) return;
    const until = ban.until === null ? '永久封禁' : `${new Date(ban.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）解禁`;
    const error = new AuthError(403, `此账户已被封禁：${until}。原因：${ban.reason}`);
    error.code = 'ACCOUNT_BANNED'; error.ban = { reason: ban.reason, until: ban.until, createdAt: ban.createdAt }; throw error;
  }
  async loginAdmin(password, remember, previousToken, context = {}) {
    if (!this.adminPasswordHash) {
      const error = new AuthError(503, '管理员登录尚未配置：请在 Vercel 的 Production 环境导入 ADMIN_PASSWORD_HASH，保存后重新部署（Redeploy）。本地预览请加载包含该变量的环境配置文件。');
      error.code = 'ADMIN_NOT_CONFIGURED';
      throw error;
    }
    const valid = await verifyPassword(password, this.adminPasswordHash);
    if (!valid) throw new AuthError(401, '用户名或密码不正确。');
    const userId = await this.store.mutate(db => {
      let admin = db.users.find(user => user.key === ADMIN_USERNAME);
      if (!admin) { admin = { id: randomUUID(), username: ADMIN_USERNAME, key: ADMIN_USERNAME, createdAt: new Date(this.now()).toISOString() }; db.users.push(admin); }
      if (!this.isAdmin(admin)) {
        // A credential rotation or first bootstrap invalidates old sessions and
        // passkeys. Normal logins preserve other devices and pending notices.
        const previouslyAdmin = admin.role === 'admin' && admin.adminCredentialHash === tokenHash(admin.passwordHash || '');
        Object.assign(admin, {
          username: ADMIN_USERNAME, passwordHash: this.adminPasswordHash, role: 'admin',
          adminCredentialHash: tokenHash(this.adminPasswordHash), sessions: [], devices: [], passkeys: [],
          gameBinding: null, developerCommunity: null, ban: null, ticketReviewer: false,
          recoveryCode: null, pendingRecoveryCode: null, phone: previouslyAdmin ? (admin.phone || null) : null,
          notifications: previouslyAdmin ? (admin.notifications || []).filter(item => !item.targetSessionHashes) : []
        });
        if (db.passkeyChallenges) db.passkeyChallenges = db.passkeyChallenges.filter(challenge => challenge.userId !== admin.id);
      }
      return admin.id;
    });
    return this.finishAuthenticatedLogin(userId, { ...context, previousToken, remember, expectedPasswordHash: this.adminPasswordHash });
  }
  accountStamp(user) { return tokenHash(user.passwordHash); }
  normalizeDeviceToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : randomBytes(32).toString('base64url'); }
  deviceHash(userId, deviceToken) { return createHmac('sha256', this.rateSecret).update(`device:${userId}:${deviceToken}`).digest('hex'); }
  deviceLabel(agent = '') {
    const ua = typeof agent === 'string' ? agent.slice(0, 512) : '';
    const os = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '设备';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
    return `${os} · ${browser}`;
  }
  async finishAuthenticatedLogin(userId, { previousToken, deviceToken: candidate, userAgent, remember = false, expectedPasswordHash, authorize } = {}) {
    const deviceToken = this.normalizeDeviceToken(candidate); const session = this.newSession(remember);
    const result = await this.store.mutate(async db => {
      const user = db.users.find(user => user.id === userId);
      if (!user || (expectedPasswordHash && user.passwordHash !== expectedPasswordHash) || (user.key === ADMIN_USERNAME && !this.isAdmin(user))) throw new AuthError(401, '账户验证已失效，请重新登录。');
      // WebAuthn performs its cryptographic check here and consumes its challenge
      // atomically with the new session. CAS conflicts repeat authorization.
      if (authorize) await authorize(db, user);
      this.checkBan(user);
      this.clean(db);
      const hash = this.deviceHash(user.id, deviceToken); const previousHash = tokenHash(previousToken || '');
      const previousSession = user.sessions.find(item => item.hash === previousHash);
      // An existing HttpOnly session cookie identifies the current browser even
      // if its longer-lived device cookie was cleared or has just been added.
      const sameBrowser = Boolean(previousSession);
      const remainingSessions = user.sessions.filter(item => !sameBrowser || item.hash !== previousHash);
      if (remainingSessions.length >= MAX_ACTIVE_SESSIONS) throw new AuthError(409, '此账户已达到 50 个同时登录会话，请先退出其他设备后再登录。现有设备不会被退出。');
      user.devices = (user.devices || []).filter(device => device.lastSeenAt > this.now() - 365 * 86_400_000);
      let device = user.devices.find(item => item.hash === hash);
      if (!device) {
        if (user.devices.length >= MAX_KNOWN_DEVICES) throw new AuthError(409, '已记录的设备数量达到上限，请联系管理员处理；现有会话未受影响。');
        device = { hash, label: this.deviceLabel(userAgent), createdAt: this.now(), lastSeenAt: this.now() }; user.devices.push(device);
      } else device.lastSeenAt = this.now();
      if (!sameBrowser && remainingSessions.length) {
        user.notifications ||= [];
        user.notifications.push({ id: randomUUID(), type: 'new-device', message: `您的账户刚刚在 ${this.deviceLabel(userAgent)} 发起了新的登录。如非本人操作，请及时联系管理员。`, createdAt: this.now(), targetSessionHashes: remainingSessions.map(item => item.hash) });
        user.notifications = user.notifications.slice(-100);
      }
      user.sessions = [...remainingSessions, { hash: session.hash, expiresAt: session.expiresAt, deviceHash: hash, remember }];
      return this.publicUser(user, session.token);
    });
    return { user: result, token: session.token, remember, deviceToken };
  }
  async reauthenticate(token, password, ip = 'unknown') {
    const user = this.sessionUser(await this.store.read(), token);
    const keys = [`reauth-user:${user.id}`, `reauth-ip:${ip}`].map(text => createHmac('sha256', this.rateSecret).update(text).digest('hex'));
    await this.store.mutate(db => {
      const current = this.sessionUser(db, token);
      if (current.passwordHash !== user.passwordHash) throw new AuthError(401, '账户验证已失效，请重新登录。');
      const now = this.now(); db.limits = db.limits.filter(item => item.resetAt > now);
      for (const key of keys) {
        const limit = db.limits.find(item => item.key === key);
        if (limit && limit.count >= 10) { const error = new AuthError(429, '密码验证次数过多，请稍后重试。'); error.retryAfterSeconds = Math.ceil((limit.resetAt - now) / 1000); throw error; }
      }
      for (const key of keys) { let limit = db.limits.find(item => item.key === key); if (!limit) { limit = { key, count: 0, resetAt: now + 900_000 }; db.limits.push(limit); } limit.count++; }
    });
    if (typeof password !== 'string' || password.length < 10 || password.length > 128 || !await verifyPassword(password, user.passwordHash)) {
      const error = new AuthError(403, '密码验证失败，请检查后重试。'); error.code = 'REAUTH_FAILED'; throw error;
    }
    return { userId: user.id, passwordHash: user.passwordHash, accountStamp: this.accountStamp(user) };
  }
  recoveryStatus(user) {
    const hasPasskey = (user.passkeys || []).some(key => key.credentialVersion === this.accountStamp(user));
    const hasRecoveryCode = Boolean(user.recoveryCode?.hash && Number.isSafeInteger(user.recoveryCode.confirmedAt));
    const adminManaged = this.isAdmin(user);
    return { required: !adminManaged && !hasPasskey && !hasRecoveryCode, hasPasskey, hasRecoveryCode,
      codePending: Boolean(user.pendingRecoveryCode && user.pendingRecoveryCode.expiresAt > this.now()), adminManaged };
  }
  requireRecovery(user) {
    if (this.recoveryStatus(user).required) {
      const error = new AuthError(403, '请先在用户中心设置通行密钥，或生成并确认保存一次性恢复码。'); error.code = 'RECOVERY_SETUP_REQUIRED'; throw error;
    }
  }
  recoveryDigest(kind, userId, value) { return createHmac('sha256', this.rateSecret).update(JSON.stringify([kind, userId, value])).digest('hex'); }
  requireWebPasswordAccount(user) {
    if (user.key === ADMIN_USERNAME) {
      const error = new AuthError(403, '管理员密码由 Vercel 的 ADMIN_PASSWORD_HASH 管理，请在 Vercel 更新哈希并重新部署；网页不能修改或重置此密码。'); error.code = 'ADMIN_PASSWORD_MANAGED'; throw error;
    }
  }
  newPassword(value) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw new AuthError(400, '新密码需要 10–128 个字符。');
    return value;
  }
  assertPasswordProof(db, token, proof) {
    const user = this.sessionUser(db, token);
    if (user.id !== proof.userId || user.passwordHash !== proof.passwordHash) throw new AuthError(401, '账户验证已失效，请重新登录。');
    return user;
  }
  async generateRecoveryCode(token, input, ip) {
    const current = this.sessionUser(await this.store.read(), token); this.requireWebPasswordAccount(current);
    const proof = await this.reauthenticate(token, input?.currentPassword, ip);
    const recoveryCode = 'MPC-' + randomBytes(24).toString('base64url');
    const confirmationId = randomBytes(32).toString('base64url');
    await this.store.mutate(db => {
      const user = this.assertPasswordProof(db, token, proof); this.requireWebPasswordAccount(user);
      const createdAt = this.now();
      user.pendingRecoveryCode = { hash: this.recoveryDigest('code', user.id, recoveryCode), confirmationHash: this.recoveryDigest('confirmation', user.id, confirmationId), createdAt, expiresAt: createdAt + 600_000 };
    });
    return { recoveryCode, confirmationId, expiresInSeconds: 600 };
  }
  async confirmRecoveryCode(token, input) {
    if (typeof input?.confirmationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.confirmationId)) throw new AuthError(400, '恢复码保存确认已失效，请重新生成。');
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token); this.requireWebPasswordAccount(user);
      const pending = user.pendingRecoveryCode;
      const digest = this.recoveryDigest('confirmation', user.id, input.confirmationId);
      if (!pending || pending.expiresAt <= this.now() || !timingSafeEqual(Buffer.from(pending.confirmationHash, 'hex'), Buffer.from(digest, 'hex'))) throw new AuthError(400, '恢复码保存确认已失效，请重新生成。');
      user.recoveryCode = { hash: pending.hash, createdAt: pending.createdAt, confirmedAt: this.now() };
      user.pendingRecoveryCode = null;
      if (db.recoveryGrants) db.recoveryGrants = db.recoveryGrants.filter(grant => grant.userId !== user.id || !grant.proofRecoveryCodeHash);
      return this.publicUser(user, token);
    });
  }
  async securityLimit(ip, name, subject = '') {
    const keys = [this.recoveryDigest('security-limit', name, `ip:${ip}`), ...(subject ? [this.recoveryDigest('security-limit', name, `subject:${subject}`)] : [])];
    await this.store.mutate(db => {
      const now = this.now(); db.limits = db.limits.filter(item => item.resetAt > now);
      if (db.limits.length > 2000) throw new AuthError(429, '请求繁忙，请稍后再试。');
      for (const key of keys) {
        const limit = db.limits.find(item => item.key === key);
        if (limit && limit.count >= 10) { const error = new AuthError(429, '验证尝试过多，请稍后重试。'); error.retryAfterSeconds = Math.ceil((limit.resetAt - now) / 1000); throw error; }
      }
      for (const key of keys) { let limit = db.limits.find(item => item.key === key); if (!limit) { limit = { key, count: 0, resetAt: now + 900_000 }; db.limits.push(limit); } limit.count++; }
    });
  }
  invalidRecovery() {
    const error = new AuthError(400, '恢复凭据无效或已失效，请检查后重试。'); error.code = 'RECOVERY_INVALID'; return error;
  }
  async verifyRecoveryCode(input, ip) {
    const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
    await this.securityLimit(ip, 'recovery-code', /^[a-z0-9_]{3,20}$/.test(username) ? username : '');
    if ((username && !/^[a-z0-9_]{3,20}$/.test(username)) || typeof input?.code !== 'string') throw this.invalidRecovery();
    const code = input.code.trim(); if (!/^MPC-[A-Za-z0-9_-]{32}$/.test(code)) throw this.invalidRecovery();
    const snapshot = await this.store.read();
    const owner = snapshot.users.find(user => (!username || user.key === username) && user.recoveryCode &&
      timingSafeEqual(Buffer.from(user.recoveryCode.hash, 'hex'), Buffer.from(this.recoveryDigest('code', user.id, code), 'hex')));
    if (!owner) throw this.invalidRecovery();
    return this.finishRecoveryVerification(owner.id, { expectedPasswordHash: owner.passwordHash, proofRecoveryCodeHash: owner.recoveryCode.hash, authorize: (db, user) => {
      if (!user.recoveryCode || !timingSafeEqual(Buffer.from(user.recoveryCode.hash, 'hex'), Buffer.from(this.recoveryDigest('code', user.id, code), 'hex'))) throw this.invalidRecovery();
    } });
  }
  async finishRecoveryVerification(userId, { expectedPasswordHash, authorize, proofRecoveryCodeHash, proofPasskeyId } = {}) {
    const grantToken = randomBytes(32).toString('base64url');
    const result = await this.store.mutate(async db => {
      const user = db.users.find(user => user.id === userId);
      if (!user || (expectedPasswordHash && user.passwordHash !== expectedPasswordHash)) throw this.invalidRecovery();
      if (authorize) await authorize(db, user);
      this.requireWebPasswordAccount(user);
      // Recovery can secure a banned account, but never removes its ban or
      // creates an authenticated web session.
      const now = this.now();
      db.recoveryGrants = (db.recoveryGrants || []).filter(grant => grant.expiresAt > now && grant.userId !== user.id);
      if (db.recoveryGrants.length >= 500) throw new AuthError(429, '恢复请求繁忙，请稍后再试。');
      db.recoveryGrants.push({ hash: this.recoveryDigest('grant', '', grantToken), userId: user.id,
        accountStamp: this.accountStamp(user), createdAt: now, expiresAt: now + RECOVERY_GRANT_SECONDS * 1000,
        ...(proofRecoveryCodeHash ? { proofRecoveryCodeHash } : {}), ...(proofPasskeyId ? { proofPasskeyId } : {}) });
      return { username: user.username };
    });
    return { ...result, recoveryGranted: true, grantToken, expiresInSeconds: RECOVERY_GRANT_SECONDS };
  }
  validateRecoveryGrant(db, digest) {
    const grant = (db.recoveryGrants || []).find(item => item.hash === digest && item.expiresAt > this.now());
    const user = grant ? db.users.find(user => user.id === grant.userId) : null;
    if (!user || grant.accountStamp !== this.accountStamp(user)) throw this.invalidRecovery();
    if (grant.proofRecoveryCodeHash && grant.proofRecoveryCodeHash !== user.recoveryCode?.hash) throw this.invalidRecovery();
    if (grant.proofPasskeyId && !(user.passkeys || []).some(key => key.id === grant.proofPasskeyId && key.credentialVersion === grant.accountStamp)) throw this.invalidRecovery();
    this.requireWebPasswordAccount(user);
    return { grant, user };
  }
  async resetPassword(grantToken, input, context = {}) {
    if (typeof grantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grantToken)) throw this.invalidRecovery();
    const digest = this.recoveryDigest('grant', '', grantToken);
    const proof = this.validateRecoveryGrant(await this.store.read(), digest);
    await this.securityLimit(context.ip || 'unknown', 'password-reset', proof.user.id);
    const passwordHash = await hashPassword(this.newPassword(input?.newPassword));
    return this.store.mutate(db => {
      const { user } = this.validateRecoveryGrant(db, digest);
      user.passwordHash = passwordHash; user.sessions = []; user.passkeys = []; user.devices = [];
      user.recoveryCode = null; user.pendingRecoveryCode = null;
      user.notifications = (user.notifications || []).filter(item => !item.targetSessionHashes);
      this.notify(user, 'account', '密码已通过恢复方式重设，原登录会话、通行密钥及恢复码已失效。请重新设置恢复方式。');
      db.recoveryGrants = db.recoveryGrants.filter(item => item.userId !== user.id);
      if (db.passkeyChallenges) db.passkeyChallenges = db.passkeyChallenges.filter(item => item.userId !== user.id);
      return { ok: true, message: '密码已重设，请使用新密码登录，并重新设置恢复方式。' };
    });
  }
  async cancelRecovery(grantToken) {
    if (typeof grantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grantToken)) return;
    const digest = this.recoveryDigest('grant', '', grantToken);
    if (!(await this.store.read()).recoveryGrants?.some(grant => grant.hash === digest)) return;
    try {
      await this.store.mutate(db => {
        if (!db.recoveryGrants?.some(grant => grant.hash === digest)) throw this.invalidRecovery();
        db.recoveryGrants = db.recoveryGrants.filter(grant => grant.hash !== digest);
      });
    } catch (error) { if (error.code !== 'RECOVERY_INVALID') throw error; }
  }
  async changePassword(token, input, context = {}) {
    const snapshot = this.sessionUser(await this.store.read(), token); this.requireWebPasswordAccount(snapshot);
    const proof = await this.reauthenticate(token, input?.oldPassword, context.ip);
    const passwordHash = await hashPassword(this.newPassword(input?.newPassword));
    const deviceToken = this.normalizeDeviceToken(context.deviceToken);
    return this.store.mutate(db => {
      const user = this.assertPasswordProof(db, token, proof); this.requireWebPasswordAccount(user);
      const previous = user.sessions.find(session => session.hash === tokenHash(token));
      const remember = previous.remember ?? previous.expiresAt - this.now() > SESSION_SECONDS * 1000;
      const session = this.newSession(remember); const hash = this.deviceHash(user.id, deviceToken);
      user.passkeys = (user.passkeys || []).filter(credential => credential.credentialVersion === this.accountStamp(user));
      user.passwordHash = passwordHash;
      user.passkeyNotBefore = this.now();
      user.sessions = [{ hash: session.hash, expiresAt: session.expiresAt, deviceHash: hash, remember }];
      user.devices = [{ hash, label: this.deviceLabel(context.userAgent), createdAt: this.now(), lastSeenAt: this.now() }];
      for (const credential of user.passkeys || []) credential.credentialVersion = this.accountStamp(user);
      user.pendingRecoveryCode = null;
      user.notifications = (user.notifications || []).filter(item => !item.targetSessionHashes);
      this.notify(user, 'account', '密码已修改，其他设备已退出登录。已绑定的通行密钥和已保存恢复码仍可使用。');
      if (db.recoveryGrants) db.recoveryGrants = db.recoveryGrants.filter(item => item.userId !== user.id);
      if (db.passkeyChallenges) db.passkeyChallenges = db.passkeyChallenges.filter(item => item.userId !== user.id);
      return { user: this.publicUser(user, session.token), token: session.token, remember, deviceToken };
    });
  }
  async setPhone(token, input, ip) {
    const proof = await this.reauthenticate(token, input?.currentPassword, ip);
    if (typeof input?.phone !== 'string') throw new AuthError(400, '请输入手机号，或留空移除。');
    const value = input.phone.trim().replace(/[ ()-]/g, '');
    if (value && !/^\+?\d{6,15}$/.test(value)) throw new AuthError(400, '手机号应为 6–15 位数字，可带 + 国家码；留空可移除。');
    return this.store.mutate(db => {
      const user = this.assertPasswordProof(db, token, proof);
      user.phone = value || null;
      return this.publicUser(user, token);
    });
  }
  agreement(db) {
    const saved = db.settings?.devplayerAgreement;
    return saved?.baselineVersion === COMMUNITY_AGREEMENT_VERSION ? saved : { ...DEFAULT_AGREEMENT };
  }
  async publicConfig() {
    return { agreement: this.agreement(await this.store.read()), execution: executionConfiguration(), reviewWindow: reviewWindow(this.now()) };
  }
  notify(user, type, message, ticketId) {
    user.notifications ||= [];
    user.notifications.push({ id: randomUUID(), type, message, createdAt: this.now(), ...(ticketId ? { ticketId } : {}) });
    user.notifications = user.notifications.slice(-100);
  }
  async acknowledgeNotifications(token, input) {
    if (!Array.isArray(input?.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string' || id.length > 100)) throw new AuthError(400, '通知标识格式不正确。');
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token);
      const hash = tokenHash(token);
      user.notifications = (user.notifications || []).filter(notification => {
        if (!input.ids.includes(notification.id)) return true;
        if (!notification.targetSessionHashes) return false;
        notification.targetSessionHashes = notification.targetSessionHashes.filter(target => target !== hash);
        return notification.targetSessionHashes.length > 0;
      });
      return this.publicUser(user, token);
    });
  }
  text(value, name, min, max) {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new AuthError(400, `${name}格式不正确。`);
    const text = value.trim();
    if ([...text].length < min || [...text].length > max) throw new AuthError(400, `${name}需要 ${min}–${max} 个字符。`);
    return text;
  }
  parseCommand(value) {
    const command = this.text(value, '命令', 1, 6000);
    let match;
    if ((match = /^setintty\s+devplayer\s+([\s\S]+)$/.exec(command))) return { type: 'agreement', content: this.text(match[1], '协议内容', 1, 4000) };
    if (/[\r\n]/.test(command)) throw new AuthError(400, '每次仅能执行一条管理命令。');
    if ((match = /^ban\s+(inf|[1-9]\d{0,8}[smdy])\s+(.+)\s+([A-Za-z0-9_]{3,20})\s+(\S+)$/.exec(command))) {
      const duration = match[1] === 'inf' ? null : Number(match[1].slice(0, -1)) * { s: 1000, m: 60_000, d: 86_400_000, y: 31_536_000_000 }[match[1].at(-1)];
      if (duration !== null && duration > 100 * 31_536_000_000) throw new AuthError(400, '封禁时长最多 100 年；永久封禁请使用 inf。');
      return { type: 'ban', duration, reason: this.text(match[2], '封禁原因', 1, 300), username: match[3].toLowerCase(), executionKey: match[4] };
    }
    if ((match = /^unban\s+([A-Za-z0-9_]{3,20})$/.exec(command))) return { type: 'unban', username: match[1].toLowerCase() };
    if ((match = /^playerout\s+([A-Za-z0-9_]{3,20})\s+(\S+)$/.exec(command))) return { type: 'delete', username: match[1].toLowerCase(), executionKey: match[2] };
    if ((match = /^ztsset\s+(add|remove)\s+([A-Za-z0-9_]{3,20})$/.exec(command))) return { type: 'reviewer', grant: match[1] === 'add', username: match[2].toLowerCase() };
    throw new AuthError(400, '命令格式不正确，请查看控制台命令说明。');
  }
  async adminCommand(token, input) {
    const initial = this.sessionUser(await this.store.read(), token); this.requireAdmin(initial); this.requireRecovery(initial);
    const command = this.parseCommand(input?.command);
    if (command.executionKey) {
      if (!this.adminExecutionKeyHash) throw new AuthError(503, '执行密钥尚未配置，请设置 ADMIN_EXECUTION_KEY_HASH。');
      if (command.executionKey.length > 256 || !await verifyPassword(command.executionKey, this.adminExecutionKeyHash)) throw new AuthError(403, '执行密钥不正确。');
    }
    return this.store.mutate(db => {
      const admin = this.sessionUser(db, token); this.requireAdmin(admin); this.requireRecovery(admin);
      if (command.type === 'agreement') {
        const previous = this.agreement(db); const day = new Date(this.now()).toISOString().slice(0, 10);
        const revision = previous.version.startsWith(day + '-v') ? Number(previous.version.split('-v')[1]) + 1 : 1;
        if (revision > 99_999) throw new AuthError(409, '当日协议更新次数达到上限。');
        db.settings ||= {}; db.settings.devplayerAgreement = { content: command.content, version: `${day}-v${revision}`, updatedAt: this.now(), baselineVersion: COMMUNITY_AGREEMENT_VERSION };
        return { message: '玩家开发者社区协议已更新。后续加入需要同意最新版本。', agreement: db.settings.devplayerAgreement };
      }
      const target = db.users.find(user => user.key === command.username);
      if (!target) throw new AuthError(404, '目标账户不存在。');
      if (target.key === ADMIN_USERNAME) throw new AuthError(403, '不能通过管理命令修改或删除系统管理员账户。');
      if (command.type === 'ban') {
        target.ban = { reason: command.reason, createdAt: this.now(), until: command.duration === null ? null : this.now() + command.duration };
        target.sessions = [];
        return { message: `已封禁 ${target.username}，所有登录会话已撤销。` };
      }
      if (command.type === 'unban') { target.ban = null; this.notify(target, 'account', '您的账户封禁已解除，可以正常使用网站。'); return { message: `已解除 ${target.username} 的封禁。` }; }
      if (command.type === 'reviewer') {
        target.ticketReviewer = command.grant;
        this.notify(target, 'role', command.grant ? '您已获得工单管理员权限，可在工单中心审核工单。' : '您的工单管理员权限已被撤销。');
        return { message: `${target.username} 的工单管理员权限已${command.grant ? '添加' : '移除'}。` };
      }
      if (command.type === 'delete') {
        db.users = db.users.filter(user => user.id !== target.id);
        if (db.passkeyChallenges) db.passkeyChallenges = db.passkeyChallenges.filter(challenge => challenge.userId !== target.id);
        if (db.recoveryGrants) db.recoveryGrants = db.recoveryGrants.filter(grant => grant.userId !== target.id);
        for (const ticket of db.tickets || []) {
          if (ticket.userId === target.id) {
            Object.assign(ticket, { userId: null, username: '已删除账户', gameId: null, bindingAt: null, purpose: '账户已删除', details: {}, reviewNote: '账户已删除，工单已匿名化。' });
            if (ticket.status === 'pending') Object.assign(ticket, { status: 'rejected', reviewedAt: this.now(), reviewedBy: admin.username, reviewNote: '账户已删除，工单关闭。', execution: { status: 'not_requested', message: '账户已删除，未执行。' } });
            else ticket.execution = { status: 'not_requested', message: '账户已删除，停止待执行操作。' };
          }
          if (ticket.reviewedBy?.toLowerCase() === target.key) ticket.reviewedBy = '已删除账户';
        }
        return { message: `已永久删除 ${target.username} 的账户、绑定、社区身份和通知；相关工单已匿名化。` };
      }
    });
  }
  ticketPublic(ticket) {
    const { userId, bindingAt, ...safe } = ticket; return structuredClone(safe);
  }
  async listTickets(token, review = false) {
    const db = await this.store.read(); const user = this.sessionUser(db, token);
    if (review) this.requireReviewer(user);
    return (db.tickets || []).filter(ticket => review || ticket.userId === user.id).slice().reverse().map(ticket => this.ticketPublic(ticket));
  }
  ticketDetails(input) {
    if (!input || !['op', 'creative', 'materials'].includes(input.type)) throw new AuthError(400, '请选择正确的工单类型。');
    const purpose = this.text(input.purpose, '申请用途', 2, 1000); const details = {};
    if (input.type !== 'materials') {
      if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 525_600) throw new AuthError(400, '申请时长需要为 1–525600 分钟的整数。');
      details.durationMinutes = input.durationMinutes;
    }
    if (input.type === 'op') {
      if (!Number.isInteger(input.opLevel) || input.opLevel < 1 || input.opLevel > 4) throw new AuthError(400, 'OP 等级需要为 1–4。');
      details.opLevel = input.opLevel;
    }
    if (input.type === 'creative') details.world = this.text(input.world, '世界或服务器名称', 1, 80);
    if (input.type === 'materials') details.materials = this.text(input.materials, '物资及数量', 2, 1000);
    return { type: input.type, purpose, details };
  }
  async createTicket(token, input) {
    const payload = this.ticketDetails(input);
    return this.store.mutate(db => {
      const user = this.sessionUser(db, token); this.requirePlayer(user);
      this.requireRecovery(user);
      if (!user.gameBinding || !user.developerCommunity) throw new AuthError(403, '请先绑定游戏账号并加入玩家开发者社区，再提交工单。');
      if (user.developerCommunity.agreementVersion !== this.agreement(db).version) throw new AuthError(409, '社区协议已更新，请先重新同意最新协议。');
      db.tickets ||= [];
      if (db.tickets.filter(ticket => ticket.userId === user.id && ticket.status === 'pending').length >= 5) throw new AuthError(409, '您已有 5 个待审核工单，请等待处理后再提交。');
      const ticket = { id: randomUUID(), userId: user.id, username: user.username, gameId: user.gameBinding.gameId, bindingAt: user.gameBinding.boundAt, ...payload,
        createdAt: this.now(), status: 'pending', reviewedAt: null, reviewedBy: null, reviewNote: '',
        execution: { status: 'not_requested', message: '等待审核，尚未执行。' } };
      db.tickets.push(ticket); return this.ticketPublic(ticket);
    });
  }
  async reviewTicket(token, input) {
    if (typeof input?.ticketId !== 'string' || !['approved', 'rejected'].includes(input?.decision)) throw new AuthError(400, '工单审核参数不正确。');
    const note = this.text(input.note ?? '', '审核说明', 0, 1000);
    return this.store.mutate(db => {
      const reviewer = this.sessionUser(db, token); this.requireReviewer(reviewer);
      this.requireRecovery(reviewer);
      const window = reviewWindow(this.now()); if (!window.open) throw new AuthError(409, window.message);
      const ticket = (db.tickets || []).find(item => item.id === input.ticketId);
      if (!ticket) throw new AuthError(404, '工单不存在。');
      if (ticket.userId === reviewer.id) throw new AuthError(403, '不能审核自己提交的工单。');
      if (ticket.status !== 'pending') throw new AuthError(409, '此工单已被处理，请刷新列表。');
      const owner = db.users.find(user => user.id === ticket.userId);
      if (input.decision === 'approved' && (!owner || this.activeBan(owner) || this.recoveryStatus(owner).required || !owner.gameBinding || !owner.developerCommunity || owner.gameBinding.gameId !== ticket.gameId || owner.gameBinding.boundAt !== ticket.bindingAt || owner.developerCommunity.agreementVersion !== this.agreement(db).version)) throw new AuthError(409, '申请人的账户、游戏绑定或社区协议资格已发生变化，不能批准此工单。');
      Object.assign(ticket, { status: input.decision, reviewedAt: this.now(), reviewedBy: reviewer.username, reviewNote: note,
        execution: input.decision === 'approved' ? pendingExecution() : { status: 'not_requested', message: '审核未通过，未执行。' } });
      if (owner) this.notify(owner, 'ticket', `您的${{ op: 'OP', creative: '创造模式', materials: '物资' }[ticket.type]}申请已${input.decision === 'approved' ? '通过审核；服务器执行接口尚未接入，等待执行' : '被驳回'}。${note ? '审核说明：' + note : ''}`, ticket.id);
      return this.ticketPublic(ticket);
    });
  }
  async adminState(token) {
    const db = await this.store.read(); this.requireAdmin(this.sessionUser(db, token));
    return { users: db.users.map(user => ({ username: user.username, role: this.isAdmin(user) ? 'admin' : 'player', ticketReviewer: user.ticketReviewer === true,
      gameBinding: this.publicUser(user).gameBinding, developerCommunity: this.publicUser(user).developerCommunity, ban: this.activeBan(user) })),
      tickets: (db.tickets || []).slice().reverse().map(ticket => this.ticketPublic(ticket)), agreement: this.agreement(db), execution: executionConfiguration(), reviewWindow: reviewWindow(this.now()) };
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
