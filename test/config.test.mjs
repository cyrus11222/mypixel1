import test from 'node:test';
import assert from 'node:assert/strict';
import authHandler from '../api/auth.js';
import siteHandler from '../api/site.js';
import { settings, token, cookie, checkOrigin, failure } from '../lib/http.mjs';

const productionOrigin = 'https://www.mypixel.com.cn';
const environmentNames = [
  'VERCEL', 'AUTH_STORE', 'APP_ORIGIN', 'GITHUB_OWNER', 'GITHUB_REPO',
  'GITHUB_BRANCH', 'GITHUB_TOKEN', 'RATE_LIMIT_SECRET', 'DATA_ENCRYPTION_KEY', 'LOCAL_DATA_FILE'
];

async function withEnvironment(values, run) {
  const before = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  try {
    for (const name of environmentNames) delete process.env[name];
    process.env.VERCEL = '1';
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function response() {
  return {
    statusCode: 200,
    headers: new Map(),
    text: '',
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    end(value = '') { this.text += value; },
    json() { return JSON.parse(this.text); }
  };
}

function request(action, { method = 'POST', origin = productionOrigin, session = '', headers = {} } = {}) {
  return {
    method,
    url: '/api/auth?action=' + action,
    headers: { 'content-type': 'application/json', origin, cookie: session, ...headers },
    body: { username: 'ConfigPlayer', password: 'test-password-only', remember: true }
  };
}

test('production configuration and logged-out requests fail safely without exposing secrets', async t => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected external request in configuration test.'); };
  console.error = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });

  await t.test('known deployment origin is the production default and harmless formatting is normalized', async () => {
    await withEnvironment({}, () => {
      assert.equal(settings().origin, productionOrigin);
      assert.equal(settings().local, false);
    });
    await withEnvironment({ APP_ORIGIN: '  https://www.mypixel.com.cn/  ' }, () => {
      assert.equal(settings().origin, productionOrigin);
    });
    await withEnvironment({ VERCEL: undefined, AUTH_STORE: 'local' }, () => {
      assert.equal(settings().origin, 'http://127.0.0.1:3000');
      assert.equal(settings().local, true);
    });
  });

  await t.test('production origins reject insecure protocols, paths, query strings, fragments and user information', async () => {
    for (const origin of [
      'http://www.mypixel.com.cn',
      productionOrigin + '/login',
      productionOrigin + '/?key=origin-secret-sentinel',
      productionOrigin + '/#section',
      'https://username:origin-secret-sentinel@www.mypixel.com.cn',
      'not-an-origin'
    ]) {
      await withEnvironment({ APP_ORIGIN: origin }, () => {
        assert.throws(() => settings(), error => error.status === 503 && error.code === 'AUTH_CONFIG_INVALID');
      });
    }
  });

  await t.test('absent and malformed session cookies do not initialize storage or validate origin', async () => {
    await withEnvironment({ APP_ORIGIN: 'invalid-origin' }, async () => {
      for (const session of ['', '__Host-mypixel_session=malformed', '__Host-mypixel_session=' + '!'.repeat(43)]) {
        const me = response();
        await authHandler(request('me', { method: 'GET', session }), me);
        assert.equal(me.statusCode, 401);
        assert.equal(me.json().user, undefined);
        assert.match(me.headers.get('cache-control'), /no-store/);

        const page = response();
        await siteHandler({ method: 'GET', url: '/', headers: { cookie: session } }, page);
        assert.equal(page.statusCode, 302);
        assert.equal(page.headers.get('location'), '/login');
        assert.equal(page.text, '');
      }
    });
  });

  await t.test('cookie handling is independent of origin settings and retains production flags', async () => {
    await withEnvironment({ APP_ORIGIN: 'invalid-origin' }, () => {
      const validToken = 'a'.repeat(43);
      assert.equal(token({ headers: { cookie: 'other=value; __Host-mypixel_session=' + validToken } }), validToken);
      assert.equal(token({ headers: {} }), '');
      assert.match(cookie('example', true), /^__Host-mypixel_session=example; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$/);
      assert.match(cookie('', false, true), /Secure; Max-Age=0$/);
    });
  });

  await t.test('an apparent existing session still requires valid service configuration', async () => {
    await withEnvironment({ APP_ORIGIN: 'invalid-origin' }, async () => {
      const result = response();
      await authHandler(request('me', { method: 'GET', session: '__Host-mypixel_session=' + 'a'.repeat(43) }), result);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().code, 'AUTH_CONFIG_INVALID');
      assert.equal(result.json().user, undefined);
    });
  });

  await t.test('login reports required configuration names without authenticating', async () => {
    await withEnvironment({ APP_ORIGIN: productionOrigin }, async () => {
      const result = response();
      await authHandler(request('login'), result);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().code, 'AUTH_CONFIG_MISSING');
      for (const name of ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN', 'RATE_LIMIT_SECRET', 'DATA_ENCRYPTION_KEY']) {
        assert.ok(result.text.includes(name), `Missing actionable configuration name: ${name}`);
      }
      assert.equal(result.json().user, undefined);
      assert.equal(result.headers.has('set-cookie'), false);
    });
  });

  await t.test('short rate secrets remain invalid and no secret value reaches responses or logs', async () => {
    await withEnvironment({
      APP_ORIGIN: productionOrigin,
      GITHUB_OWNER: 'test-owner',
      GITHUB_REPO: 'private-accounts',
      GITHUB_BRANCH: 'main',
      GITHUB_TOKEN: 'github-secret-sentinel',
      RATE_LIMIT_SECRET: 'short-secret-sentinel',
      DATA_ENCRYPTION_KEY: 'ab'.repeat(32)
    }, async () => {
      const result = response();
      await authHandler(request('register'), result);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().code, 'AUTH_CONFIG_INVALID');
      assert.match(result.text, /RATE_LIMIT_SECRET/);
      for (const secret of ['github-secret-sentinel', 'short-secret-sentinel']) {
        assert.ok(!result.text.includes(secret));
        assert.ok(!logs.join('\n').includes(secret));
      }
      assert.equal(result.headers.has('set-cookie'), false);
    });
  });

  await t.test('encryption key is required even when all other production variables are set', async () => {
    await withEnvironment({
      APP_ORIGIN: productionOrigin,
      GITHUB_OWNER: 'test-owner',
      GITHUB_REPO: 'public-accounts',
      GITHUB_TOKEN: 'github-secret-sentinel',
      RATE_LIMIT_SECRET: 'rate-secret-sentinel-'.repeat(3)
    }, async () => {
      const result = response();
      await authHandler(request('register'), result);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().code, 'AUTH_CONFIG_MISSING');
      assert.deepEqual(result.json().fields, ['DATA_ENCRYPTION_KEY']);
      assert.equal(result.headers.has('set-cookie'), false);
    });
  });

  await t.test('malformed encryption keys report only their variable name', async () => {
    for (const encryptionKey of ['key-secret-sentinel', 'ab'.repeat(31), 'gh'.repeat(32), 'ab'.repeat(33)]) {
      await withEnvironment({
        APP_ORIGIN: productionOrigin,
        GITHUB_OWNER: 'test-owner',
        GITHUB_REPO: 'public-accounts',
        GITHUB_TOKEN: 'github-secret-sentinel',
        RATE_LIMIT_SECRET: 'rate-secret-sentinel-'.repeat(3),
        DATA_ENCRYPTION_KEY: encryptionKey
      }, async () => {
        const result = response();
        await authHandler(request('register'), result);
        assert.equal(result.statusCode, 503);
        assert.equal(result.json().code, 'AUTH_CONFIG_INVALID');
        assert.deepEqual(result.json().fields, ['DATA_ENCRYPTION_KEY']);
        for (const secret of [encryptionKey, 'github-secret-sentinel', 'rate-secret-sentinel-'.repeat(3)]) {
          assert.ok(!result.text.includes(secret));
          assert.ok(!logs.join('\n').includes(secret));
        }
        assert.equal(result.headers.has('set-cookie'), false);
      });
    }
  });

  await t.test('origin failures never disclose raw origin credentials', async () => {
    await withEnvironment({ APP_ORIGIN: 'https://username:origin-secret-sentinel@www.mypixel.com.cn' }, async () => {
      const result = response();
      await authHandler(request('login'), result);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().code, 'AUTH_CONFIG_INVALID');
      assert.match(result.text, /APP_ORIGIN/);
      assert.ok(!result.text.includes('origin-secret-sentinel'));
      assert.ok(!logs.join('\n').includes('origin-secret-sentinel'));
    });
  });

  await t.test('normalization does not accept arbitrary or cross-site request origins', async () => {
    await withEnvironment({ APP_ORIGIN: '  ' + productionOrigin + '/  ' }, async () => {
      assert.doesNotThrow(() => checkOrigin(request('login')));
      for (const options of [
        { origin: 'https://attacker.invalid', headers: { host: 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid' } },
        { origin: productionOrigin, headers: { 'sec-fetch-site': 'cross-site' } }
      ]) {
        const result = response();
        await authHandler(request('login', options), result);
        assert.equal(result.statusCode, 403);
        assert.equal(result.json().user, undefined);
        assert.equal(result.headers.has('set-cookie'), false);
      }
    });
  });

  await t.test('unexpected internal errors do not expose sensitive messages', () => {
    const result = response();
    failure(result, new Error('unexpected-secret-sentinel'));
    assert.equal(result.statusCode, 503);
    assert.ok(!result.text.includes('unexpected-secret-sentinel'));
    assert.ok(!logs.join('\n').includes('unexpected-secret-sentinel'));
  });

  assert.equal(networkCalls, 0, 'Rejected or logged-out requests must not access GitHub.');
});
