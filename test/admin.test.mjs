import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, hashPassword, tokenHash, COMMUNITY_AGREEMENT_VERSION, DEFAULT_AGREEMENT } from '../lib/auth.mjs';
import { GitHubStore } from '../lib/store.mjs';

// Synthetic test credentials. These never authenticate against a real service.
const adminPassword = 'test-admin-password-only';
const executionKey = 'test-execution-key-only';
const playerPassword = 'test-player-password-only';
const [adminPasswordHash, adminExecutionKeyHash, playerPasswordHash] = await Promise.all([adminPassword, executionKey, playerPassword].map(hashPassword));
const rateSecret = 'admin-tests-only-'.repeat(4);
const initialTime = Date.parse('2026-10-01T12:00:00+08:00');
const playerToken = 'P'.repeat(43), reviewerToken = 'R'.repeat(43), otherToken = 'O'.repeat(43), legacyAdminToken = 'L'.repeat(43);
const credentials = (username, password = playerPassword) => ({ username, password, remember: true });
const agreement = { accepted: true, agreementVersion: COMMUNITY_AGREEMENT_VERSION };
const ticketInput = { type: 'op', purpose: '测试机械动力项目', durationMinutes: 30, opLevel: 2 };

function user(username, token) {
  return { id: username, username, key: username.toLowerCase(), passwordHash: playerPasswordHash,
    recoveryCode: { hash: 'e'.repeat(64), createdAt: initialTime, confirmedAt: initialTime },
    sessions: [{ hash: tokenHash(token), expiresAt: initialTime + 100 * 86_400_000 }] };
}
function repository() {
  const remote = { text: null, revision: 0, writes: 0, conflicts: 0, beforePut: null };
  const fetcher = async (url, options = {}) => {
    if (!url.includes('/contents/')) return Response.json({ private: false, name: 'main' });
    if (options.method !== 'PUT') return remote.text === null ? new Response('', { status: 404 }) : Response.json({ type: 'file', encoding: 'base64', size: Buffer.byteLength(remote.text), content: Buffer.from(remote.text).toString('base64'), sha: String(remote.revision) });
    if (remote.beforePut) { const hook = remote.beforePut; remote.beforePut = null; await hook(); }
    const input = JSON.parse(options.body);
    if (input.sha !== (remote.text === null ? undefined : String(remote.revision))) { remote.conflicts++; return new Response('', { status: 409 }); }
    remote.text = Buffer.from(input.content, 'base64').toString(); remote.revision++; remote.writes++; return Response.json({});
  };
  remote.store = () => new GitHubStore({ owner: 'test', repo: 'test', branch: 'main', token: 'test-token', encryptionKey: 'bc'.repeat(32), fetcher });
  return remote;
}
async function setup({ legacyAdmin = false, loginAdmin = true } = {}) {
  let now = initialTime; const remote = repository();
  await remote.store().mutate(db => { db.users = [user('PlayerOne', playerToken), user('Reviewer', reviewerToken), user('OtherPlayer', otherToken), ...(legacyAdmin ? [user('admindevs', legacyAdminToken)] : [])]; });
  const service = options => new AuthService(remote.store(), { now: () => now, rateSecret, adminPasswordHash, adminExecutionKeyHash, ...options });
  const auth = service(); const admin = loginAdmin ? await auth.login(credentials('admindevs', adminPassword), 'admin-ip') : null;
  const command = command => auth.adminCommand(admin.token, { command });
  const member = async (token = playerToken, gameId = 'GamePlayer') => { await auth.bindGame(token, { gameId }); await auth.joinCommunity(token, agreement); };
  return { auth, remote, service, admin, command, member, clock: value => { now = value; } };
}

test('reserved admin bootstraps only through environment password and never upgrades legacy sessions', async () => {
  const { auth, remote, service, clock } = await setup({ legacyAdmin: true, loginAdmin: false });
  assert.equal(await auth.session(legacyAdminToken), null);
  await assert.rejects(() => auth.login(credentials('admindevs'), 'old-password-ip'), error => error.status === 401);
  clock(initialTime + 60_000);
  const admin = await auth.login(credentials('ADMINDEVS', adminPassword), 'correct-password-ip');
  assert.equal(admin.user.role, 'admin'); assert.equal(admin.user.permissions.adminCommands, true);
  assert.equal(await auth.session(legacyAdminToken), null);
  const record = (await remote.store().read()).users.find(user => user.key === 'admindevs');
  assert.equal(record.sessions.length, 1); assert.equal(record.sessions[0].hash, tokenHash(admin.token));
  assert.equal(record.gameBinding, null); assert.equal(record.developerCommunity, null);
  for (const operation of [() => auth.bindGame(admin.token, { gameId: 'AdminGame' }), () => auth.unbindGame(admin.token), () => auth.joinCommunity(admin.token, agreement)]) await assert.rejects(operation, error => error.status === 403);
  assert.equal(await service({ adminPasswordHash: undefined }).session(admin.token), null);
  clock(initialTime + 120_000);
  await assert.rejects(() => auth.register(credentials('admindevs'), 'reserved-ip'), error => error.status === 409);
  const text = JSON.stringify(admin.user); assert.ok(!text.includes('passwordHash')); assert.ok(!text.includes(adminPasswordHash));
});

