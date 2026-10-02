import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthService, hashPassword, tokenHash, MAX_ACTIVE_SESSIONS } from '../lib/auth.mjs';
import { LocalStore } from '../lib/store.mjs';
import { device, deviceCookie, passkeyBinding, passkeyCookie } from '../lib/http.mjs';

const password = 'multi-device-test-password';
const passwordHash = await hashPassword(password);
const rateSecret = 'multi-device-test-only-'.repeat(4);
const now = Date.parse('2026-10-02T12:00:00+08:00');
const credentials = { username: 'DevicePlayer', password, remember: true };
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-devices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore(path.join(directory, 'user.txt'));
  await store.mutate(db => db.users.push({ id: 'fixture-user', username: credentials.username, key: credentials.username.toLowerCase(), passwordHash, sessions: [] }));
  const auth = new AuthService(store, { now: () => now, rateSecret });
  const login = context => auth.finishAuthenticatedLogin('fixture-user', { remember: true, expectedPasswordHash: passwordHash, ...context });
  return { store, auth, login };
}

test('multiple devices keep independent sessions beyond the old ten-device limit without storing device tokens or raw UA', async t => {
  const { auth, store, login } = await setup(t); const sessions = [];
  for (let index = 0; index < 12; index++) sessions.push(await login({ deviceToken: randomBytes(32).toString('base64url'), userAgent: `Windows Chrome/130 sensitive-UA-fragment-${index}` }));
  for (const session of sessions) assert.equal((await auth.session(session.token)).username, 'DevicePlayer');
  const db = await store.read(); assert.equal(db.users[0].sessions.length, 12); assert.equal(db.users[0].devices.length, 12);
  const saved = JSON.stringify(db);
  assert.ok(!saved.includes('sensitive-UA-fragment'));
  for (const session of sessions) { assert.ok(!saved.includes(session.deviceToken)); assert.ok(!saved.includes(session.token)); }
  assert.ok(db.users[0].devices.every(device => /^[a-f0-9]{64}$/.test(device.hash) && device.label === 'Windows · Chrome'));
});

test('new login alerts only other currently existing sessions, each session acknowledges independently', async t => {
  const { auth, store, login } = await setup(t);
  const first = await login({}); const second = await login({});
  const firstNotice = (await auth.session(first.token)).notifications[0];
  await auth.acknowledgeNotifications(first.token, { ids: [firstNotice.id] });
  const third = await login({ userAgent: 'iPhone Safari/600' });
  assert.deepEqual(third.user.notifications, []);
  const a = (await auth.session(first.token)).notifications; const b = (await auth.session(second.token)).notifications;
  assert.equal(a.length, 1); assert.equal(b.length, 1); assert.equal(a[0].id, b[0].id); assert.equal(a[0].type, 'new-device');
  assert.match(a[0].message, /iPhone/); assert.ok(!JSON.stringify(a).includes('targetSessionHashes'));
  await auth.acknowledgeNotifications(third.token, { ids: [a[0].id] });
  assert.equal((await auth.session(first.token)).notifications.length, 1);
  await auth.acknowledgeNotifications(first.token, { ids: [a[0].id] });
  assert.deepEqual((await auth.session(first.token)).notifications, []);
  assert.equal((await auth.session(second.token)).notifications.length, 1);
  await auth.acknowledgeNotifications(second.token, { ids: [a[0].id] });
  assert.equal((await store.read()).users[0].notifications.length, 0);
});

test('same-browser rotation preserves other devices and lost device cookies do not leave duplicate current sessions', async t => {
  const { auth, store, login } = await setup(t);
  const first = await login({}); const second = await login({});
  const before = (await store.read()).users[0].notifications.length;
  const rotated = await login({ previousToken: first.token, deviceToken: first.deviceToken });
  assert.equal(await auth.session(first.token), null); assert.ok(await auth.session(second.token)); assert.ok(await auth.session(rotated.token));
  assert.equal((await store.read()).users[0].sessions.length, 2); assert.equal((await store.read()).users[0].notifications.length, before);
  const missingDeviceCookie = await login({ previousToken: rotated.token });
  assert.equal(await auth.session(rotated.token), null); assert.ok(await auth.session(missingDeviceCookie.token));
  assert.equal((await store.read()).users[0].sessions.length, 2); assert.equal((await store.read()).users[0].notifications.length, before);
});

