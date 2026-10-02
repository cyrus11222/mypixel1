import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, hashPassword, tokenHash, COMMUNITY_AGREEMENT_VERSION, DEFAULT_AGREEMENT, verifyPassword } from '../lib/auth.mjs';
import { GitHubStore } from '../lib/store.mjs';

const password = 'recovery-fixture-current-password';
const nextPassword = 'recovery-fixture-next-password';
const passwordHash = await hashPassword(password);
const rateSecret = 'recovery-fixture-only-'.repeat(4);
const start = Date.parse('2026-10-02T12:00:00+08:00');
const tokenA = 'A'.repeat(43), tokenOtherDevice = 'D'.repeat(43), tokenB = 'B'.repeat(43);
function repository() {
  const state = { text: null, revision: 0, conflicts: 0 };
  const fetcher = async (url, options = {}) => {
    if (!url.includes('/contents/')) return Response.json({ private: false, name: 'main' });
    if (options.method !== 'PUT') return state.text === null ? new Response('', { status: 404 }) : Response.json({ type: 'file', encoding: 'base64', size: Buffer.byteLength(state.text), content: Buffer.from(state.text).toString('base64'), sha: String(state.revision) });
    const request = JSON.parse(options.body);
    if (request.sha !== (state.text === null ? undefined : String(state.revision))) { state.conflicts++; return new Response('', { status: 409 }); }
    state.text = Buffer.from(request.content, 'base64').toString(); state.revision++; return Response.json({});
  };
  state.store = () => new GitHubStore({ owner: 'test', repo: 'test', branch: 'main', token: 'test-only', encryptionKey: 'ab'.repeat(32), fetcher });
  return state;
}
async function setup() {
  let now = start; const remote = repository();
  await remote.store().mutate(db => { db.users = [
    { id: 'player', username: 'PlayerOne', key: 'playerone', passwordHash, sessions: [tokenA, tokenOtherDevice].map(token => ({ hash: tokenHash(token), expiresAt: start + 86_400_000 })) },
    { id: 'other', username: 'OtherPlayer', key: 'otherplayer', passwordHash, sessions: [{ hash: tokenHash(tokenB), expiresAt: start + 86_400_000 }] }
  ]; });
  const service = () => new AuthService(remote.store(), { now: () => now, rateSecret, adminPasswordHash: passwordHash });
  const auth = service();
  const code = async () => { const result = await auth.generateRecoveryCode(tokenA, { currentPassword: password }, 'fixture-ip'); await auth.confirmRecoveryCode(tokenA, { confirmationId: result.confirmationId }); return result.recoveryCode; };
  return { auth, service, remote, code, clock: value => { now = value; } };
}
function credential(version = passwordHash, id = 'dGVzdC1jcmVkZW50aWFs') {
  return { id, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, userHandle: 'H'.repeat(43), credentialVersion: tokenHash(version), transports: ['hybrid'], name: 'Test phone', createdAt: start, lastUsedAt: null };
}

test('legacy and newly registered players must complete recovery setup before game, community or ticket writes', async () => {
  const { auth, remote } = await setup();
  assert.equal((await auth.session(tokenA)).recovery.required, true);
  await remote.store().mutate(db => { db.users[0].ticketReviewer = true; });
  const blocked = error => error.code === 'RECOVERY_SETUP_REQUIRED';
  await assert.rejects(() => auth.bindGame(tokenA, { gameId: 'GameOne' }), blocked);
  await assert.rejects(() => auth.joinCommunity(tokenA, { accepted: true, agreementVersion: COMMUNITY_AGREEMENT_VERSION }), blocked);
  await assert.rejects(() => auth.createTicket(tokenA, { type: 'op', purpose: '测试用途', durationMinutes: 5, opLevel: 2 }), blocked);
  await assert.rejects(() => auth.reviewTicket(tokenA, { ticketId: 'missing', decision: 'approved' }), blocked);
  const registered = await auth.register({ username: 'NewPlayer', password, remember: true }, 'new-ip');
  assert.equal(registered.user.recovery.required, true); assert.ok(await auth.session(registered.token));
  assert.equal((await auth.publicConfig()).agreement.version, COMMUNITY_AGREEMENT_VERSION);
});