test('administrator credential rotation invalidates old sessions while normal logins preserve other devices', async () => {
  const { auth, service, admin, clock } = await setup();
  const rotatedHash = await hashPassword('rotated-admin-test-password');
  assert.equal(await service({ adminPasswordHash: rotatedHash }).session(admin.token), null);
  clock(initialTime + 60_000);
  const next = await auth.login(credentials('admindevs', adminPassword), 'next-admin-ip');
  assert.equal((await auth.session(admin.token)).role, 'admin'); assert.equal((await auth.session(next.token)).role, 'admin');
});

test('commands require admin and execution key, parse spaced reasons, ban correctly and never expose ban on wrong password', async () => {
  const { auth, remote, admin, command, clock } = await setup();
  await assert.rejects(() => auth.adminCommand(playerToken, { command: 'unban PlayerOne' }), error => error.status === 403);
  const writes = remote.writes;
  await assert.rejects(() => command('ban 10m multiple word reason PlayerOne wrong-key'), error => error.status === 403);
  assert.equal(remote.writes, writes);
  await command(`ban 10m multiple word reason PlayerOne ${executionKey}`);
  assert.equal(await auth.session(playerToken), null);
  await assert.rejects(() => auth.login(credentials('PlayerOne', 'wrong-test-password'), 'wrong-player-ip'), error => error.status === 401 && !error.ban);
  clock(initialTime + 60_000);
  await assert.rejects(() => auth.login(credentials('PlayerOne'), 'correct-player-ip'), error => error.code === 'ACCOUNT_BANNED' && error.ban.reason === 'multiple word reason' && error.ban.until === initialTime + 600_000);
  clock(initialTime + 600_000);
  const loggedIn = await auth.login(credentials('PlayerOne'), 'expiry-ip'); assert.equal(loggedIn.user.role, 'player');
  await command(`ban inf 永久封禁 PlayerOne ${executionKey}`);
  clock(initialTime + 660_000);
  await assert.rejects(() => auth.login(credentials('PlayerOne'), 'permanent-ip'), error => error.ban?.until === null);
  await command('unban PlayerOne');
  clock(initialTime + 720_000);
  assert.ok((await auth.login(credentials('PlayerOne'), 'unbanned-ip')).user.notifications.some(item => item.type === 'account'));
  for (const commandText of [`ban 10s test admindevs ${executionKey}`, `playerout admindevs ${executionKey}`, 'unban PlayerOne\nztsset add PlayerOne']) await assert.rejects(() => auth.adminCommand(admin.token, { command: commandText }), error => [400, 403].includes(error.status));
});

test('grant and revoke reviewer permissions notify users once after acknowledgement', async () => {
  const { auth, command } = await setup();
  await command('ztsset add Reviewer');
  const granted = await auth.session(reviewerToken); assert.equal(granted.permissions.reviewTickets, true); assert.equal(granted.notifications.length, 1);
  await auth.acknowledgeNotifications(reviewerToken, { ids: granted.notifications.map(item => item.id) });
  assert.deepEqual((await auth.session(reviewerToken)).notifications, []);
  await command('ztsset remove Reviewer');
  const revoked = await auth.session(reviewerToken); assert.equal(revoked.permissions.reviewTickets, false); assert.equal(revoked.notifications.length, 1);
  await assert.rejects(() => auth.listTickets(reviewerToken, true), error => error.status === 403);
});

test('dynamic public agreement requires latest consent for joining, ticket creation and approval', async () => {
  const { auth, command, admin, member } = await setup(); await member();
  const ticket = await auth.createTicket(playerToken, ticketInput);
  assert.deepEqual((await auth.publicConfig()).agreement, DEFAULT_AGREEMENT);
  const updated = await command('setintty devplayer 新的社区协议\n第二条：测试约定');
  assert.notEqual(updated.agreement.version, COMMUNITY_AGREEMENT_VERSION);
  assert.equal((await auth.publicConfig()).agreement.content, '新的社区协议\n第二条：测试约定');
  await assert.rejects(() => auth.joinCommunity(otherToken, agreement), error => error.status === 409);
  await assert.rejects(() => auth.joinCommunity(playerToken, agreement), error => error.status === 400);
  await assert.rejects(() => auth.createTicket(playerToken, ticketInput), error => error.status === 409);
  await assert.rejects(() => auth.reviewTicket(admin.token, { ticketId: ticket.id, decision: 'approved', note: '' }), error => error.status === 409);
  await auth.joinCommunity(playerToken, { accepted: true, agreementVersion: updated.agreement.version });
  assert.equal((await auth.reviewTicket(admin.token, { ticketId: ticket.id, decision: 'approved', note: '' })).status, 'approved');
});

