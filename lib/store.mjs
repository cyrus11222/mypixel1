import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyDatabase = () => ({ schema: 1, users: [], limits: [] });
const LIMIT = 800_000;
export class StoreUnavailable extends Error {}
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
  } catch { throw new StoreUnavailable('Invalid user.txt; refusing to overwrite it.'); }
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
    if (!r.ok) throw new StoreUnavailable('Cannot read configured repository.');
    const repo = await r.json();
    if (repo.private !== true || repo.visibility === 'public') throw new StoreUnavailable('Account storage requires a private repository.');
  }
  async snapshot() {
    await this.assertPrivate();
    const r = await this.request(`${this.root}/contents/user.txt?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) return { db: emptyDatabase(), sha: undefined };
    if (!r.ok) throw new StoreUnavailable('Cannot read user.txt.');
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
        if (r.status !== 409 && r.status !== 422) throw new StoreUnavailable('Cannot save user.txt.');
        // Compare-and-swap: reload the SHA and reapply only this operation.
      }
      throw new StoreUnavailable('Concurrent update; retry later.');
    });
  }
}
