import { AuthError } from './auth.mjs';

export const MAX_DOWNLOAD_ENTRIES = 200;
const MAX_FILES = 5000;
const MAX_TREE_REQUESTS = 100;
const SHA = /^[a-f0-9]{40}$/;
const fail = (status, code, message) => Object.assign(new AuthError(status, message), { code });
const unavailable = () => fail(503, 'DOWNLOAD_GITHUB_UNAVAILABLE', '暂时无法读取下载仓库，请稍后重试。');
const invalidPath = () => fail(400, 'DOWNLOAD_PATH_INVALID', '文件路径必须位于 Rsh 目录内，不能包含上级目录、反斜线或网址。');
const tooLarge = () => fail(503, 'DOWNLOAD_CATALOG_TOO_LARGE', 'Rsh 目录过大，无法完整列出；请减少文件或目录数量后重试。');

export function normalizeDownloadPath(value, { allowPrefix = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\p{C}\\]/u.test(value) ||
      value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw invalidPath();
  const path = allowPrefix && value.startsWith('Rsh/') ? value.slice(4) : value;
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalidPath();
  // Literal percent characters are supported. Encoded separators/traversal are
  // rejected as well, so no downstream URL decoder can change the directory.
  let decoded = path;
  for (let pass = 0; pass < path.length; pass++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break;
    if (next.includes('\\') || next.split('/').some(part => !part || part === '.' || part === '..') ||
        next.split('/').length !== decoded.split('/').length || /\p{C}/u.test(next)) throw invalidPath();
    decoded = next;
  }
  return path;
}
function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 100 || /\p{C}/u.test(value)) {
    throw fail(400, 'DOWNLOAD_NAME_INVALID', '显示名字需要 1–100 个字符。');
  }
  return value.trim();
}
function commandWords(value) {
  if (typeof value !== 'string' || value.length > 3000 || /[\r\n\u0000-\u001F\u007F]/.test(value)) {
    throw fail(400, 'DOWNLOAD_COMMAND_INVALID', '下载命令格式不正确。');
  }
  const words = []; let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') index++;
    if (index >= value.length) break;
    let word = '';
    if (value[index] === '"') {
      index++; let closed = false;
      while (index < value.length) {
        const char = value[index++];
        if (char === '"') { closed = true; break; }
        if (char === '\\') {
          const escaped = value[index++];
          if (escaped !== '"' && escaped !== '\\') throw fail(400, 'DOWNLOAD_COMMAND_INVALID', '引号中的转义仅支持双引号和反斜线。');
          word += escaped;
        } else word += char;
      }
      if (!closed || (index < value.length && value[index] !== ' ')) throw fail(400, 'DOWNLOAD_COMMAND_INVALID', '请正确闭合双引号，并用空格分隔参数。');
    } else {
      while (index < value.length && value[index] !== ' ') {
        if (value[index] === '"') throw fail(400, 'DOWNLOAD_COMMAND_INVALID', '含空格的参数请完整放在双引号内。');
        word += value[index++];
      }
    }
    words.push(word);
  }
  return words;
}
export function parseDownloadCommand(value) {
  const words = commandWords(typeof value === 'string' ? value.trim() : value);
  if (words.length === 2 && words[0] === 'rsh' && words[1] === 'ls') return { action: 'list' };
  if (words.length === 5 && words[0] === 'rsh' && words[1] === 'set' && ['add', 'remove'].includes(words[4])) {
    return { action: words[4], path: normalizeDownloadPath(words[2], { allowPrefix: true }), name: displayName(words[3]) };
  }
  throw fail(400, 'DOWNLOAD_COMMAND_INVALID', '使用 rsh ls，或 rsh set "文件路径" "显示名字" add/remove。');
}
export function validateDownloadEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_DOWNLOAD_ENTRIES) throw Error('Invalid download entries.');
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || normalizeDownloadPath(entry.path) !== entry.path || displayName(entry.name) !== entry.name ||
        !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 || paths.has(entry.path)) throw Error('Invalid download entry.');
    paths.add(entry.path);
  }
  return entries;
}