test('tickets require membership, enforce secondary details and protect per-user visibility', async () => {
  const { auth, member, admin } = await setup();
  await assert.rejects(() => auth.createTicket(playerToken, ticketInput), error => error.status === 403);
  await member();
  for (const payload of [{ ...ticketInput, opLevel: 5 }, { ...ticketInput, durationMinutes: -1 }, { ...ticketInput, purpose: '' }, { type: 'creative', purpose: '测试用途', durationMinutes: 10, world: '' }, { type: 'materials', purpose: '测试用途', materials: '' }]) await assert.rejects(() => auth.createTicket(playerToken, payload), error => error.status === 400);
  const op = await auth.createTicket(playerToken, { ...ticketInput, status: 'approved', username: 'admindevs' });
  const creative = await auth.createTicket(playerToken, { type: 'creative', purpose: '创造建筑测试', durationMinutes: 60, world: '创造服' });
  const materials = await auth.createTicket(playerToken, { type: 'materials', purpose: '机械测试', materials: '安山合金 x64，齿轮 x16' });
  assert.equal(op.status, 'pending'); assert.equal(op.username, 'PlayerOne'); assert.equal(op.userId, undefined);
  assert.equal(creative.details.world, '创造服'); assert.match(materials.details.materials, /x64/);
  assert.equal((await auth.listTickets(playerToken)).length, 3); assert.deepEqual(await auth.listTickets(otherToken), []);
  await assert.rejects(() => auth.listTickets(playerToken, true), error => error.status === 403);
  assert.equal((await auth.listTickets(admin.token, true)).length, 3);
});

test('reviewers cannot review themselves, approval waits for execution and emoji review notes persist', async () => {
  const { auth, command, member, admin } = await setup(); await member();
  await command('ztsset add PlayerOne');
  const ticket = await auth.createTicket(playerToken, ticketInput);
  await assert.rejects(() => auth.reviewTicket(playerToken, { ticketId: ticket.id, decision: 'approved', note: '' }), error => error.status === 403);
  const note = '😀'.repeat(1000);
  const reviewed = await auth.reviewTicket(admin.token, { ticketId: ticket.id, decision: 'approved', note });
  assert.equal(reviewed.execution.status, 'pending_configuration'); assert.match(reviewed.execution.message, /尚未发放/);
  assert.equal((await auth.publicConfig()).execution.configured, false);
  assert.ok((await auth.session(playerToken)).notifications.some(item => item.ticketId === ticket.id && item.message.includes(note)));
  await assert.rejects(() => auth.reviewTicket(admin.token, { ticketId: ticket.id, decision: 'rejected', note: '' }), error => error.status === 409);
});

test('review uses current calendar and rechecks permission inside each compare-and-swap retry', async () => {
  const { auth, command, member, remote, clock } = await setup(); await member(); await command('ztsset add Reviewer');
  const ticket = await auth.createTicket(playerToken, ticketInput);
  clock(Date.parse('2026-10-08T12:00:00+08:00'));
  await assert.rejects(() => auth.reviewTicket(reviewerToken, { ticketId: ticket.id, decision: 'approved', note: '' }), error => error.status === 409 && /审核时段/.test(error.message));
  clock(initialTime);
  remote.beforePut = () => remote.store().mutate(db => { db.users.find(user => user.key === 'reviewer').ticketReviewer = false; });
  await assert.rejects(() => auth.reviewTicket(reviewerToken, { ticketId: ticket.id, decision: 'approved', note: '' }), error => error.status === 403);
  assert.ok(remote.conflicts > 0); assert.equal((await auth.listTickets(playerToken))[0].status, 'pending');
});

test('permanent account deletion clears binding, membership, sessions and anonymizes related tickets', async () => {
  const { auth, command, member, remote, admin } = await setup(); await member();
  const ticket = await auth.createTicket(playerToken, ticketInput);
  await command(`playerout PlayerOne ${executionKey}`);
  assert.equal(await auth.session(playerToken), null);
  assert.ok(!(await remote.store().read()).users.some(user => user.key === 'playerone'));
  const remaining = (await auth.listTickets(admin.token, true)).find(item => item.id === ticket.id);
  assert.equal(remaining.username, '已删除账户'); assert.equal(remaining.gameId, null); assert.deepEqual(remaining.details, {}); assert.equal(remaining.status, 'rejected');
  const dbText = JSON.stringify(await remote.store().read()); assert.ok(!dbText.includes('GamePlayer')); assert.ok(!dbText.includes(tokenHash(playerToken)));
});
