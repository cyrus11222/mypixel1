import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { GitHubStore, emptyDatabase } from '../lib/store.mjs';
import { AuthService, tokenHash, REMEMBER_SECONDS } from '../lib/auth.mjs';

// Synthetic test keys only; no real service credentials are used by this suite.
const key = 'ab'.repeat(32);
const otherKey = 'cd'.repeat(32);
const rateSecret = 'encryption-test-only-'.repeat(4);
const root = 'https://api.github.com/repos/test-owner/test-accounts';
const storeOptions = { owner: 'test-owner', repo: 'test-accounts', branch: 'main', token: 'test-token-only' };

function remoteRepository({ private: isPrivate = false, text = null } = {}) {
  const state = { text, revision: text === null ? 0 : 1, writes: 0, conflicts: 0, commits: [] };
  state.fetcher = async (url, options = {}) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token-only');
    if (url === root) return Response.json({ private: isPrivate, visibility: isPrivate ? 'private' : 'public' });
    if (url === root + '/branches/main') return Response.json({ name: 'main' });
    if (url === root + '/contents/user.txt?ref=main') {
      if (state.text === null) return new Response('', { status: 404 });
      return Response.json({
        type: 'file', encoding: 'base64', size: Buffer.byteLength(state.text),
        content: Buffer.from(state.text).toString('base64'), sha: String(state.revision)
      });
    }
    assert.equal(url, root + '/contents/user.txt');
    assert.equal(options.method, 'PUT');
    state.writes++;
    const request = JSON.parse(options.body);
    assert.equal(request.branch, 'main');
    if (request.sha !== (state.text === null ? undefined : String(state.revision))) {
      state.conflicts++;
      return new Response('', { status: 409 });
    }
    state.text = Buffer.from(request.content, 'base64').toString('utf8');
    state.revision++;
    state.commits.push({ text: state.text, request });
    return Response.json({ content: { sha: String(state.revision) } }, { status: 200 });
  };
  state.store = (encryptionKey = key) => new GitHubStore({ ...storeOptions, encryptionKey, fetcher: state.fetcher });
  return state;
}

function decrypt(text) {
  const envelope = JSON.parse(text);
  assert.equal(envelope.format, 'mypixel-account-store');
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from('mypixel-account-store:v1:aes-256-gcm'));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
}

function legacyDatabase() {
  const db = emptyDatabase();
  db.users.push({
    id: 'legacy-user', username: 'LegacyPlayer', key: 'legacyplayer',
    passwordHash: 'scrypt$32768$8$3$' + 'a'.repeat(32) + '$' + 'b'.repeat(128),
    sessions: [{ hash: 'c'.repeat(64), expiresAt: 4_000_000_000_000 }]
  });
  return db;
}

test('public repository persists encrypted registration, remembered sessions, login and logout', async () => {
  const remote = remoteRepository();
  let now = 1_900_000_000_000;
  const credentials = { username: 'CipherPlayer', password: 'long-test-password-sentinel', remember: true };
  const auth = new AuthService(remote.store(), { rateSecret, now: () => now });
  const registered = await auth.register(credentials, 'test-ip');
  const db = decrypt(remote.text);
  assert.equal(db.users[0].username, credentials.username);
  assert.match(db.users[0].passwordHash, /^scrypt\$/);
  assert.equal(db.users[0].sessions[0].hash, tokenHash(registered.token));
  assert.equal(db.users[0].sessions[0].expiresAt, now + REMEMBER_SECONDS * 1000);

  const restarted = new AuthService(remote.store(), { rateSecret, now: () => now });
  assert.equal((await restarted.session(registered.token)).username, credentials.username);
  now += 60_000;
  const loggedIn = await restarted.login(credentials, 'test-ip', registered.token);
  assert.equal(await auth.session(registered.token), null);
  assert.equal((await auth.session(loggedIn.token)).username, credentials.username);
  await restarted.logout(loggedIn.token);
  assert.equal(await auth.session(loggedIn.token), null);

  for (const commit of remote.commits) {
    decrypt(commit.text);
    for (const sensitive of [credentials.username, credentials.password, db.users[0].passwordHash,
      db.users[0].sessions[0].hash, registered.token, loggedIn.token, key, rateSecret]) {
      assert.ok(!commit.text.includes(sensitive), 'Public user.txt must not contain account data or secrets.');
      assert.ok(!commit.request.message.includes(sensitive), 'Commit messages must not contain account data or secrets.');
    }
    assert.equal(JSON.parse(commit.text).users, undefined);
    assert.equal(JSON.parse(commit.text).limits, undefined);
  }
});

test('repeated writes of identical data use independent random nonces and remain decryptable', async () => {
  const remote = remoteRepository();
  const store = remote.store();
  await store.mutate(() => {});
  await store.mutate(() => {});
  const first = JSON.parse(remote.commits[0].text);
  const second = JSON.parse(remote.commits[1].text);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(decrypt(remote.commits[0].text), emptyDatabase());
  assert.deepEqual(decrypt(remote.commits[1].text), emptyDatabase());
});

