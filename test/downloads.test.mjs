import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthError, AuthService, tokenHash } from '../lib/auth.mjs';
import { DownloadService, normalizeDownloadPath, parseDownloadCommand, validateDownloadEntries } from '../lib/downloads.mjs';
import { createDownloadsHandler } from '../api/downloads.js';
import { GitHubStore, LocalStore } from '../lib/store.mjs';

const adminToken = 'A'.repeat(43), playerToken = 'B'.repeat(43);
const time = 1_900_000_000_000;
const hash = 'scrypt$32768$8$3$' + 'a'.repeat(32) + '$' + 'b'.repeat(128);
const secret = 'download-fixture-token-never-public';
const sha = value => createHash('sha1').update(value).digest('hex');
const commit = sha('immutable-fixture-commit');
const treeRoot = sha('tree:root');
const directorySHA = value => sha('Rsh:' + value);
const configEntry = (path, name = '安装包') => ({ path, name, updatedAt: time });

class CASStore {
  constructor(db) { this.db = structuredClone(db); this.version = 0; this.conflicts = 0; }
  async read() { return structuredClone(this.db); }
  async mutate(callback) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const version = this.version; const db = await this.read(); const result = await callback(db);
      if (this.beforeCommit) { const hook = this.beforeCommit; this.beforeCommit = null; await hook(); }
      if (version !== this.version) { this.conflicts++; continue; }
      this.db = structuredClone(db); this.version++; return result;
    }
    throw new Error('CAS fixture exhausted.');
  }
}
function initialDatabase() {
  return { schema: 1, limits: [], settings: { preservedSetting: 'keep-me' }, users: [
    { id: 'admin-id', username: 'admindevs', key: 'admindevs', role: 'admin', passwordHash: hash,
      adminCredentialHash: tokenHash(hash), sessions: [{ hash: tokenHash(adminToken), expiresAt: time + 86_400_000 }] },
    { id: 'player-id', username: 'Player', key: 'player', passwordHash: hash,
      sessions: [{ hash: tokenHash(playerToken), expiresAt: time + 86_400_000 }] }
  ] };
}
function repository(initialFiles = ['client.zip', 'mods/机械 动力.zip']) {
  const state = { files: initialFiles.map(item => typeof item === 'string' ? { path: item, bytes: 1234 } : item),
    requests: [], private: false, missing: false, recursiveTruncated: false, singleTruncated: false, status: 200 };
  state.fetcher = async (url, options) => {
    const parsed = new URL(url); const base = '/repos/fixture-owner/fixture-repo';
    assert.equal(parsed.origin, 'https://api.github.com'); assert.ok(parsed.pathname.startsWith(base));
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    assert.equal(options.redirect, 'error'); assert.ok(!options.method || options.method === 'GET');
    state.requests.push(parsed.pathname + parsed.search);
    if (state.onRequest) await state.onRequest(parsed);
    if (state.status !== 200) return Response.json({ message: 'private upstream error ' + secret }, { status: state.status, headers: state.errorHeaders });
    const suffix = parsed.pathname.slice(base.length);
    if (!suffix) return Response.json({ private: state.private, html_url: 'https://attacker.invalid/' });
    if (suffix.startsWith('/commits/')) return Response.json({ sha: commit, commit: { tree: { sha: treeRoot } } });
    if (!suffix.startsWith('/git/trees/')) return new Response('', { status: 404 });
    const requested = suffix.slice('/git/trees/'.length);
    if (requested === treeRoot) return Response.json({ tree: state.missing ? [{ path: 'rsh', type: 'tree', mode: '040000', sha: directorySHA('') }] : [
      { path: 'user.txt', mode: '100644', type: 'blob', size: 99, sha: sha('encrypted-users') },
      { path: 'Rsh', mode: state.rshSymlink ? '120000' : '040000', type: state.rshSymlink ? 'blob' : 'tree', sha: directorySHA('') }
    ], truncated: false });
    const directories = new Set(['']);
    for (const file of state.files) {
      const segments = file.path.split('/');
      for (let index = 1; index < segments.length; index++) directories.add(segments.slice(0, index).join('/'));
    }
    const directory = [...directories].find(value => directorySHA(value) === requested);
    if (directory === undefined) return new Response('', { status: 404 });
    const files = state.files.map(file => ({ path: file.path, size: file.bytes, mode: file.mode || '100644', type: file.type || 'blob', sha: sha('blob:' + file.path), download_url: 'https://attacker.invalid/?token=' + secret }));
    if (parsed.searchParams.has('recursive')) return Response.json({ tree: state.recursiveTruncated ? files.slice(0, 1) : files, truncated: state.recursiveTruncated });
    const prefix = directory ? directory + '/' : '';
    const nested = [...directories].filter(value => value && value.startsWith(prefix) && !value.slice(prefix.length).includes('/')).map(value => ({
      path: value.slice(prefix.length), mode: '040000', type: 'tree', sha: directorySHA(value)
    }));
    return Response.json({ tree: [...nested, ...files.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/')).map(file => ({ ...file, path: file.path.slice(prefix.length) }))], truncated: state.singleTruncated });
  };
  return state;
}
function fixture({ files, store = new CASStore(initialDatabase()) } = {}) {
  const remote = repository(files); const auth = new AuthService(store, { now: () => time, rateSecret: 'downloads-fixture-secret-'.repeat(3), adminPasswordHash: hash });
  const service = new DownloadService(auth, { owner: 'fixture-owner', repo: 'fixture-repo', branch: 'feature/downloads', token: secret, fetcher: remote.fetcher });
  return { remote, store, auth, service };
}
const errorCode = code => error => error.code === code;
const publish = (service, path = 'client.zip', name = '客户端') => service.command(adminToken, `rsh set ${JSON.stringify(path)} ${JSON.stringify(name)} add`);

test('command parser supports quoted spaces, nested paths, display quotes and optional exact Rsh prefix', () => {
  assert.deepEqual(parseDownloadCommand('rsh ls'), { action: 'list' });
  assert.deepEqual(parseDownloadCommand(' rsh set "Rsh/mods/机械 动力.zip" "整合包 \\"稳定版\\"" add '.replaceAll('\\\\', '\\')), { action: 'add', path: 'mods/机械 动力.zip', name: '整合包 "稳定版"' });
  assert.deepEqual(parseDownloadCommand('rsh set client.zip 客户端 remove'), { action: 'remove', path: 'client.zip', name: '客户端' });
  for (const value of [null, '', 'rsh', 'Rsh ls', 'rsh ls extra', 'rsh set a b delete', 'rsh set "unfinished b add', 'rsh ls\nrsh ls']) {
    assert.throws(() => parseDownloadCommand(value), error => error.status === 400);
  }
});

test('download paths reject traversal, backslashes, URL schemes and encoded separator bypasses', () => {
  for (const value of ['../user.txt', 'dir/../../user.txt', 'dir/./x', '/Rsh/client.zip', '//evil/x', 'https://evil/x', 'file:secret', 'dir\\x', 'dir//x', 'x\n.zip', '%2e%2e/user.txt', '%252e%252e/user.txt', 'dir%2fx.zip', '%255csecret', '']) {
    assert.throws(() => normalizeDownloadPath(value), errorCode('DOWNLOAD_PATH_INVALID'));
  }
  for (const value of ['安装 文件 100%.zip', 'sub/a#b?c&d.zip', 'Rsh/nested.zip', 'file..zip']) assert.equal(normalizeDownloadPath(value), value);
});

test('rsh ls recursively shows only regular files below case-sensitive Rsh', async () => {
  const f = fixture({ files: ['client.zip', 'mods/机械 动力.zip', { path: 'outside-link', mode: '120000', bytes: 16 }, { path: 'submodule', mode: '160000', type: 'commit', bytes: 0 }] });
  const result = await f.service.command(adminToken, 'rsh ls');
  assert.deepEqual(new Set(result.files.map(file => file.path)), new Set(['client.zip', 'mods/机械 动力.zip']));
  assert.ok(result.files.every(file => !file.published));
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('user.txt'));
  assert.ok(f.remote.requests.some(url => url.includes('feature%2Fdownloads')));
  f.remote.missing = true;
  assert.deepEqual((await f.service.command(adminToken, 'rsh ls')).files, []);
  f.remote.missing = false; f.remote.rshSymlink = true;
  assert.deepEqual((await f.service.command(adminToken, 'rsh ls')).files, []);
});

test('only admin can list or publish and CAS retries recheck the current admin role', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.command('', 'rsh ls'), error => error.status === 401);
  await assert.rejects(() => f.service.command(playerToken, 'rsh ls'), error => error.status === 403);
  await assert.rejects(() => f.service.command(playerToken, 'rsh set client.zip 包 add'), error => error.status === 403);
  assert.equal(f.remote.requests.length, 0);
  f.store.beforeCommit = () => f.store.mutate(db => { db.users[0].role = 'player'; });
  await assert.rejects(() => publish(f.service), error => error.status === 401 || error.status === 403);
  assert.equal((await f.store.read()).settings.downloads, undefined);
  assert.ok(f.store.conflicts >= 1);
});

