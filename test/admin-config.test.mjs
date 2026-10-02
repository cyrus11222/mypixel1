import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthService, hashPassword } from '../lib/auth.mjs';
import { LocalStore } from '../lib/store.mjs';

test('missing administrator configuration is distinct from a wrong password and does not block player login', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-admin-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore(path.join(directory, 'user.txt'));
  let now = 1_900_000_000_000;
  const options = { now: () => now, rateSecret: 'admin-config-test-only-'.repeat(4) };
  const unconfigured = new AuthService(store, options);
  const credentials = (username, password) => ({ username, password, remember: false });
  // Synthetic fixture passwords only; these are not deployment credentials.
  const adminPassword = 'administrator-config-test-password';
  const playerPassword = 'ordinary-player-test-password';

  await assert.rejects(
    () => unconfigured.login(credentials('admindevs', adminPassword), 'admin-test-ip'),
    error => error.status === 503 && error.code === 'ADMIN_NOT_CONFIGURED' &&
      error.message.includes('ADMIN_PASSWORD_HASH') && error.message.includes('Redeploy') &&
      !error.message.includes(adminPassword)
  );
  assert.equal((await store.read()).users.some(user => user.key === 'admindevs'), false);

  await unconfigured.register(credentials('RegularPlayer', playerPassword), 'player-test-ip');
  now += 61_000;
  const player = await unconfigured.login(credentials('RegularPlayer', playerPassword), 'player-test-ip');
  assert.equal(player.user.username, 'RegularPlayer');
  assert.equal(player.user.role, 'player');

  const configured = new AuthService(store, { ...options, adminPasswordHash: await hashPassword(adminPassword) });
  await assert.rejects(
    () => configured.login(credentials('admindevs', 'incorrect-administrator-password'), 'admin-test-ip'),
    error => error.status === 401 && error.code !== 'ADMIN_NOT_CONFIGURED' && error.message === '用户名或密码不正确。'
  );
});
