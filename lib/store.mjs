import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { normalizeGameId, gameIdKey, GAME_BINDING_LOCK_MS } from './auth.mjs';

export const emptyDatabase = () => ({ schema: 1, users: [], limits: [] });
const LIMIT = 800_000;
const ENCRYPTED_FORMAT = 'mypixel-account-store';
const ENCRYPTION_AAD = Buffer.from('mypixel-account-store:v1:aes-256-gcm');
const STORE_ERRORS = {
  GITHUB_TOKEN_INVALID: 'GitHub 访问令牌无效或已过期，请服主更新 Vercel 中的 GITHUB_TOKEN 并重新部署。',
  GITHUB_ACCESS_DENIED: 'GitHub 拒绝访问，请服主检查 Token 对账户仓库的 Contents 读写权限及分支规则。',
  GITHUB_RATE_LIMIT: 'GitHub 请求暂时达到限制，请稍后重试。',
  GITHUB_REPO_UNAVAILABLE: '无法读取账户仓库，请服主检查 GITHUB_OWNER、GITHUB_REPO 及 Token 的仓库授权。',
  ACCOUNT_KEY_MISSING: '公开仓库的账户存储需要加密，请服主在 Vercel 设置 DATA_ENCRYPTION_KEY 并重新部署。',
  ACCOUNT_KEY_INVALID: '账户加密密钥格式不正确，DATA_ENCRYPTION_KEY 需要 64 位十六进制字符。',
  USER_FILE_UNENCRYPTED: '公开仓库中存在旧版未加密账户文件，已停止写入。请服主先迁移已有数据，不能直接覆盖 user.txt。',
  USER_FILE_DECRYPT_FAILED: '账户文件无法解密，已停止写入。请服主确认 DATA_ENCRYPTION_KEY 与创建账户文件时一致，且 user.txt 未被修改。',
  STORAGE_FULL: '账户文件已达到存储容量限制，已停止写入，请联系服主迁移账户存储。',
  GITHUB_BRANCH_MISSING: '账户数据分支不存在，请服主检查 GITHUB_BRANCH，并确保仓库已有首次提交。',
  GITHUB_WRITE_REJECTED: '账户文件写入被拒绝，请服主检查 Contents 写权限及账户分支保护规则。',
  GITHUB_UNAVAILABLE: '暂时无法连接 GitHub 账户存储，请稍后重试。',
  USER_FILE_INVALID: '账户文件格式不正确，已停止写入以保护数据，请服主检查 user.txt。',
  STORAGE_CONFLICT: '账户写入繁忙，请稍后重试。'
};
export class StoreUnavailable extends Error {
  constructor(message, code = 'GITHUB_UNAVAILABLE') { super(message); this.code = code; this.publicMessage = STORE_ERRORS[code] || STORE_ERRORS.GITHUB_UNAVAILABLE; }
}
function githubError(response, fallback) {
  const code = response.status === 401 ? 'GITHUB_TOKEN_INVALID'
    : response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ? 'GITHUB_RATE_LIMIT'
    : response.status === 403 ? 'GITHUB_ACCESS_DENIED' : fallback;
  return new StoreUnavailable('GitHub request rejected.', code);
}
function decode(text) {
  try {
    if (Buffer.byteLength(text) > LIMIT) throw Error();
    const db = JSON.parse(text);
    if (db.schema !== 1 || !Array.isArray(db.users) || !Array.isArray(db.limits)) throw Error();
    const names = new Set(); const gameIds = new Set();
    for (const u of db.users) {
      if (typeof u.id !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(u.username) ||
          u.key !== u.username.toLowerCase() || names.has(u.key) ||
          !/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(u.passwordHash) ||
          !Array.isArray(u.sessions) || u.sessions.some(s => !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isFinite(s.expiresAt))) throw Error();
      names.add(u.key);
      if (u.role !== undefined && !['player', 'admin'].includes(u.role)) throw Error();
      if (u.role === 'admin' && u.key !== 'admindevs') throw Error();
      if (u.adminCredentialHash !== undefined && (u.key !== 'admindevs' || !/^[a-f0-9]{64}$/.test(u.adminCredentialHash))) throw Error();
      if (u.ticketReviewer !== undefined && typeof u.ticketReviewer !== 'boolean') throw Error();
      if (u.ban != null && (typeof u.ban.reason !== 'string' || !u.ban.reason.length || [...u.ban.reason].length > 300 ||
          !Number.isSafeInteger(u.ban.createdAt) || (u.ban.until !== null && (!Number.isSafeInteger(u.ban.until) || u.ban.until <= u.ban.createdAt)))) throw Error();
      if (u.notifications !== undefined && (!Array.isArray(u.notifications) || u.notifications.length > 100 || u.notifications.some(n =>
        typeof n.id !== 'string' || n.id.length > 100 || !['role', 'account', 'ticket'].includes(n.type) || typeof n.message !== 'string' || [...n.message].length > 2000 ||
        !Number.isSafeInteger(n.createdAt) || (n.ticketId !== undefined && typeof n.ticketId !== 'string')))) throw Error();
      // Optional fields preserve accounts written before game binding was added.
      if (u.gameBinding != null) {
        const binding = u.gameBinding;
        if (typeof binding !== 'object' || Array.isArray(binding) || normalizeGameId(binding.gameId) !== binding.gameId ||
            binding.key !== gameIdKey(binding.gameId) || gameIds.has(binding.key) ||
            !Number.isSafeInteger(binding.boundAt) || binding.boundAt < 0 || !Number.isSafeInteger(binding.lockedUntil) ||
            binding.lockedUntil !== binding.boundAt + GAME_BINDING_LOCK_MS) throw Error();
        gameIds.add(binding.key);
      }
      if (u.developerCommunity != null) {
        const membership = u.developerCommunity;
        if (!u.gameBinding || typeof membership !== 'object' || Array.isArray(membership) ||
            !Number.isSafeInteger(membership.joinedAt) || membership.joinedAt < u.gameBinding.boundAt ||
            typeof membership.agreementVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}-v\d{1,5}$/.test(membership.agreementVersion)) throw Error();
      }
    }
    if (db.limits.some(l => typeof l.key !== 'string' || !Number.isFinite(l.resetAt) || !Number.isInteger(l.count))) throw Error();
    if (db.settings !== undefined) {
      if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) throw Error();
      const agreement = db.settings.devplayerAgreement;
      if (agreement !== undefined && (!agreement || typeof agreement.content !== 'string' || !agreement.content.length || [...agreement.content].length > 4000 ||
        !/^\d{4}-\d{2}-\d{2}-v\d{1,5}$/.test(agreement.version) || !Number.isSafeInteger(agreement.updatedAt))) throw Error();
    }
    if (db.tickets !== undefined) {
      if (!Array.isArray(db.tickets)) throw Error();
      const ids = new Set();
      for (const ticket of db.tickets) {
        if (!ticket || typeof ticket.id !== 'string' || ids.has(ticket.id) || (ticket.userId !== null && typeof ticket.userId !== 'string') ||
            typeof ticket.username !== 'string' || (ticket.gameId !== null && typeof ticket.gameId !== 'string') ||
            !['op', 'creative', 'materials'].includes(ticket.type) || typeof ticket.purpose !== 'string' || [...ticket.purpose].length > 1000 ||
            !ticket.details || typeof ticket.details !== 'object' || Array.isArray(ticket.details) ||
            !Number.isSafeInteger(ticket.createdAt) || !['pending', 'approved', 'rejected'].includes(ticket.status) ||
            (ticket.reviewedAt !== null && !Number.isSafeInteger(ticket.reviewedAt)) || (ticket.reviewedBy !== null && typeof ticket.reviewedBy !== 'string') ||
            typeof ticket.reviewNote !== 'string' || [...ticket.reviewNote].length > 1000 ||
            !ticket.execution || !['not_requested', 'pending_configuration'].includes(ticket.execution.status) || typeof ticket.execution.message !== 'string') throw Error();
        if (ticket.userId !== null) {
          const details = ticket.details;
          if (!Number.isSafeInteger(ticket.bindingAt)) throw Error();
          if (ticket.type !== 'materials' && (!Number.isInteger(details.durationMinutes) || details.durationMinutes < 1 || details.durationMinutes > 525_600)) throw Error();
          if (ticket.type === 'op' && (!Number.isInteger(details.opLevel) || details.opLevel < 1 || details.opLevel > 4)) throw Error();
          if (ticket.type === 'creative' && (typeof details.world !== 'string' || !details.world.length || [...details.world].length > 80)) throw Error();
          if (ticket.type === 'materials' && (typeof details.materials !== 'string' || [...details.materials].length < 2 || [...details.materials].length > 1000)) throw Error();
        }
        ids.add(ticket.id);
      }
    }
    return db;
  } catch { throw new StoreUnavailable('Invalid user.txt; refusing to overwrite it.', 'USER_FILE_INVALID'); }
}
function encode(db) { const text = JSON.stringify(db, null, 2) + '\n'; decode(text); return text; }
function encryptDatabase(db, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(encode(db), 'utf8'), cipher.final()]);
  const text = JSON.stringify({
    format: ENCRYPTED_FORMAT, version: 1, algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')
  }) + '\n';
  if (Buffer.byteLength(text) > LIMIT) throw new StoreUnavailable('Encrypted storage capacity reached.', 'STORAGE_FULL');
  return text;
}
function base64Bytes(value, length) {
  if (typeof value !== 'string') throw Error();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value || (length && bytes.length !== length)) throw Error();
  return bytes;
}
function decodeRemote(text, key, isPrivate) {
  let value;
  try {
    if (Buffer.byteLength(text) > LIMIT) throw Error();
    value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw Error();
  } catch { throw new StoreUnavailable('Invalid account file.', 'USER_FILE_INVALID'); }
  if (value.schema === 1 && !Object.hasOwn(value, 'format')) {
    if (!isPrivate) throw new StoreUnavailable('Public account file is not encrypted.', 'USER_FILE_UNENCRYPTED');
    // A private legacy file is encrypted on its next successful write.
    return decode(text);
  }
  let plaintext;
  try {
    if (!key || value.format !== ENCRYPTED_FORMAT || value.version !== 1 || value.algorithm !== 'aes-256-gcm') throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key, base64Bytes(value.iv, 12), { authTagLength: 16 });
    decipher.setAAD(ENCRYPTION_AAD);
    decipher.setAuthTag(base64Bytes(value.tag, 16));
    // Do not parse or use any plaintext before authentication has succeeded.
    plaintext = Buffer.concat([decipher.update(base64Bytes(value.ciphertext)), decipher.final()]).toString('utf8');
  } catch { throw new StoreUnavailable('Account decryption failed.', 'USER_FILE_DECRYPT_FAILED'); }
  return decode(plaintext);
}
function queue(store, operation) {
  const result = store.pending.then(operation); store.pending = result.catch(() => {}); return result;
}
export class LocalStore {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); }
  async read() {
    try { return decode(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return emptyDatabase(); throw e; }
  }
  mutate(fn) {
    return queue(this, async () => {
      const db = await this.read(); const result = await fn(db); const text = encode(db);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, text, { mode: 0o600 }); await rename(temp, this.file); return result;
    });
  }
}
export class GitHubStore {
  constructor({ owner, repo, branch, token, encryptionKey, fetcher = fetch }) {
    if (![owner, repo, branch, token].every(v => typeof v === 'string' && v.length)) throw new StoreUnavailable('Missing GitHub storage configuration.');
    if (encryptionKey !== undefined && (typeof encryptionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(encryptionKey))) throw new StoreUnavailable('Invalid encryption key.', 'ACCOUNT_KEY_INVALID');
    this.encryptionKey = encryptionKey === undefined ? null : Buffer.from(encryptionKey, 'hex');
    this.root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.branch = branch; this.token = token; this.fetcher = fetcher; this.pending = Promise.resolve();
  }
  async request(url, options = {}) {
    try {
      return await this.fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000), headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mypixel-club-server', 'Content-Type': 'application/json'
      } });
    } catch { throw new StoreUnavailable('GitHub connection unavailable.'); }
  }
  async repositoryPrivacy() {
    const r = await this.request(this.root);
    if (!r.ok) throw githubError(r, 'GITHUB_REPO_UNAVAILABLE');
    const repo = await r.json();
    const isPrivate = repo.private === true && repo.visibility !== 'public';
    if (!isPrivate && !this.encryptionKey) throw new StoreUnavailable('Public account storage requires an encryption key.', 'ACCOUNT_KEY_MISSING');
    return isPrivate;
  }
  async snapshot() {
    const isPrivate = await this.repositoryPrivacy();
    const r = await this.request(`${this.root}/contents/user.txt?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) {
      const branch = await this.request(`${this.root}/branches/${encodeURIComponent(this.branch)}`);
      if (!branch.ok) throw githubError(branch, 'GITHUB_BRANCH_MISSING');
      return { db: emptyDatabase(), sha: undefined };
    }
    if (!r.ok) throw githubError(r, 'GITHUB_UNAVAILABLE');
    const data = await r.json();
    if (data.type !== 'file' || data.encoding !== 'base64' || data.size > LIMIT || typeof data.content !== 'string' || !data.sha) throw new StoreUnavailable('Unsupported user.txt response.');
    return { db: decodeRemote(Buffer.from(data.content, 'base64').toString('utf8'), this.encryptionKey, isPrivate), sha: data.sha };
  }
  async read() { return (await this.snapshot()).db; }
  mutate(fn) {
    return queue(this, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { db, sha } = await this.snapshot(); const result = await fn(db);
        const r = await this.request(`${this.root}/contents/user.txt`, { method: 'PUT', body: JSON.stringify({
          message: 'Update account records [skip ci]', branch: this.branch, sha,
          content: Buffer.from(this.encryptionKey ? encryptDatabase(db, this.encryptionKey) : encode(db)).toString('base64')
        }) });
        if (r.ok) return result;
        if (r.status === 422) {
          // Retry creation only when another request created the file first.
          if (sha || !(await this.snapshot()).sha) throw githubError(r, 'GITHUB_WRITE_REJECTED');
        } else if (r.status !== 409) throw githubError(r, 'GITHUB_WRITE_REJECTED');
        // Compare-and-swap: reload the SHA and reapply only this operation.
      }
      throw new StoreUnavailable('Concurrent update; retry later.', 'STORAGE_CONFLICT');
    });
  }
}