export class DownloadService {
  constructor(auth, { owner, repo, branch = 'main', token, fetcher = fetch } = {}) {
    if (![owner, repo, branch, token].every(value => typeof value === 'string' && value.length)) {
      throw fail(503, 'DOWNLOAD_CONFIG_MISSING', '下载仓库尚未配置，请服主检查 GITHUB_OWNER、GITHUB_REPO、GITHUB_TOKEN。');
    }
    if (!/^[A-Za-z0-9-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..' ||
        branch.length > 200 || /[\p{C}\\]/u.test(branch)) throw fail(503, 'DOWNLOAD_CONFIG_INVALID', '下载仓库配置不正确，请服主检查 GitHub 仓库和分支设置。');
    this.auth = auth; this.store = auth.store; this.owner = owner; this.repo = repo; this.branch = branch;
    this.token = token; this.fetcher = fetcher; this.root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  async request(suffix, deadline) {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw unavailable();
    let response;
    try {
      response = await this.fetcher(this.root + suffix, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        redirect: 'error', signal: AbortSignal.timeout(Math.min(8000, remaining))
      });
    } catch { throw unavailable(); }
    if (!response.ok) {
      if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) {
        throw fail(503, 'DOWNLOAD_GITHUB_RATE_LIMIT', 'GitHub 下载目录查询暂时达到限制，请稍后重试。');
      }
      if ([401, 403].includes(response.status)) throw fail(503, 'DOWNLOAD_GITHUB_ACCESS_DENIED', '无法读取下载仓库，请服主检查 GitHub Token 的 Contents 读取权限。');
      if (response.status === 404) throw fail(503, 'DOWNLOAD_REPO_UNAVAILABLE', '下载仓库或分支不存在，请服主检查 GitHub 配置。');
      throw unavailable();
    }
    try { return await response.json(); } catch { throw unavailable(); }
  }
  async catalog() {
    const deadline = Date.now() + 25_000;
    const [repository, commit] = await Promise.all([
      this.request('', deadline), this.request('/commits/' + encodeURIComponent(this.branch), deadline)
    ]);
    if (typeof repository.private !== 'boolean' || !SHA.test(commit.sha) || !SHA.test(commit.commit?.tree?.sha)) throw unavailable();
    const root = await this.tree(commit.commit.tree.sha, false, deadline);
    if (root.truncated) throw tooLarge();
    const directory = root.tree.find(entry => entry.path === 'Rsh' && entry.type === 'tree' && entry.mode === '040000');
    if (!directory) return { commit: commit.sha, private: repository.private, files: [] };
    if (!SHA.test(directory.sha)) throw unavailable();
    const recursive = await this.tree(directory.sha, true, deadline);
    let entries = recursive.tree;
    if (recursive.truncated) {
      // Discard the partial recursive result completely. GitHub recommends
      // walking individual trees when the recursive response is truncated.
      entries = []; const pending = [{ sha: directory.sha, prefix: '' }]; let requests = 0;
      while (pending.length) {
        if (++requests > MAX_TREE_REQUESTS) throw tooLarge();
        const current = pending.shift(); const part = await this.tree(current.sha, false, deadline);
        if (part.truncated) throw tooLarge();
        for (const item of part.tree) {
          if (typeof item.path !== 'string' || item.path.includes('/')) throw unavailable();
          const path = current.prefix + item.path;
          try { normalizeDownloadPath(path); } catch { throw unavailable(); }
          if (item.type === 'tree' && item.mode === '040000') {
            if (!SHA.test(item.sha)) throw unavailable();
            pending.push({ sha: item.sha, prefix: path + '/' });
          } else entries.push({ ...item, path });
          if (entries.length > MAX_FILES || pending.length > MAX_TREE_REQUESTS) throw tooLarge();
        }
      }
    }
    const files = []; const paths = new Set();
    for (const entry of entries) {
      // Symlinks and submodules are never followed, including a link out of Rsh.
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) continue;
      try { normalizeDownloadPath(entry.path); } catch { throw unavailable(); }
      if (!SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || paths.has(entry.path)) throw unavailable();
      paths.add(entry.path);
      files.push({ path: entry.path, name: entry.path.split('/').at(-1), bytes: entry.size });
      if (files.length > MAX_FILES) throw tooLarge();
    }
    files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    return { commit: commit.sha, private: repository.private, files };
  }
  async tree(sha, recursive, deadline) {
    const value = await this.request(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, deadline);
    if (!Array.isArray(value.tree) || typeof value.truncated !== 'boolean') throw unavailable();
    return value;
  }
  entries(db) { return validateDownloadEntries(db.settings?.downloads || []); }
  requirePublic(catalog) {
    if (catalog.private) throw fail(503, 'DOWNLOAD_REPO_PRIVATE', '下载仓库当前为私有仓库，无法提供游客直链，请服主使用公开仓库的 Rsh 目录。');
  }
  async list() {
    const entries = this.entries(await this.store.read());
    if (!entries.length) return { downloads: [] };
    const catalog = await this.catalog(); this.requirePublic(catalog);
    const files = new Map(catalog.files.map(file => [file.path, file]));
    return { downloads: entries.filter(entry => files.has(entry.path)).map(entry => ({
      path: entry.path, name: entry.name, bytes: files.get(entry.path).bytes,
      url: '/api/downloads?action=file&path=' + encodeURIComponent(entry.path)
    })) };
  }
  async download(path) {
    path = normalizeDownloadPath(path);
    const published = db => this.entries(db).some(entry => entry.path === path);
    if (!published(await this.store.read())) throw fail(404, 'DOWNLOAD_NOT_FOUND', '下载文件不存在或已下架。');
    const catalog = await this.catalog(); this.requirePublic(catalog);
    if (!catalog.files.some(file => file.path === path) || !published(await this.store.read())) {
      throw fail(404, 'DOWNLOAD_NOT_FOUND', '下载文件不存在或已下架。');
    }
    // Construct the destination ourselves; never trust a client URL or GitHub
    // download_url. The immutable commit prevents a branch-move race.
    return `https://raw.githubusercontent.com/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${catalog.commit}/Rsh/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  async command(token, value) {
    this.auth.requireAdmin(this.auth.sessionUser(await this.store.read(), token));
    const command = parseDownloadCommand(value);
    if (command.action === 'list') {
      const catalog = await this.catalog();
      const db = await this.store.read(); this.auth.requireAdmin(this.auth.sessionUser(db, token));
      const published = new Map(this.entries(db).map(entry => [entry.path, entry.name]));
      return { message: catalog.files.length ? `Rsh 目录共有 ${catalog.files.length} 个文件。` : 'Rsh 目录不存在或没有可下载文件。',
        files: catalog.files.map(file => ({ ...file, published: published.has(file.path), ...(published.has(file.path) ? { displayName: published.get(file.path) } : {}) })) };
    }
    if (command.action === 'add') {
      const catalog = await this.catalog(); this.requirePublic(catalog);
      if (!catalog.files.some(file => file.path === command.path)) throw fail(404, 'DOWNLOAD_FILE_MISSING', 'Rsh 目录中没有这个文件，请先使用 rsh ls 查看完整路径。');
    }
    return this.store.mutate(db => {
      this.auth.requireAdmin(this.auth.sessionUser(db, token));
      const entries = this.entries(db); const remaining = entries.filter(entry => entry.path !== command.path);
      if (command.action === 'add') {
        if (remaining.length >= MAX_DOWNLOAD_ENTRIES) throw fail(409, 'DOWNLOAD_LIMIT', '下载中心最多展示 200 个文件，请先下架旧条目。');
        remaining.push({ path: command.path, name: command.name, updatedAt: this.auth.now() });
      }
      db.settings ||= {}; db.settings.downloads = remaining;
      return { message: command.action === 'add' ? '下载条目已发布，游客可以下载。' : '下载条目已下架，GitHub 原文件保留。', downloads: remaining.map(entry => ({ ...entry })) };
    });
  }
}

export function createDownloadService(auth, env = process.env) {
  return new DownloadService(auth, { owner: env.GITHUB_OWNER?.trim(), repo: env.GITHUB_REPO?.trim(),
    branch: env.GITHUB_BRANCH?.trim() || 'main', token: env.GITHUB_TOKEN?.trim() });
}
