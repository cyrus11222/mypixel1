import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthService, tokenHash, GAME_BINDING_LOCK_MS, COMMUNITY_AGREEMENT_VERSION, normalizeGameId } from '../lib/auth.mjs';
import { GitHubStore, LocalStore, emptyDatabase } from '../lib/store.mjs';

const rateSecret = 'community-tests-only-'.repeat(4);
const encryptionKey = 'ab'.repeat(32);
const start = 1_900_000_000_000;
const tokenA = 'A'.repeat(43), tokenB = 'B'.repeat(43);
const agreement = { accepted: true, agreementVersion: COMMUNITY_AGREEMENT_VERSION };
const credentials = username => ({ username, password: 'a-long-test-password', remember: true });
function legacyUsers() {
  return [tokenA, tokenB].map((token, index) => ({
    id: 'legacy-' + index, username: 'Player' + index, key: 'player' + index,
    passwordHash: 'scrypt$32768$8$3$' + 'a'.repeat(32) + '$' + 'b'.repeat(128),
    createdAt: new Date(start - 1000).toISOString(),
    sessions: [{ hash: tokenHash(token), expiresAt: start + GAME_BINDING_LOCK_MS * 4 }]
  }));
}
function repository() {
  const remote = { text: null, revision: 0, conflicts: 0, writes: 0 };
  const fetcher = async (url, options = {}) => {
    if (!url.includes('/contents/')) return Response.json({ private: false, name: 'main' });
    if (options.method !== 'PUT') return remote.text === null ? new Response('', { status: 404 }) : Response.json({
      type: 'file', encoding: 'base64', size: Buffer.byteLength(remote.text),
      content: Buffer.from(remote.text).toString('base64'), sha: String(remote.revision)
    });
    const input = JSON.parse(options.body);
    if (input.sha !== (remote.text === null ? undefined : String(remote.revision))) {
      remote.conflicts++; return new Response('', { status: 409 });
    }
    remote.text = Buffer.from(input.content, 'base64').toString(); remote.revision++; remote.writes++;
    return Response.json({});
  };
  remote.store = () => new GitHubStore({ owner: 'test', repo: 'test', branch: 'main', token: 'test-only', encryptionKey, fetcher });
  return remote;
}
async function setup() {
  let now = start;
  const remote = repository(); await remote.store().mutate(db => { db.users = legacyUsers(); });
  const service = () => new AuthService(remote.store(), { now: () => now, rateSecret });
  return { remote, service, clock: value => { now = value; } };
}

test('legacy encrypted users gain binding fields without losing password hashes or existing sessions', async () => {
  const { remote, service } = await setup(); const auth = service();
  const before = (await remote.store().read()).users[0];
  assert.deepEqual(await auth.session(tokenA), { username: 'Player0', role: 'player', permissions: { adminCommands: false, reviewTickets: false }, notifications: [], gameBinding: null, developerCommunity: null });
  const bound = await auth.bindGame(tokenA, { gameId: '  开发者_Cafe\u0301-1  ', boundAt: 0, lockedUntil: 0, op: true });
  assert.deepEqual(bound.gameBinding, { gameId: '开发者_Café-1', boundAt: start, lockedUntil: start + GAME_BINDING_LOCK_MS });
  assert.deepEqual(await service().session(tokenA), bound);
  const after = (await remote.store().read()).users[0];
  assert.equal(after.passwordHash, before.passwordHash); assert.deepEqual(after.sessions, before.sessions);
  assert.equal(after.op, undefined); assert.equal(bound.gameBinding.key, undefined);
  assert.ok(!JSON.stringify(bound).includes('passwordHash')); assert.ok(!remote.text.includes('开发者'));
});

test('binding rejects invalid IDs and enforces case-insensitive uniqueness', async () => {
  const { service } = await setup(); const auth = service();
  for (const id of ['', 'ab', 'a'.repeat(33), 'abc\n', 'player\tname', 'name\u200B', 'name/other', '<script>', '😀user', null]) {
    await assert.rejects(() => auth.bindGame(tokenA, { gameId: id }), error => error.status === 400);
  }
  assert.equal(normalizeGameId('Bedrock Player_1.-'), 'Bedrock Player_1.-');
  await auth.bindGame(tokenA, { gameId: 'MyGame_ID' });
  await assert.rejects(() => auth.bindGame(tokenB, { gameId: '  mygame_id ' }), error => error.status === 409);
  assert.equal((await auth.session(tokenB)).gameBinding, null);
});