test('a known device logging in again after logout notifies other sessions, while logout affects only itself', async t => {
  const { auth, login } = await setup(t);
  const first = await login({}); const second = await login({});
  await auth.acknowledgeNotifications(first.token, { ids: (await auth.session(first.token)).notifications.map(item => item.id) });
  await auth.logout(second.token); assert.ok(await auth.session(first.token)); assert.equal(await auth.session(second.token), null);
  await login({ deviceToken: second.deviceToken });
  assert.equal((await auth.session(first.token)).notifications.length, 1);
});

test('session capacity rejects new devices instead of evicting existing sessions and allows rotating the current one', async t => {
  const { auth, store, login } = await setup(t);
  const tokens = Array.from({ length: MAX_ACTIVE_SESSIONS }, () => randomBytes(32).toString('base64url'));
  await store.mutate(db => { db.users[0].sessions = tokens.map(token => ({ hash: tokenHash(token), expiresAt: now + 86_400_000 })); });
  const before = await store.read();
  await assert.rejects(() => login({}), error => error.status === 409);
  assert.deepEqual(await store.read(), before);
  const rotated = await login({ previousToken: tokens[0] });
  assert.equal(await auth.session(tokens[0]), null); assert.ok(await auth.session(rotated.token));
  for (const token of tokens.slice(1)) assert.ok(await auth.session(token));
});

test('authorization hook failure and banned accounts never issue a session or consume transaction changes', async t => {
  const { auth, store, login } = await setup(t);
  await store.mutate(db => { db.users[0].ban = { createdAt: now - 1000, until: null, reason: 'fixture ban' }; });
  let verified = false;
  await assert.rejects(() => login({ authorize: async (db, user) => { verified = true; user.fixtureMutation = 'should roll back'; } }), error => error.code === 'ACCOUNT_BANNED');
  assert.equal(verified, true); assert.equal((await store.read()).users[0].fixtureMutation, undefined); assert.equal((await store.read()).users[0].sessions.length, 0);
  await assert.rejects(() => login({ authorize: async () => { throw new Error('synthetic verification failed'); } }), /synthetic verification failed/);
  assert.equal((await store.read()).users[0].sessions.length, 0);
});

test('server-signed device cookies reject tampering and passkey bindings remain HttpOnly and short-lived', () => {
  const names = ['AUTH_STORE', 'VERCEL', 'RATE_LIMIT_SECRET']; const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.AUTH_STORE = 'local'; delete process.env.VERCEL; process.env.RATE_LIMIT_SECRET = rateSecret;
    const value = randomBytes(32).toString('base64url'); const signed = deviceCookie(value);
    assert.match(signed, /HttpOnly; SameSite=Lax/); assert.equal(device({ headers: { cookie: signed.split(';')[0] } }), value);
    const altered = signed.replace(value, 'X'.repeat(43)); assert.equal(device({ headers: { cookie: altered.split(';')[0] } }), '');
    assert.equal(device({ headers: { cookie: `mypixel_device=${value}` } }), '');
    const challengeCookie = passkeyCookie(value); assert.match(challengeCookie, /HttpOnly; SameSite=Strict; Max-Age=300/);
    assert.equal(passkeyBinding({ headers: { cookie: challengeCookie.split(';')[0] } }), value);
    process.env.VERCEL = '1'; assert.match(deviceCookie(value), /^__Host-mypixel_device=.*; Path=\/; HttpOnly; SameSite=Lax; Secure;/);
    assert.match(passkeyCookie(value), /^__Host-mypixel_passkey=.*; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=300$/);
  } finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
});