test('publish requires an existing file and updating the same path never creates duplicates', async () => {
  const f = fixture();
  await assert.rejects(() => publish(f.service, 'missing.zip'), errorCode('DOWNLOAD_FILE_MISSING'));
  await publish(f.service, 'client.zip', '客户端一');
  await publish(f.service, 'client.zip', '客户端二');
  const db = await f.store.read(); assert.deepEqual(db.settings.downloads, [configEntry('client.zip', '客户端二')]);
  assert.equal(db.settings.preservedSetting, 'keep-me');
  assert.deepEqual(db.users, initialDatabase().users);
  const ls = await f.service.command(adminToken, 'rsh ls');
  assert.equal(ls.files.find(file => file.path === 'client.zip').displayName, '客户端二');
});

test('concurrent publication of different paths preserves both entries', async () => {
  const f = fixture();
  await Promise.all([publish(f.service, 'client.zip', '客户端'), publish(f.service, 'mods/机械 动力.zip', '整合包')]);
  assert.deepEqual(new Set((await f.store.read()).settings.downloads.map(entry => entry.path)), new Set(['client.zip', 'mods/机械 动力.zip']));
  assert.ok(f.store.conflicts >= 1);
});

test('remove only unpublishes and works after the file or even repository becomes unavailable', async () => {
  const f = fixture(); await publish(f.service);
  f.remote.files = []; f.remote.status = 503;
  const count = f.remote.requests.length;
  const result = await f.service.command(adminToken, 'rsh set client.zip 客户端 remove');
  assert.deepEqual(result.downloads, []); assert.equal(f.remote.requests.length, count);
  assert.deepEqual(await f.service.list(), { downloads: [] });
  assert.ok(result.message.includes('原文件保留'));
});