test('30-day lock is enforced at the exact boundary; rebind and unbind remove membership', async () => {
  const { service, clock } = await setup(); const auth = service();
  const original = await auth.bindGame(tokenA, { gameId: 'GameOne' });
  await auth.joinCommunity(tokenA, agreement);
  clock(start + 10_000);
  const repeated = await auth.bindGame(tokenA, { gameId: 'gameone' });
  assert.deepEqual(repeated.gameBinding, original.gameBinding); assert.ok(repeated.developerCommunity);
  clock(start + GAME_BINDING_LOCK_MS - 1);
  await assert.rejects(() => auth.bindGame(tokenA, { gameId: 'GameTwo' }), error => error.status === 409);
  await assert.rejects(() => auth.unbindGame(tokenA), error => error.status === 409);
  clock(start + GAME_BINDING_LOCK_MS);
  const replaced = await auth.bindGame(tokenA, { gameId: 'GameTwo' });
  assert.equal(replaced.gameBinding.boundAt, start + GAME_BINDING_LOCK_MS);
  assert.equal(replaced.gameBinding.lockedUntil, start + GAME_BINDING_LOCK_MS * 2);
  assert.equal(replaced.developerCommunity, null);
  await auth.joinCommunity(tokenA, agreement);
  clock(start + GAME_BINDING_LOCK_MS * 2 - 1);
  await assert.rejects(() => auth.unbindGame(tokenA), error => error.status === 409);
  clock(start + GAME_BINDING_LOCK_MS * 2);
  const unbound = await auth.unbindGame(tokenA);
  assert.equal(unbound.gameBinding, null); assert.equal(unbound.developerCommunity, null);
  const released = await auth.bindGame(tokenB, { gameId: 'gametwo' });
  assert.equal(released.gameBinding.gameId, 'gametwo');
});

test('joining requires a bound account and explicit current agreement; consent is idempotent', async () => {
  const { service, clock } = await setup(); const auth = service();
  await assert.rejects(() => auth.joinCommunity(tokenA, agreement), error => error.status === 409);
  await auth.bindGame(tokenA, { gameId: 'PlayerGame' });
  for (const body of [undefined, {}, { accepted: 'true', agreementVersion: COMMUNITY_AGREEMENT_VERSION }, { ...agreement, accepted: false }, { ...agreement, agreementVersion: '2026-09-01-v1' }]) {
    await assert.rejects(() => auth.joinCommunity(tokenA, body), error => error.status === 400);
  }
  const joined = await auth.joinCommunity(tokenA, { ...agreement, joinedAt: 1, op: true });
  assert.deepEqual(joined.developerCommunity, { joinedAt: start, agreementVersion: COMMUNITY_AGREEMENT_VERSION });
  clock(start + 1000);
  assert.deepEqual((await auth.joinCommunity(tokenA, agreement)).developerCommunity, joined.developerCommunity);
  assert.equal((await service().session(tokenA)).developerCommunity.joinedAt, start);
});

test('all account mutations reject anonymous, expired and revoked sessions', async () => {
  const { service, clock } = await setup(); const auth = service();
  const operations = token => [() => auth.bindGame(token, { gameId: 'Someone' }), () => auth.unbindGame(token), () => auth.joinCommunity(token, agreement)];
  for (const token of ['', 'malformed', 'Z'.repeat(43)]) for (const action of operations(token)) await assert.rejects(action, error => error.status === 401);
  await auth.logout(tokenA);
  for (const action of operations(tokenA)) await assert.rejects(action, error => error.status === 401);
  clock(start + GAME_BINDING_LOCK_MS * 4);
  for (const action of operations(tokenB)) await assert.rejects(action, error => error.status === 401);
});

test('logout is idempotent and never writes for forged, expired or already revoked sessions', async () => {
  const { remote, service, clock } = await setup(); const auth = service();
  const initialWrites = remote.writes;
  for (const token of ['', 'malformed', 'Z'.repeat(43)]) await auth.logout(token);
  assert.equal(remote.writes, initialWrites);
  await auth.logout(tokenA);
  assert.equal(remote.writes, initialWrites + 1);
  assert.equal(await auth.session(tokenA), null);
  await service().logout(tokenA);
  assert.equal(remote.writes, initialWrites + 1);
  clock(start + GAME_BINDING_LOCK_MS * 4);
  await auth.logout(tokenB);
  assert.equal(remote.writes, initialWrites + 1);
});