test('recovery codes are high-entropy, displayed only once, hashed in storage and require explicit save confirmation', async () => {
  const { auth, remote } = await setup();
  await assert.rejects(() => auth.generateRecoveryCode(tokenA, { currentPassword: 'incorrect-test-password' }, 'wrong-ip'), error => error.code === 'REAUTH_FAILED');
  const pending = await auth.generateRecoveryCode(tokenA, { currentPassword: password }, 'fixture-ip');
  assert.match(pending.recoveryCode, /^MPC-[A-Za-z0-9_-]{32}$/); assert.equal(pending.expiresInSeconds, 600);
  assert.equal((await auth.session(tokenA)).recovery.required, true); assert.equal((await auth.session(tokenA)).recovery.codePending, true);
  await assert.rejects(() => auth.verifyRecoveryCode({ code: pending.recoveryCode }, 'before-save'), error => error.code === 'RECOVERY_INVALID');
  await assert.rejects(() => auth.confirmRecoveryCode(tokenB, { confirmationId: pending.confirmationId }), error => error.status === 400);
  const confirmed = await auth.confirmRecoveryCode(tokenA, { confirmationId: pending.confirmationId });
  assert.equal(confirmed.recovery.required, false); assert.equal(confirmed.recovery.hasRecoveryCode, true); assert.equal(confirmed.recovery.codePending, false);
  const db = await remote.store().read(); const saved = JSON.stringify(db);
  assert.ok(!saved.includes(pending.recoveryCode)); assert.ok(!saved.includes(pending.confirmationId));
  assert.match(db.users[0].recoveryCode.hash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(confirmed).includes('recoveryCode'));
  assert.ok(!remote.text.includes(pending.recoveryCode));
});

test('opening generation keeps the active code; confirming replaces it and revokes old code grants', async () => {
  const { auth, code } = await setup(); const original = await code();
  const grant = await auth.verifyRecoveryCode({ username: 'PLAYERONE', code: original }, 'verify-1');
  const pending = await auth.generateRecoveryCode(tokenA, { currentPassword: password }, 'fixture-ip');
  assert.equal((await auth.session(tokenA)).recovery.hasRecoveryCode, true);
  const latestGrant = await auth.verifyRecoveryCode({ code: original }, 'verify-2');
  assert.notEqual(latestGrant.grantToken, grant.grantToken);
  await auth.confirmRecoveryCode(tokenA, { confirmationId: pending.confirmationId });
  await assert.rejects(() => auth.resetPassword(grant.grantToken, { newPassword: nextPassword }), error => error.code === 'RECOVERY_INVALID');
  await assert.rejects(() => auth.resetPassword(latestGrant.grantToken, { newPassword: nextPassword }), error => error.code === 'RECOVERY_INVALID');
  await assert.rejects(() => auth.verifyRecoveryCode({ code: original }, 'verify-old'), error => error.code === 'RECOVERY_INVALID');
  assert.equal((await auth.verifyRecoveryCode({ code: pending.recoveryCode }, 'verify-new')).username, 'PlayerOne');
});

test('cancelled or expired verification does not consume a recovery code; grants are restricted and expire at five minutes', async () => {
  const { auth, code, remote, clock } = await setup(); const recoveryCode = await code();
  const first = await auth.verifyRecoveryCode({ code: recoveryCode }, 'verify-first');
  assert.equal(first.recoveryGranted, true); assert.equal(first.username, 'PlayerOne'); assert.equal(first.expiresInSeconds, 300);
  assert.equal(await auth.session(first.grantToken), null); assert.equal((await remote.store().read()).users[0].sessions.length, 2);
  clock(start + 300_000);
  await assert.rejects(() => auth.resetPassword(first.grantToken, { newPassword: nextPassword }), error => error.code === 'RECOVERY_INVALID');
  const second = await auth.verifyRecoveryCode({ code: recoveryCode }, 'verify-second'); assert.notEqual(first.grantToken, second.grantToken);
  assert.equal((await auth.session(tokenA)).recovery.hasRecoveryCode, true);
  const db = await remote.store().read(); assert.ok(!JSON.stringify(db).includes(second.grantToken));
  assert.equal(db.recoveryGrants.length, 1); assert.match(db.recoveryGrants[0].proofRecoveryCodeHash, /^[a-f0-9]{64}$/);
});