test('guest list exposes only published files still present and hides removed or renamed paths', async () => {
  const f = fixture(); await publish(f.service);
  await publish(f.service, 'mods/机械 动力.zip', '机械动力整合包');
  f.remote.files = [{ path: 'client-renamed.zip', bytes: 5 }, { path: 'mods/机械 动力.zip', bytes: 5678 }, { path: 'secret-unpublished.zip', bytes: 1 }];
  const result = await f.service.list();
  assert.deepEqual(result.downloads, [{ path: 'mods/机械 动力.zip', name: '机械动力整合包', bytes: 5678, url: '/api/downloads?action=file&path=' + encodeURIComponent('mods/机械 动力.zip') }]);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('unpublished'));
  await assert.rejects(() => f.service.download('client.zip'), errorCode('DOWNLOAD_NOT_FOUND'));
  await assert.rejects(() => f.service.download('secret-unpublished.zip'), errorCode('DOWNLOAD_NOT_FOUND'));
});

test('download destinations use fixed owner/repo and immutable commit, safely encoding special file names', async () => {
  const filename = 'mods/安装 100% #?&.zip';
  const f = fixture({ files: [filename, 'Rsh/nested.zip'] });
  await publish(f.service, filename, '特殊名称整合包');
  await publish(f.service, 'Rsh/Rsh/nested.zip', '嵌套目录文件');
  const url = new URL(await f.service.download(filename));
  assert.equal(url.origin, 'https://raw.githubusercontent.com');
  assert.equal(url.pathname, `/fixture-owner/fixture-repo/${commit}/Rsh/mods/${encodeURIComponent('安装 100% #?&.zip')}`);
  assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.ok(!url.href.includes(secret));
  assert.ok((await f.service.download('Rsh/nested.zip')).endsWith('/Rsh/Rsh/nested.zip'));
  await assert.rejects(() => f.service.download('https://attacker.invalid/'), errorCode('DOWNLOAD_PATH_INVALID'));
});