test('public repositories require a key and never accept an existing plaintext account file', async () => {
  const fresh = remoteRepository();
  const noKey = new GitHubStore({ ...storeOptions, fetcher: fresh.fetcher });
  await assert.rejects(() => noKey.mutate(() => {}), error => error.code === 'ACCOUNT_KEY_MISSING');
  assert.equal(fresh.writes, 0);
  assert.equal(fresh.text, null);

  const plaintext = JSON.stringify(legacyDatabase());
  const existing = remoteRepository({ text: plaintext });
  let changed = false;
  await assert.rejects(() => existing.store().mutate(() => { changed = true; }), error => error.code === 'USER_FILE_UNENCRYPTED');
  assert.equal(changed, false);
  assert.equal(existing.writes, 0);
  assert.equal(existing.text, plaintext);
});

test('invalid encryption keys are rejected before any repository request', () => {
  for (const encryptionKey of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, 123]) {
    let requests = 0;
    assert.throws(() => new GitHubStore({ ...storeOptions, encryptionKey, fetcher: async () => { requests++; } }), error => error.code === 'ACCOUNT_KEY_INVALID');
    assert.equal(requests, 0);
  }
});

test('wrong keys and authenticated-envelope tampering never expose data or perform writes', async () => {
  const source = remoteRepository();
  await source.store().mutate(db => db.limits.push({ key: 'original-record', count: 1, resetAt: 100 }));
  const original = source.text;
  const wrong = remoteRepository({ text: original });
  await assert.rejects(() => wrong.store(otherKey).read(), error => error.code === 'USER_FILE_DECRYPT_FAILED');
  await assert.rejects(() => wrong.store(otherKey).mutate(() => { throw Error('Must not call mutation'); }), error => error.code === 'USER_FILE_DECRYPT_FAILED');
  assert.equal(wrong.writes, 0);
  assert.equal(wrong.text, original);

  for (const field of ['iv', 'tag', 'ciphertext', 'version', 'algorithm', 'format']) {
    const envelope = JSON.parse(original);
    if (['iv', 'tag', 'ciphertext'].includes(field)) {
      const bytes = Buffer.from(envelope[field], 'base64');
      bytes[0] ^= 1;
      envelope[field] = bytes.toString('base64');
    } else envelope[field] = field === 'version' ? 2 : 'changed';
    const tampered = JSON.stringify(envelope);
    const remote = remoteRepository({ text: tampered });
    const store = remote.store();
    await assert.rejects(() => store.read(), error => error.code === 'USER_FILE_DECRYPT_FAILED');
    await assert.rejects(() => store.mutate(() => { throw Error('Must not call mutation'); }), error => error.code === 'USER_FILE_DECRYPT_FAILED');
    assert.equal(remote.writes, 0);
    assert.equal(remote.text, tampered);
  }
});

test('private legacy data migrates to encryption without losing existing users or sessions', async () => {
  const original = legacyDatabase();
  const remote = remoteRepository({ private: true, text: JSON.stringify(original) });
  const store = remote.store();
  assert.deepEqual(await store.read(), original);
  assert.equal(remote.writes, 0);
  await store.mutate(db => db.limits.push({ key: 'new-limit', count: 1, resetAt: 200 }));
  const updated = await remote.store().read();
  assert.deepEqual(updated.users, original.users);
  assert.deepEqual(updated.limits, [{ key: 'new-limit', count: 1, resetAt: 200 }]);
  assert.deepEqual(decrypt(remote.text), updated);
  assert.ok(!remote.text.includes('LegacyPlayer'));

  const withoutKey = new GitHubStore({ ...storeOptions, fetcher: remote.fetcher });
  const writes = remote.writes;
  await assert.rejects(() => withoutKey.mutate(() => {}), error => error.code === 'USER_FILE_DECRYPT_FAILED');
  assert.equal(remote.writes, writes);
});

test('independent server instances merge concurrent encrypted changes without dropping data', async () => {
  const remote = remoteRepository();
  await remote.store().mutate(() => {});
  const first = remote.store();
  const second = remote.store();
  await Promise.all([
    first.mutate(db => db.limits.push({ key: 'first-instance', count: 1, resetAt: 100 })),
    second.mutate(db => db.limits.push({ key: 'second-instance', count: 1, resetAt: 200 }))
  ]);
  assert.ok(remote.conflicts >= 1, 'Test must exercise a compare-and-swap conflict.');
  const db = await remote.store().read();
  assert.deepEqual(db.limits.map(record => record.key).sort(), ['first-instance', 'second-instance']);
  for (const commit of remote.commits) decrypt(commit.text);
});

test('encrypted storage capacity rejection does not write oversized or truncated account data', async () => {
  const remote = remoteRepository();
  const store = remote.store();
  await store.mutate(() => {});
  const before = remote.text;
  const writes = remote.writes;
  await assert.rejects(() => store.mutate(db => {
    db.limits.push({ key: 'large-entry-'.repeat(58_000), count: 1, resetAt: 100 });
  }), error => error.code === 'STORAGE_FULL');
  assert.equal(remote.writes, writes);
  assert.equal(remote.text, before);
});
