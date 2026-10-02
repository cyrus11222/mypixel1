import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as verifier from '@simplewebauthn/server';
import { AuthService, hashPassword, tokenHash } from '../lib/auth.mjs';
import { PasskeyService, PASSKEY_CHALLENGE_MS } from '../lib/passkeys.mjs';
import { LocalStore } from '../lib/store.mjs';

const origin = 'https://www.mypixel.com.cn';
const rpID = 'www.mypixel.com.cn';
const password = 'synthetic-passkey-fixture-password';
const passwordHash = await hashPassword(password);
const initialTime = 1_900_000_000_000;
const tokenA = 'A'.repeat(43), tokenB = 'B'.repeat(43);
const digest = data => createHash('sha256').update(data).digest();
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const handle = user => b64(digest('mypixel-passkey-user:' + user.id));

// An optimistic store reproduces GitHub's retry semantics without network I/O.
class CASStore {
  constructor(db) { this.db = structuredClone(db); this.revision = 0; this.conflicts = 0; }
  async read() { return structuredClone(this.db); }
  async mutate(callback) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const revision = this.revision; const db = await this.read();
      const result = await callback(db);
      if (revision !== this.revision) { this.conflicts++; continue; }
      this.db = structuredClone(db); this.revision++; return result;
    }
    throw new Error('Fixture CAS exhausted.');
  }
}
function database() {
  return { schema: 1, limits: [], users: [tokenA, tokenB].map((token, index) => ({
    id: 'fixture-user-' + index, username: 'Player' + index, key: 'player' + index,
    passwordHash, createdAt: new Date(initialTime).toISOString(),
    sessions: [{ hash: tokenHash(token), expiresAt: initialTime + 86_400_000 }]
  })) };
}
async function fixture({ store = new CASStore(database()), implementation = verifier, admin = false } = {}) {
  let now = initialTime;
  const auth = new AuthService(store, { now: () => now, rateSecret: 'passkey-test-only-'.repeat(4), ...(admin ? { adminPasswordHash: passwordHash } : {}) });
  const passkeys = new PasskeyService(auth, { origin, verifier: implementation });
  const state = { store, auth, passkeys, advance: (ms = 61_000) => { now += ms; } };
  state.register = async (token = tokenA, authenticator = keypair()) => {
    const issued = await passkeys.registrationOptions(token, { password, name: '手机通行密钥' }, { ip: 'fixture-registration' });
    const response = registration(authenticator, issued.options);
    const result = await passkeys.verifyRegistration(token, { response }, issued.bindingToken);
    return { ...issued, authenticator, result, response };
  };
  state.challenge = async () => {
    state.advance();
    return passkeys.authenticationOptions({ remember: true }, { ip: 'fixture-authentication' });
  };
  return state;
}
function keypair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { ...pair, id: randomBytes(32), x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') };
}
// Minimal fixture-only CBOR encoding for a real ES256 COSE key and fmt=none
// attestation. Production verification always runs SimpleWebAuthn's parser.
function cbor(value) {
  const head = (type, count) => count < 24 ? Buffer.from([(type << 5) | count]) : count < 256
    ? Buffer.from([(type << 5) | 24, count]) : Buffer.from([(type << 5) | 25, count >> 8, count & 255]);
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new Error('Unsupported fixture CBOR type.');
}
function clientData(type, options, changes = {}) {
  return Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false, ...changes }));
}
function authenticatorData({ rp = rpID, flags = 5, counter = 0 } = {}) {
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  return Buffer.concat([digest(rp), Buffer.from([flags]), count]);
}
function registration(key, options, changes = {}) {
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, key.x], [-3, key.y]]));
  const credentialLength = Buffer.alloc(2); credentialLength.writeUInt16BE(key.id.length);
  const data = Buffer.concat([authenticatorData({ flags: 0x45, ...changes.authData }), Buffer.alloc(16), credentialLength, key.id, cose]);
  return { id: b64(key.id), rawId: b64(key.id), type: 'public-key', authenticatorAttachment: 'cross-platform',
    clientExtensionResults: { credProps: { rk: true } }, response: {
      clientDataJSON: b64(clientData('webauthn.create', options, changes.clientData)),
      attestationObject: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]))), transports: ['hybrid']
    } };
}
function assertion(key, options, user = database().users[0], changes = {}) {
  const json = clientData('webauthn.get', options, changes.clientData);
  const authData = authenticatorData({ counter: 1, ...changes.authData });
  return { id: b64(key.id), rawId: b64(key.id), type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: b64(json), authenticatorData: b64(authData),
    signature: b64(sign('sha256', Buffer.concat([authData, digest(json)]), key.privateKey)),
    userHandle: handle(user)
  } };
}
const rejectCode = code => error => error.code === code;

