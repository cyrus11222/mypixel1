import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyDatabase = () => ({ schema: 1, users: [], limits: [] });
const LIMIT = 800_000;
const STORE_ERRORS = {
  GITHUB_TOKEN_INVALID: 'GitHub 访问令牌无效或已过期，请服主更新 Vercel 中的 GITHUB_TOKEN 并重新部署。',
  GITHUB_ACCESS_DENIED: 'GitHub 拒绝访问，请服主检查 Token 对账户仓库的 Contents 读写权限及分支规则。',
  GITHUB_RATE_LIMIT: 'GitHub 请求暂时达到限制，请稍后重试。',
  GITHUB_REPO_UNAVAILABLE: '无法读取账户仓库，请服主检查 GITHUB_OWNER、GITHUB_REPO 及 Token 的仓库授权。',
  GITHUB_REPO_PUBLIC: '账户文件需要私有仓库，请服主配置独立的私有账户仓库。',
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
    const names = new Set();
    for (const u of db.users) {
      if (typeof u.id !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(u.username) ||
          u.key !== u.username.toLowerCase() || names.has(u.key) ||
          !/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(u.passwordHash) ||
          !Array.isArray(u.sessions) || u.sessions.some(s => !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isFinite(s.expiresAt))) throw Error();
      names.add(u.key);
    }
    if (db.limits.some(l => typeof l.key !== 'string' || !Number.isFinite(l.resetAt) || !Number.isInteger(l.count))) throw Error();
    return db;
  } catch { throw new StoreUnavailable('Invalid user.txt; refusing to overwrite it.', 'USER_FILE_INVALID'); }
}
function encode(db) { const text = JSON.stringify(db, null, 2) + '\n'; decode(text); return text; }
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
  constructor({ owner, repo, branch, token, fetcher = fetch }) {
    if (![owner, repo, branch, token].every(v => typeof v === 'string' && v.length)) throw new StoreUnavailable('Missing GitHub storage configuration.');
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
  async assertPrivate() {
    const r = await this.request(this.root);
    if (!r.ok) throw githubError(r, 'GITHUB_REPO_UNAVAILABLE');
    const repo = await r.json();
    if (repo.private !== true || repo.visibility === 'public') throw new StoreUnavailable('Account storage requires a private repository.', 'GITHUB_REPO_PUBLIC');
  }
  async snapshot() {
    await this.assertPrivate();
    const r = await this.request(`${this.root}/contents/user.txt?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) {
      const branch = await this.request(`${this.root}/branches/${encodeURIComponent(this.branch)}`);
      if (!branch.ok) throw githubError(branch, 'GITHUB_BRANCH_MISSING');
      return { db: emptyDatabase(), sha: undefined };
    }
    if (!r.ok) throw githubError(r, 'GITHUB_UNAVAILABLE');
    const data = await r.json();
    if (data.type !== 'file' || data.encoding !== 'base64' || data.size > LIMIT || typeof data.content !== 'string' || !data.sha) throw new StoreUnavailable('Unsupported user.txt response.');
    return { db: decode(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
  }
  async read() { return (await this.snapshot()).db; }
  mutate(fn) {
    return queue(this, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { db, sha } = await this.snapshot(); const result = await fn(db);
        const r = await this.request(`${this.root}/contents/user.txt`, { method: 'PUT', body: JSON.stringify({
          message: 'Update account records [skip ci]', branch: this.branch, sha,
          content: Buffer.from(encode(db)).toString('base64')
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