test('a download rechecks publication after repository lookup', async () => {
  const f = fixture(); await publish(f.service);
  let revoked = false;
  f.remote.onRequest = async () => {
    if (!revoked) { revoked = true; await f.store.mutate(db => { db.settings.downloads = []; }); }
  };
  await assert.rejects(() => f.service.download('client.zip'), errorCode('DOWNLOAD_NOT_FOUND'));
});

test('truncated recursive trees are replaced by complete non-recursive traversal', async () => {
  const f = fixture({ files: ['first.zip', 'a/second.zip', 'a/b/第三个.zip'] });
  f.remote.recursiveTruncated = true;
  const listed = await f.service.command(adminToken, 'rsh ls');
  assert.equal(listed.files.length, 3);
  assert.ok(f.remote.requests.includes('/repos/fixture-owner/fixture-repo/git/trees/' + directorySHA('a/b')));
  f.remote.singleTruncated = true;
  await assert.rejects(() => f.service.command(adminToken, 'rsh ls'), errorCode('DOWNLOAD_CATALOG_TOO_LARGE'));
});

test('oversized catalogs fail explicitly rather than returning a partial list', async () => {
  const f = fixture({ files: Array.from({ length: 5001 }, (_, index) => `file-${index}.zip`) });
  await assert.rejects(() => f.service.command(adminToken, 'rsh ls'), errorCode('DOWNLOAD_CATALOG_TOO_LARGE'));
});

test('private repositories are not exposed through token-bearing guest links and upstream errors remain safe', async () => {
  const f = fixture(); await publish(f.service);
  f.remote.private = true;
  assert.equal((await f.service.command(adminToken, 'rsh ls')).files.length, 2);
  await assert.rejects(() => f.service.list(), errorCode('DOWNLOAD_REPO_PRIVATE'));
  await assert.rejects(() => f.service.download('client.zip'), errorCode('DOWNLOAD_REPO_PRIVATE'));
  for (const [status, expected] of [[401, 'DOWNLOAD_GITHUB_ACCESS_DENIED'], [403, 'DOWNLOAD_GITHUB_ACCESS_DENIED'], [404, 'DOWNLOAD_REPO_UNAVAILABLE'], [429, 'DOWNLOAD_GITHUB_RATE_LIMIT'], [500, 'DOWNLOAD_GITHUB_UNAVAILABLE']]) {
    f.remote.private = false; f.remote.status = status;
    await assert.rejects(() => f.service.list(), error => error.code === expected && error.status === 503 && !error.message.includes(secret));
  }
});

test('settings validation preserves exact paths and rejects duplicate or malformed published entries', () => {
  assert.deepEqual(validateDownloadEntries([configEntry('client.zip')]), [configEntry('client.zip')]);
  for (const entries of [[configEntry('../user.txt')], [configEntry('client.zip'), configEntry('client.zip')], [configEntry('client.zip', '  name')], [configEntry('client.zip', 'x\n')], [configEntry('client.zip', 'x'.repeat(101))]]) {
    assert.throws(() => validateDownloadEntries(entries));
  }
});