test('registration requires a live session and current password before creating a challenge', async () => {
  const f = await fixture();
  await assert.rejects(() => f.passkeys.registrationOptions(null, { password }), error => error.status === 401);
  await assert.rejects(() => f.passkeys.registrationOptions(tokenA, { password: 'wrong-fixture-password' }), error => error.status === 403 && error.code === 'REAUTH_FAILED');
  assert.equal((await f.store.read()).passkeyChallenges, undefined);
  const issued = await f.passkeys.registrationOptions(tokenA, { password });
  assert.equal(issued.options.rp.id, rpID);
  assert.equal(issued.options.authenticatorSelection.residentKey, 'required');
  assert.equal(issued.options.authenticatorSelection.userVerification, 'required');
  assert.equal(issued.options.user.id, handle(database().users[0]));
  assert.equal(issued.bindingToken.length, 43);
  const record = (await f.store.read()).passkeyChallenges[0];
  assert.equal(record.expiresAt - record.createdAt, PASSKEY_CHALLENGE_MS);
  assert.equal(record.bindingHash, tokenHash(issued.bindingToken));
  assert.ok(!JSON.stringify(await f.store.read()).includes(issued.bindingToken));
});

test('real ES256 registration persists verified public material and returns a safe list', async () => {
  const f = await fixture(); const result = await f.register();
  const list = await f.passkeys.list(tokenA);
  assert.equal(list.passkeys.length, 1);
  assert.deepEqual(Object.keys(list.passkeys[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'transports']);
  assert.equal(list.passkeys[0].name, '手机通行密钥');
  assert.deepEqual(list.passkeys[0].transports, ['hybrid']);
  const record = (await f.store.read()).users[0].passkeys[0];
  assert.ok(record.publicKey.length > 30); assert.equal(record.counter, 0); assert.equal(record.lastUsedAt, null);
  assert.equal(record.credentialVersion, tokenHash(passwordHash));
  assert.equal((await f.store.read()).passkeyChallenges.length, 0);
  await assert.rejects(() => f.passkeys.verifyRegistration(tokenA, { response: result.response }, result.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  assert.equal((await f.store.read()).users[0].passkeys.length, 1);
});

test('registration rejects wrong browser/session, challenge, origin, RP ID, missing UV and injected key JSON', async () => {
  const f = await fixture(); const key = keypair();
  const issued = await f.passkeys.registrationOptions(tokenA, { password });
  const valid = registration(key, issued.options);
  for (const binding of [undefined, 'X'.repeat(43)]) {
    await assert.rejects(() => f.passkeys.verifyRegistration(tokenA, { response: valid }, binding), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  }
  await assert.rejects(() => f.passkeys.verifyRegistration(tokenB, { response: valid }, issued.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  for (const changes of [
    { clientData: { challenge: b64(randomBytes(32)) } }, { clientData: { origin: 'https://evil.example' } },
    { authData: { rp: 'evil.example' } }, { authData: { flags: 0x41 } }, { clientData: { crossOrigin: true } }
  ]) {
    await assert.rejects(() => f.passkeys.verifyRegistration(tokenA, { response: registration(key, issued.options, changes) }, issued.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
  }
  await assert.rejects(() => f.passkeys.verifyRegistration(tokenA, { response: { id: b64(key.id), publicKey: b64(key.x) } }, issued.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
  assert.equal((await f.store.read()).users[0].passkeys, undefined);
  f.advance(PASSKEY_CHALLENGE_MS);
  await assert.rejects(() => f.passkeys.verifyRegistration(tokenA, { response: valid }, issued.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
});

test('discoverable options reveal no account credentials; real signature login preserves the other device', async () => {
  const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
  assert.deepEqual(issued.options.allowCredentials, []);
  assert.equal(issued.options.userVerification, 'required');
  assert.ok(!JSON.stringify(issued.options).includes('Player'));
  const result = await f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken, { userAgent: 'iPhone Safari/1' });
  assert.equal(result.user.username, 'Player0'); assert.equal(result.remember, true);
  assert.ok(result.token); assert.ok(result.deviceToken);
  const stored = (await f.store.read()).users[0];
  assert.equal(stored.passkeys[0].counter, 1); assert.ok(stored.passkeys[0].lastUsedAt);
  assert.equal(stored.sessions.length, 2); assert.ok(await f.auth.session(tokenA));
  assert.ok((await f.auth.session(tokenA)).notifications.some(item => item.type === 'new-device'));
  assert.ok(!result.user.notifications.some(item => item.type === 'new-device'));
});

test('authentication verifies origin, challenge, RP ID, UV, signature, user handle and counter', async () => {
  const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
  const bad = [
    assertion(authenticator, issued.options, undefined, { clientData: { origin: 'https://evil.example' } }),
    assertion(authenticator, issued.options, undefined, { clientData: { challenge: b64(randomBytes(32)) } }),
    assertion(authenticator, issued.options, undefined, { clientData: { crossOrigin: true } }),
    assertion(authenticator, issued.options, undefined, { authData: { rp: 'evil.example' } }),
    assertion(authenticator, issued.options, undefined, { authData: { flags: 1 } }),
    assertion(authenticator, issued.options, database().users[1])
  ];
  const forged = assertion(authenticator, issued.options); forged.response.signature = b64(randomBytes(64)); bad.push(forged);
  const noHandle = assertion(authenticator, issued.options); delete noHandle.response.userHandle; bad.push(noHandle);
  const rawId = assertion(authenticator, issued.options); rawId.rawId = b64(randomBytes(32)); bad.push(rawId);
  for (const response of bad) await assert.rejects(() => f.passkeys.verifyAuthentication({ response }, issued.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
  assert.equal((await f.store.read()).users[0].sessions.length, 1);
  assert.equal((await f.store.read()).users[0].passkeys[0].counter, 0);
  await f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken);
  const next = await f.challenge();
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, next.options) }, next.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
});

test('authentication cannot move to a different browser, outlive five minutes, or replay', async () => {
  const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
  const response = assertion(authenticator, issued.options);
  for (const binding of [undefined, 'Z'.repeat(43)]) {
    await assert.rejects(() => f.passkeys.verifyAuthentication({ response }, binding), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  }
  const result = await f.passkeys.verifyAuthentication({ response }, issued.bindingToken);
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response }, issued.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  assert.ok(await f.auth.session(result.token));
  const expired = await f.challenge(); f.advance(PASSKEY_CHALLENGE_MS);
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, expired.options, undefined, { authData: { counter: 2 } }) }, expired.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  assert.equal((await f.store.read()).users[0].sessions.length, 2);
});

test('concurrent copies of the same assertion create exactly one session through CAS', async () => {
  const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
  const input = { response: assertion(authenticator, issued.options) };
  const results = await Promise.allSettled([f.passkeys.verifyAuthentication(input, issued.bindingToken), f.passkeys.verifyAuthentication(input, issued.bindingToken)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.read()).users[0].sessions.length, 2);
  assert.ok(f.store.conflicts >= 1);
});

test('zero-counter synced passkeys remain usable without permitting a consumed challenge to replay', async () => {
  const f = await fixture(); const { authenticator } = await f.register();
  for (let index = 0; index < 2; index++) {
    const issued = await f.challenge();
    const response = assertion(authenticator, issued.options, undefined, { authData: { counter: 0 } });
    await f.passkeys.verifyAuthentication({ response }, issued.bindingToken);
    await assert.rejects(() => f.passkeys.verifyAuthentication({ response }, issued.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
  }
  assert.equal((await f.store.read()).users[0].passkeys[0].counter, 0);
  assert.equal((await f.store.read()).users[0].sessions.length, 3);
});

test('a challenge that expires during cryptographic verification cannot be committed', async () => {
  for (const phase of ['register', 'authenticate']) {
    let f;
    const method = phase === 'register' ? 'verifyRegistrationResponse' : 'verifyAuthenticationResponse';
    const implementation = { ...verifier, [method]: async options => {
      const result = await verifier[method](options); f.advance(PASSKEY_CHALLENGE_MS); return result;
    } };
    f = await fixture({ implementation });
    if (phase === 'register') {
      await assert.rejects(() => f.register(), rejectCode('PASSKEY_CHALLENGE_INVALID'));
      assert.equal((await f.store.read()).users[0].passkeys, undefined);
    } else {
      const { authenticator } = await f.register(); const issued = await f.challenge();
      await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken), rejectCode('PASSKEY_CHALLENGE_INVALID'));
      assert.equal((await f.store.read()).users[0].sessions.length, 1);
      assert.equal((await f.store.read()).users[0].passkeys[0].counter, 0);
    }
  }
});

test('credential IDs are globally unique even when two valid registrations race', async () => {
  const f = await fixture(); const key = keypair();
  const first = await f.passkeys.registrationOptions(tokenA, { password });
  const second = await f.passkeys.registrationOptions(tokenB, { password });
  const results = await Promise.allSettled([
    f.passkeys.verifyRegistration(tokenA, { response: registration(key, first.options) }, first.bindingToken),
    f.passkeys.verifyRegistration(tokenB, { response: registration(key, second.options) }, second.bindingToken)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PASSKEY_DUPLICATE');
  assert.equal((await f.store.read()).users.flatMap(user => user.passkeys || []).length, 1);
});

test('ten-passkey maximum is rechecked during the registration commit', async () => {
  const f = await fixture(); await f.register();
  const first = await f.passkeys.registrationOptions(tokenA, { password });
  const second = await f.passkeys.registrationOptions(tokenA, { password });
  await f.store.mutate(db => { const key = db.users[0].passkeys[0]; db.users[0].passkeys = Array.from({ length: 9 }, () => ({ ...key, id: b64(randomBytes(32)) })); });
  const results = await Promise.allSettled([
    f.passkeys.verifyRegistration(tokenA, { response: registration(keypair(), first.options) }, first.bindingToken),
    f.passkeys.verifyRegistration(tokenA, { response: registration(keypair(), second.options) }, second.bindingToken)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.read()).users[0].passkeys.length, 10);
  await assert.rejects(() => f.passkeys.registrationOptions(tokenA, { password }), rejectCode('PASSKEY_LIMIT'));
});

test('deleting the last key requires password reauthentication and invalidates pending login', async () => {
  const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
  const id = b64(authenticator.id);
  await assert.rejects(() => f.passkeys.remove(tokenA, { id, password: 'incorrect-fixture-password' }), error => error.status === 403 && error.code === 'REAUTH_FAILED');
  await assert.rejects(() => f.passkeys.remove(tokenB, { id, password }), rejectCode('PASSKEY_NOT_FOUND'));
  assert.equal((await f.passkeys.remove(tokenA, { id, password })).passkeys.length, 0);
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
  assert.ok(await f.auth.session(tokenA));
});

test('a key deleted while its signature is verifying cannot create a session after CAS retry', async () => {
  let f; let deleted = false;
  const implementation = { ...verifier, verifyAuthenticationResponse: async options => {
    const result = await verifier.verifyAuthenticationResponse(options);
    if (!deleted) { deleted = true; await f.store.mutate(db => { db.users[0].passkeys = []; }); }
    return result;
  } };
  f = await fixture({ implementation }); const { authenticator } = await f.register(); const issued = await f.challenge();
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken), rejectCode('PASSKEY_VERIFICATION_FAILED'));
  assert.equal((await f.store.read()).users[0].sessions.length, 1); assert.ok(f.store.conflicts >= 1);
});

test('ban, account deletion and password changes still block cryptographically valid passkeys', async () => {
  for (const change of ['ban', 'delete', 'password']) {
    const f = await fixture(); const { authenticator } = await f.register(); const issued = await f.challenge();
    await f.store.mutate(db => {
      if (change === 'ban') db.users[0].ban = { reason: 'fixture ban', createdAt: initialTime, until: null };
      if (change === 'delete') db.users.shift();
      if (change === 'password') db.users[0].passwordHash = passwordHash.replace(/.$/, passwordHash.endsWith('a') ? 'b' : 'a');
    });
    await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(authenticator, issued.options) }, issued.bindingToken), error => change === 'ban' ? error.code === 'ACCOUNT_BANNED' : error.status === 401);
    assert.ok(!(await f.store.read()).users.some(user => user.sessions.length > 1));
  }
});

test('admin passkeys work with the current env hash and are rejected immediately after rotation', async () => {
  const f = await fixture({ admin: true });
  const loggedIn = await f.auth.loginAdmin(password, false);
  const registered = await f.register(loggedIn.token);
  const issued = await f.challenge();
  const admin = (await f.store.read()).users.find(user => user.key === 'admindevs');
  const result = await f.passkeys.verifyAuthentication({ response: assertion(registered.authenticator, issued.options, admin) }, issued.bindingToken);
  assert.equal(result.user.role, 'admin');
  const next = await f.challenge();
  f.auth.adminPasswordHash = await hashPassword('new-synthetic-administrator-password');
  await assert.rejects(() => f.passkeys.verifyAuthentication({ response: assertion(registered.authenticator, next.options, admin, { authData: { counter: 2 } }) }, next.bindingToken), error => error.status === 401);
  assert.equal(await f.auth.session(result.token), null);
});

test('verified credentials and challenges round-trip through the real store without changing legacy users', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-passkeys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore(path.join(directory, 'user.txt'));
  await store.mutate(db => Object.assign(db, database()));
  const f = await fixture({ store }); const registered = await f.register(); const issued = await f.challenge();
  await f.passkeys.verifyAuthentication({ response: assertion(registered.authenticator, issued.options) }, issued.bindingToken);
  const persisted = await new LocalStore(store.file).read();
  assert.equal(persisted.users[0].passkeys[0].counter, 1);
  assert.equal(persisted.users[0].passwordHash, passwordHash);
  assert.deepEqual(persisted.users[1], database().users[1]);
});