test('password recovery is atomic, single-use, revokes every old credential and keeps existing bans', async () => {
  const { auth, service, remote, code } = await setup(); const recoveryCode = await code();
  await remote.store().mutate(db => { db.users[0].passkeys = [credential()]; db.users[0].ban = { reason: 'existing ban', createdAt: start, until: null }; });
  const grant = await auth.verifyRecoveryCode({ code: recoveryCode }, 'recovery-ip');
  const results = await Promise.allSettled([
    auth.resetPassword(grant.grantToken, { newPassword: nextPassword }),
    service().resetPassword(grant.grantToken, { newPassword: 'other-concurrent-new-password' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'RECOVERY_INVALID');
  const user = (await remote.store().read()).users[0];
  assert.deepEqual(user.sessions, []); assert.deepEqual(user.passkeys, []); assert.equal(user.recoveryCode, null); assert.equal(user.ban.reason, 'existing ban');
  assert.equal(auth.recoveryStatus(user).required, true); assert.equal(await auth.session(tokenA), null); assert.equal(await auth.session(tokenOtherDevice), null);
  const winning = results[0].status === 'fulfilled' ? nextPassword : 'other-concurrent-new-password';
  assert.equal(await verifyPassword(winning, user.passwordHash), true);
  await assert.rejects(() => auth.login({ username: user.username, password: winning, remember: true }, 'login-banned'), error => error.code === 'ACCOUNT_BANNED');
  await assert.rejects(() => auth.verifyRecoveryCode({ code: recoveryCode }, 'replay-code'), error => error.code === 'RECOVERY_INVALID');
});

test('normal password changes preserve active recovery methods, rotate only the current browser and invalidate old grants', async () => {
  const { auth, remote, code } = await setup(); const recoveryCode = await code();
  const oldGrant = await auth.verifyRecoveryCode({ code: recoveryCode }, 'grant-before-password-change');
  await remote.store().mutate(db => { db.users[0].passkeys = [credential(), credential('stale-password-hash', 'c3RhbGUtY3JlZGVudGlhbA')]; });
  const oldHash = (await remote.store().read()).users[0].passwordHash;
  await assert.rejects(() => auth.changePassword(tokenA, { oldPassword: 'wrong-password-value', newPassword: nextPassword }), error => error.code === 'REAUTH_FAILED');
  const result = await auth.changePassword(tokenA, { oldPassword: password, newPassword: nextPassword }, { ip: 'change-password', userAgent: 'Windows Chrome/1' });
  assert.equal(await auth.session(tokenA), null); assert.equal(await auth.session(tokenOtherDevice), null); assert.ok(await auth.session(result.token));
  const user = (await remote.store().read()).users[0]; assert.notEqual(user.passwordHash, oldHash); assert.equal(await verifyPassword(nextPassword, user.passwordHash), true);
  assert.equal(user.passkeyNotBefore, start);
  assert.equal(user.passkeys.length, 1); assert.equal(user.passkeys[0].credentialVersion, tokenHash(user.passwordHash));
  assert.equal(result.user.recovery.hasPasskey, true); assert.equal(result.user.recovery.hasRecoveryCode, true); assert.equal(result.user.recovery.required, false);
  await assert.rejects(() => auth.resetPassword(oldGrant.grantToken, { newPassword: 'forbidden-grant-new-password' }), error => error.code === 'RECOVERY_INVALID');
});

test('pending confirmation expires without destroying the active code and a removed passkey invalidates its grant', async () => {
  const { auth, code, remote, clock } = await setup(); const original = await code();
  const pending = await auth.generateRecoveryCode(tokenA, { currentPassword: password }, 'fixture-ip');
  clock(start + 600_000);
  await assert.rejects(() => auth.confirmRecoveryCode(tokenA, { confirmationId: pending.confirmationId }), error => error.status === 400);
  assert.equal((await auth.session(tokenA)).recovery.hasRecoveryCode, true);
  await auth.verifyRecoveryCode({ code: original }, 'still-valid');
  const key = credential(); await remote.store().mutate(db => { db.users[0].passkeys = [key]; });
  const grant = await auth.finishRecoveryVerification('player', { expectedPasswordHash: passwordHash, proofPasskeyId: key.id, authorize: () => {} });
  await remote.store().mutate(db => { db.users[0].passkeys = []; });
  await assert.rejects(() => auth.resetPassword(grant.grantToken, { newPassword: nextPassword }), error => error.code === 'RECOVERY_INVALID');
});

test('unknown grant tokens are rejected before password hashing work or storage mutations', async () => {
  const { auth, remote } = await setup(); const revision = remote.revision; let preparedHash = false;
  auth.newPassword = () => { preparedHash = true; return nextPassword; };
  await assert.rejects(() => auth.resetPassword('X'.repeat(43), { newPassword: nextPassword }), error => error.code === 'RECOVERY_INVALID');
  assert.equal(preparedHash, false); assert.equal(remote.revision, revision);
});

test('bad recovery attempts have uniform failures without account or phone enumeration and are rate limited', async () => {
  const { auth, code } = await setup(); const recoveryCode = await code();
  const errors = [];
  for (const username of ['PlayerOne', 'MissingPlayer', 'OtherPlayer']) {
    try { await auth.verifyRecoveryCode({ username, code: 'MPC-' + 'X'.repeat(32) }, 'uniform-ip'); } catch (error) { errors.push([error.status, error.code, error.message]); }
  }
  assert.deepEqual(errors[0], errors[1]); assert.deepEqual(errors[1], errors[2]);
  await assert.rejects(() => auth.verifyRecoveryCode({ username: 'OtherPlayer', code: recoveryCode }, 'mismatched'), error => error.code === 'RECOVERY_INVALID');
  for (let attempt = 0; attempt < 10; attempt++) await assert.rejects(() => auth.verifyRecoveryCode({ code: 'not-a-code' }, 'limited-ip'), error => error.code === 'RECOVERY_INVALID');
  await assert.rejects(() => auth.verifyRecoveryCode({ code: recoveryCode }, 'limited-ip'), error => error.status === 429);
});

test('optional phone stays in encrypted account data, is not an authentication method and requires current password', async () => {
  const { auth, remote } = await setup();
  await assert.rejects(() => auth.setPhone(tokenA, { currentPassword: 'wrong-test-password', phone: '+86 13800138000' }, 'wrong-ip'), error => error.code === 'REAUTH_FAILED');
  const updated = await auth.setPhone(tokenA, { currentPassword: password, phone: '+86 13800138000' }, 'profile-ip');
  assert.equal(updated.phone, '+8613800138000'); assert.equal((await auth.session(tokenB)).phone, null);
  assert.ok(!remote.text.includes('13800138000')); assert.ok(!JSON.stringify(await auth.publicConfig()).includes('13800138000'));
  await assert.rejects(() => auth.verifyRecoveryCode({ username: '+8613800138000', code: 'not-valid' }, 'phone-ip'), error => error.code === 'RECOVERY_INVALID');
  assert.equal((await auth.setPhone(tokenA, { currentPassword: password, phone: '' }, 'profile-ip')).phone, null);
});

test('administrator passwords remain environment-managed and legacy agreement overrides cannot hide the new seven clauses', async () => {
  const { auth, remote } = await setup();
  const admin = await auth.login({ username: 'admindevs', password, remember: true }, 'admin-ip');
  assert.equal(admin.user.recovery.adminManaged, true); assert.equal(admin.user.recovery.required, false);
  for (const operation of [() => auth.generateRecoveryCode(admin.token, { currentPassword: password }, 'ip'), () => auth.changePassword(admin.token, { oldPassword: password, newPassword: nextPassword })]) {
    await assert.rejects(operation, error => error.code === 'ADMIN_PASSWORD_MANAGED');
  }
  const adminRecord = (await remote.store().read()).users.find(user => user.key === 'admindevs');
  await assert.rejects(() => auth.finishRecoveryVerification(adminRecord.id, { expectedPasswordHash: passwordHash, authorize: () => {} }), error => error.code === 'ADMIN_PASSWORD_MANAGED');
  await remote.store().mutate(db => { db.settings = { devplayerAgreement: { content: 'old custom agreement', version: '2026-10-01-v9', updatedAt: start } }; });
  assert.deepEqual((await auth.publicConfig()).agreement, DEFAULT_AGREEMENT); assert.match(DEFAULT_AGREEMENT.content, /PWDC/); assert.match(DEFAULT_AGREEMENT.content, /SkyWolf Technology/);
  const result = await auth.adminCommand(admin.token, { command: 'setintty devplayer latest custom agreement' });
  assert.equal(result.agreement.baselineVersion, COMMUNITY_AGREEMENT_VERSION); assert.equal((await auth.publicConfig()).agreement.content, 'latest custom agreement');
});