test('concurrent independent instances cannot claim the same ID or change a freshly locked binding', async () => {
  const { remote, service } = await setup();
  const results = await Promise.allSettled([
    service().bindGame(tokenA, { gameId: 'SharedGame' }), service().bindGame(tokenB, { gameId: 'sharedgame' })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.ok(remote.conflicts > 0);
  const db = await remote.store().read(); assert.equal(db.users.filter(u => u.gameBinding).length, 1);

  const fresh = await setup();
  const changes = await Promise.allSettled([
    fresh.service().bindGame(tokenA, { gameId: 'FirstGame' }), fresh.service().bindGame(tokenA, { gameId: 'OtherGame' })
  ]);
  assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(changes.find(r => r.status === 'rejected').reason.status, 409);
  assert.ok(fresh.remote.conflicts > 0);
});

test('login and registration share durable cooldown across instances, IPs, usernames and the 60-second boundary', async () => {
  const remote = repository(); let now = start;
  const service = () => new AuthService(remote.store(), { rateSecret, now: () => now });
  const registered = await service().register(credentials('CoolPlayer'), 'ip-a');
  assert.ok(registered.token);
  await assert.rejects(() => service().login(credentials('coolplayer'), 'ip-b'), error => error.code === 'AUTH_COOLDOWN' && error.retryAfterSeconds === 60);
  await assert.rejects(() => service().register(credentials('AnotherName'), 'ip-a'), error => error.code === 'AUTH_COOLDOWN');
  now += 59_001;
  await assert.rejects(() => service().login(credentials('CoolPlayer'), 'ip-a'), error => error.retryAfterSeconds === 1);
  now = start + 60_000;
  const loggedIn = await service().login(credentials('CoolPlayer'), 'ip-a'); assert.ok(loggedIn.token);
  await assert.rejects(() => service().register(credentials('CoolPlayer'), 'ip-c'), error => error.code === 'AUTH_COOLDOWN');
  const db = await remote.store().read();
  assert.ok(db.limits.every(l => /^[a-f0-9]{64}$/.test(l.key)));
  assert.ok(!remote.text.includes('ip-a'));
});

test('invalid and failed credentials also consume the shared cooldown without requiring an account', async () => {
  const remote = repository(); let now = start;
  const auth = new AuthService(remote.store(), { rateSecret, now: () => now });
  await assert.rejects(() => auth.login({}, 'invalid-ip'), error => error.status === 400);
  await assert.rejects(() => auth.register(credentials('FreshName'), 'invalid-ip'), error => error.code === 'AUTH_COOLDOWN');
  now += 60_000;
  await assert.rejects(() => auth.login(credentials('UnknownName'), 'missing-ip'), error => error.status === 401);
  await assert.rejects(() => auth.register(credentials('unknownname'), 'new-ip'), error => error.code === 'AUTH_COOLDOWN');
});

test('concurrent authentication attempts across instances reserve only one cooldown', async () => {
  const remote = repository(); await remote.store().mutate(() => {});
  const service = () => new AuthService(remote.store(), { rateSecret, now: () => start });
  const results = await Promise.allSettled([
    service().limit('same-ip', 'NewPlayer', 'login'), service().limit('same-ip', 'NewPlayer', 'register')
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'AUTH_COOLDOWN');
  assert.ok(remote.conflicts > 0);
});

test('malformed new account fields fail closed while the old schema remains accepted', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-community-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'user.txt'); const store = new LocalStore(file);
  const original = { ...emptyDatabase(), users: legacyUsers() };
  await writeFile(file, JSON.stringify(original)); assert.deepEqual(await store.read(), original);
  const binding = { gameId: 'GameName', key: 'gamename', boundAt: start, lockedUntil: start + GAME_BINDING_LOCK_MS };
  const invalid = [
    db => { db.users[0].gameBinding = { ...binding, lockedUntil: start }; },
    db => { db.users[0].gameBinding = { ...binding, key: 'spoofed' }; },
    db => { db.users[0].gameBinding = binding; db.users[1].gameBinding = binding; },
    db => { db.users[0].developerCommunity = { joinedAt: start, agreementVersion: COMMUNITY_AGREEMENT_VERSION }; },
    db => { db.users[0].gameBinding = binding; db.users[0].developerCommunity = { joinedAt: start - 1, agreementVersion: COMMUNITY_AGREEMENT_VERSION }; }
  ];
  for (const change of invalid) {
    const db = structuredClone(original); change(db); const text = JSON.stringify(db); await writeFile(file, text);
    await assert.rejects(() => store.mutate(() => {}), error => error.code === 'USER_FILE_INVALID');
    assert.equal(await readFile(file, 'utf8'), text);
  }
});
