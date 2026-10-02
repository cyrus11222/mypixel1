import { createHash, randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { AuthError, tokenHash } from './auth.mjs';

export const PASSKEY_CHALLENGE_MS = 300_000;
export const MAX_PASSKEYS = 10;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const webauthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };
const fail = (status, code, message) => Object.assign(new AuthError(status, message), { code });
const invalidChallenge = () => fail(400, 'PASSKEY_CHALLENGE_INVALID', '通行密钥请求已失效，请在同一浏览器重新开始。');
const verificationFailed = (status = 401) => fail(status, 'PASSKEY_VERIFICATION_FAILED', '通行密钥验证失败，请重试或使用密码登录。');
const credentialVersion = user => tokenHash(user.passwordHash);
const userHandle = user => createHash('sha256').update('mypixel-passkey-user:' + user.id).digest('base64url');
const summary = key => ({ id: key.id, name: key.name, transports: [...key.transports], createdAt: key.createdAt, lastUsedAt: key.lastUsedAt });
function base64url(value, max = 1400) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
function responseShape(response, status = 401) {
  if (!response || typeof response !== 'object' || response.type !== 'public-key' || !base64url(response.id) ||
      response.rawId !== response.id || !response.response || typeof response.response !== 'object' ||
      JSON.stringify(response).length > 24_000) throw verificationFailed(status);
  // This site does not embed authentication in another site's iframe. Reject
  // cross-origin ceremonies explicitly, including browsers without topOrigin.
  try {
    if (!base64url(response.response.clientDataJSON, 12_000)) throw Error();
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
    if (!data || (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw Error();
  } catch { throw verificationFailed(status); }
}

/** Cookie transport and same-origin POST checks belong to the HTTP adapter.
 * bindingToken is a server-minted secret: set it as a five-minute HttpOnly,
 * SameSite=Strict cookie and NEVER include it in the JSON options response.
 * finishAuthenticatedLogin must await authorize(db, user) inside its CAS update.
 */
export class PasskeyService {
  constructor(auth, { origin, now = auth.now, verifier = webauthn } = {}) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Invalid passkey origin configuration.'); }
    if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Passkeys require an exact HTTPS origin (or localhost for development).');
    }
    this.auth = auth; this.store = auth.store; this.now = now; this.origin = url.origin; this.rpID = url.hostname; this.verifier = verifier;
  }
  name(value) {
    if (value === undefined || value === '') return '我的通行密钥';
    if (typeof value !== 'string' || /\p{C}/u.test(value) || !value.trim() || [...value.trim()].length > 60) {
      throw fail(400, 'PASSKEY_NAME_INVALID', '通行密钥名称需要 1–60 个字符。');
    }
    return value.trim();
  }
  activeKeys(user) { return (user.passkeys || []).filter(key => key.credentialVersion === credentialVersion(user)); }
  assertReauthenticated(db, token, proof) {
    const user = this.auth.sessionUser(db, token);
    if (user.id !== proof.userId || user.passwordHash !== proof.passwordHash || this.auth.accountStamp(user) !== proof.accountStamp) {
      throw fail(401, 'PASSKEY_PASSWORD_CHANGED', '账户已变更，请重新验证密码。');
    }
    return user;
  }
  addChallenge(db, challenge) {
    db.passkeyChallenges = (db.passkeyChallenges || []).filter(item => item.expiresAt > this.now());
    if (db.passkeyChallenges.length >= 500) throw fail(429, 'PASSKEY_BUSY', '通行密钥请求繁忙，请稍后再试。');
    db.passkeyChallenges.push(challenge);
  }
  challenge(db, bindingToken, kind) {
    if (typeof bindingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bindingToken)) throw invalidChallenge();
    const record = (db.passkeyChallenges || []).find(item => item.bindingHash === tokenHash(bindingToken) && item.kind === kind);
    if (!record || record.expiresAt <= this.now() || record.createdAt > this.now()) throw invalidChallenge();
    return record;
  }
  consume(db, record) { db.passkeyChallenges = db.passkeyChallenges.filter(item => item.bindingHash !== record.bindingHash); }
  async list(token) {
    return { passkeys: this.activeKeys(this.auth.sessionUser(await this.store.read(), token)).map(summary) };
  }
  async registrationOptions(token, input, { ip = 'unknown' } = {}) {
    const name = this.name(input?.name);
    const proof = await this.auth.reauthenticate(token, input?.password, ip);
    const user = this.assertReauthenticated(await this.store.read(), token, proof);
    if (this.activeKeys(user).length >= MAX_PASSKEYS) throw fail(409, 'PASSKEY_LIMIT', '最多保存 10 个通行密钥，请先删除不再使用的密钥。');
    const options = await this.verifier.generateRegistrationOptions({
      rpName: 'mypixel club', rpID: this.rpID, userName: user.username, userDisplayName: user.username,
      userID: new Uint8Array(Buffer.from(userHandle(user), 'base64url')),
      timeout: PASSKEY_CHALLENGE_MS, attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.activeKeys(user).map(key => ({ id: key.id, transports: key.transports }))
    });
    options.hints = ['hybrid'];
    const bindingToken = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    await this.store.mutate(db => {
      const current = this.assertReauthenticated(db, token, proof);
      if (this.activeKeys(current).length >= MAX_PASSKEYS) throw fail(409, 'PASSKEY_LIMIT', '最多保存 10 个通行密钥，请先删除不再使用的密钥。');
      this.addChallenge(db, { bindingHash: tokenHash(bindingToken), kind: 'register', challenge: options.challenge,
        createdAt, expiresAt: createdAt + PASSKEY_CHALLENGE_MS, userId: current.id, sessionHash: tokenHash(token),
        passwordHash: proof.passwordHash, accountStamp: proof.accountStamp, name });
    });
    return { options, bindingToken };
  }
  async verifyRegistration(token, input, bindingToken) {
    responseShape(input?.response, 400);
    return this.store.mutate(async db => {
      const challenge = this.challenge(db, bindingToken, 'register');
      if (challenge.sessionHash !== tokenHash(token || '')) throw invalidChallenge();
      const user = this.assertReauthenticated(db, token, challenge);
      if (this.activeKeys(user).length >= MAX_PASSKEYS) throw fail(409, 'PASSKEY_LIMIT', '最多保存 10 个通行密钥，请先删除不再使用的密钥。');
      let result;
      try {
        result = await this.verifier.verifyRegistrationResponse({ response: input.response,
          expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
          requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
      } catch { throw verificationFailed(400); }
      if (challenge.expiresAt <= this.now()) throw invalidChallenge();
      this.assertReauthenticated(db, token, challenge);
      const info = result.registrationInfo;
      const key = info?.credential;
      if (!result.verified || !info?.userVerified || !key || key.id !== input.response.id ||
          !base64url(key.id) || !(key.publicKey instanceof Uint8Array) || !key.publicKey.length || key.publicKey.length > 6144 ||
          !Number.isSafeInteger(key.counter) || key.counter < 0) throw verificationFailed(400);
      if (db.users.some(other => (other.passkeys || []).some(existing => existing.id === key.id))) {
        throw fail(409, 'PASSKEY_DUPLICATE', '这个通行密钥已被绑定，请使用其他密钥。');
      }
      const transports = [...new Set((key.transports || []).filter(value => TRANSPORTS.has(value)))];
      user.passkeys = this.activeKeys(user);
      user.passkeys.push({ id: key.id, publicKey: Buffer.from(key.publicKey).toString('base64url'), counter: key.counter,
        transports, name: challenge.name, userHandle: userHandle(user), credentialVersion: credentialVersion(user),
        createdAt: this.now(), lastUsedAt: null });
      this.consume(db, challenge);
      return { passkeys: user.passkeys.map(summary) };
    });
  }
  async authenticationOptions(input, { ip = 'unknown' } = {}) {
    if (typeof input?.remember !== 'boolean') throw fail(400, 'PASSKEY_INPUT_INVALID', '请选择是否在 30 天内自动登录。');
    // Never look up the supplied username/email: discoverable credentials select
    // an account only after the authenticator proves possession of its key.
    await this.auth.limit(ip, undefined, 'passkey');
    const options = await this.verifier.generateAuthenticationOptions({ rpID: this.rpID,
      userVerification: 'required', timeout: PASSKEY_CHALLENGE_MS, allowCredentials: [] });
    options.hints = ['hybrid'];
    const bindingToken = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    await this.store.mutate(db => this.addChallenge(db, { bindingHash: tokenHash(bindingToken), kind: 'authenticate',
      challenge: options.challenge, createdAt, expiresAt: createdAt + PASSKEY_CHALLENGE_MS, remember: input.remember }));
    return { options, bindingToken };
  }
  async verifyAuthentication(input, bindingToken, context = {}) {
    responseShape(input?.response);
    const snapshot = await this.store.read();
    const started = this.challenge(snapshot, bindingToken, 'authenticate');
    const owner = snapshot.users.find(user => this.activeKeys(user).some(key => key.id === input.response.id));
    if (!owner) throw verificationFailed();
    return this.auth.finishAuthenticatedLogin(owner.id, {
      previousToken: context.previousToken, deviceToken: context.deviceToken, userAgent: context.userAgent,
      remember: started.remember, expectedPasswordHash: owner.passwordHash,
      authorize: async (db, user) => {
        const challenge = this.challenge(db, bindingToken, 'authenticate');
        if (challenge.challenge !== started.challenge || challenge.remember !== started.remember) throw invalidChallenge();
        const key = this.activeKeys(user).find(item => item.id === input.response.id);
        if (!key || input.response.response.userHandle !== key.userHandle) throw verificationFailed();
        let result;
        try {
          result = await this.verifier.verifyAuthenticationResponse({ response: input.response,
            expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
            requireUserVerification: true,
            credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')),
              counter: key.counter, transports: key.transports } });
        } catch { throw verificationFailed(); }
        if (challenge.expiresAt <= this.now()) throw invalidChallenge();
        const info = result.authenticationInfo;
        if (!result.verified || !info?.userVerified || !Number.isSafeInteger(info.newCounter) || info.newCounter < 0 ||
            ((key.counter > 0 || info.newCounter > 0) && info.newCounter <= key.counter)) throw verificationFailed();
        key.counter = info.newCounter; key.lastUsedAt = this.now(); this.consume(db, challenge);
      }
    });
  }
  async remove(token, input, { ip = 'unknown' } = {}) {
    if (!base64url(input?.id)) throw fail(400, 'PASSKEY_INPUT_INVALID', '通行密钥标识不正确。');
    const proof = await this.auth.reauthenticate(token, input?.password, ip);
    return this.store.mutate(db => {
      const user = this.assertReauthenticated(db, token, proof);
      if (!(user.passkeys || []).some(key => key.id === input.id)) throw fail(404, 'PASSKEY_NOT_FOUND', '通行密钥不存在。');
      user.passkeys = (user.passkeys || []).filter(key => key.id !== input.id);
      return { passkeys: this.activeKeys(user).map(summary) };
    });
  }
}