function response() {
  return { statusCode: 200, headers: {}, text: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value = '') { this.text = value; } };
}
test('HTTP guest list and download redirects use the validated catalog; commands require origin and admin', async () => {
  const f = fixture(); await publish(f.service);
  let checkedOrigin = false;
  const handler = createDownloadsHandler({ getService: () => f.service, sessionToken: req => req.fixtureToken,
    verifyOrigin: req => { checkedOrigin = true; if (req.headers.origin !== 'https://www.mypixel.com.cn') throw new AuthError(403, '请求来源不正确。'); } });
  const listing = response(); await handler({ method: 'GET', url: '/api/downloads', headers: {} }, listing);
  assert.equal(listing.statusCode, 200); assert.equal(JSON.parse(listing.text).downloads.length, 1);
  assert.ok(!listing.text.includes(secret));
  const redirect = response(); await handler({ method: 'GET', url: '/api/downloads?action=file&path=client.zip', headers: {} }, redirect);
  assert.equal(redirect.statusCode, 302); assert.equal(new URL(redirect.headers.location).hostname, 'raw.githubusercontent.com');
  const blocked = response(); await handler({ method: 'GET', url: '/api/downloads?action=file&path=..%2Fuser.txt', headers: {} }, blocked);
  assert.equal(blocked.statusCode, 400); assert.equal(blocked.headers.location, undefined);
  const denied = response(); await handler({ method: 'POST', url: '/api/downloads?action=command', fixtureToken: playerToken,
    headers: { origin: 'https://www.mypixel.com.cn', 'content-type': 'application/json' }, body: { command: 'rsh ls' } }, denied);
  assert.ok(checkedOrigin); assert.equal(denied.statusCode, 403);
  const before = f.remote.requests.length; const crossSite = response();
  await handler({ method: 'POST', url: '/api/downloads?action=command', fixtureToken: adminToken,
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: { command: 'rsh ls' } }, crossSite);
  assert.equal(crossSite.statusCode, 403); assert.equal(f.remote.requests.length, before);
});

test('download settings round-trip through the real encrypted-account schema without replacing other data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-downloads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore(path.join(directory, 'user.txt'));
  await store.mutate(db => Object.assign(db, initialDatabase()));
  const f = fixture({ store }); await publish(f.service);
  const reloaded = await new LocalStore(store.file).read();
  assert.deepEqual(reloaded.settings.downloads, [configEntry('client.zip', '客户端')]);
  assert.equal(reloaded.settings.preservedSetting, 'keep-me');
  assert.deepEqual(reloaded.users, initialDatabase().users);
});

test('published configuration is stored inside the existing AES-encrypted GitHub account file', async () => {
  const remote = { text: null, revision: 0 };
  const fetcher = async (url, options = {}) => {
    if (!url.includes('/contents/')) return Response.json({ private: false, name: 'main' });
    if (options.method !== 'PUT') return remote.text === null ? new Response('', { status: 404 }) : Response.json({
      type: 'file', encoding: 'base64', size: Buffer.byteLength(remote.text), content: Buffer.from(remote.text).toString('base64'), sha: String(remote.revision)
    });
    const input = JSON.parse(options.body);
    if (input.sha !== (remote.text === null ? undefined : String(remote.revision))) return new Response('', { status: 409 });
    remote.text = Buffer.from(input.content, 'base64').toString(); remote.revision++;
    return Response.json({});
  };
  const options = { owner: 'fixture-owner', repo: 'fixture-repo', branch: 'main', token: secret, encryptionKey: 'ab'.repeat(32), fetcher };
  const store = new GitHubStore(options);
  await store.mutate(db => Object.assign(db, initialDatabase()));
  const f = fixture({ store }); await publish(f.service, 'client.zip', '加密配置显示名字');
  const envelope = JSON.parse(remote.text);
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  for (const value of ['client.zip', '加密配置显示名字', 'admindevs', hash, secret]) assert.ok(!remote.text.includes(value));
  const reloaded = await new GitHubStore(options).read();
  assert.deepEqual(reloaded.settings.downloads, [configEntry('client.zip', '加密配置显示名字')]);
  assert.deepEqual(reloaded.users, initialDatabase().users);
});
