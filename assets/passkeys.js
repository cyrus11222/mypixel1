(() => {
  'use strict';
  function supported() {
    return location.protocol !== 'file:' && window.isSecureContext === true && typeof window.PublicKeyCredential === 'function' && Boolean(navigator.credentials?.create && navigator.credentials?.get);
  }
  function decode(value) {
    if (typeof value !== 'string') throw new Error('通行密钥验证参数不完整，请重试。');
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(raw, character => character.charCodeAt(0)).buffer;
  }
  function encode(value) {
    if (value === null || value === undefined) return null;
    const bytes = new Uint8Array(value);
    let raw = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  async function request(action, payload) {
    const response = await fetch(`/api/auth?action=${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('通行密钥服务未正确响应，请稍后重试。'); }
    if (!response.ok) {
      const error = new Error(typeof result.error === 'string' ? result.error : '通行密钥验证失败，请重试。');
      error.retryAfterSeconds = Number(result.retryAfterSeconds || response.headers.get('Retry-After')) || 0;
      error.code = result.code;
      throw error;
    }
    return result;
  }
  function optionsFromJSON(options, registration) {
    if (!options || typeof options !== 'object') throw new Error('通行密钥服务未返回有效验证参数。');
    const publicKey = { ...options, challenge: decode(options.challenge) };
    if (registration) {
      publicKey.user = { ...options.user, id: decode(options.user?.id) };
      publicKey.excludeCredentials = (options.excludeCredentials || []).map(item => ({ ...item, id: decode(item.id) }));
    } else if (options.allowCredentials) publicKey.allowCredentials = options.allowCredentials.map(item => ({ ...item, id: decode(item.id) }));
    return publicKey;
  }
  function responseToJSON(credential, registration) {
    if (!credential) throw new Error('未获取到通行密钥验证结果，请重试。');
    const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
    if (registration) {
      response.attestationObject = encode(credential.response.attestationObject);
      response.transports = credential.response.getTransports?.() || [];
      if (credential.response.getPublicKeyAlgorithm) response.publicKeyAlgorithm = credential.response.getPublicKeyAlgorithm();
      if (credential.response.getPublicKey) response.publicKey = encode(credential.response.getPublicKey());
      if (credential.response.getAuthenticatorData) response.authenticatorData = encode(credential.response.getAuthenticatorData());
    } else {
      response.authenticatorData = encode(credential.response.authenticatorData);
      response.signature = encode(credential.response.signature);
      response.userHandle = encode(credential.response.userHandle);
    }
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined };
  }
  function friendly(error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return new Error('操作已取消或超时，未完成通行密钥验证。可以重试或使用用户名和密码。');
    if (error.name === 'InvalidStateError') return new Error('这个通行密钥可能已绑定。请检查已绑定列表，或选择另一台设备。');
    if (error.name === 'SecurityError') return new Error('当前网站域名不符合通行密钥配置，请从官网正式域名访问。');
    if (error.name === 'NotSupportedError') return new Error('此设备不支持所需的通行密钥方式。请在系统窗口选择其他设备，或使用用户名和密码。');
    if (error.name === 'TimeoutError') return new Error('通行密钥服务请求超时，请稍后重试。');
    if (error instanceof TypeError) return new Error('无法连接通行密钥服务，请检查网络或改用用户名和密码登录。');
    return error;
  }
  function ensureSupported() { if (!supported()) throw new Error('通行密钥需要安全连接与支持 WebAuthn 的浏览器。请使用 HTTPS 下的新版浏览器，或继续使用用户名和密码。'); }
  async function login(remember) {
    ensureSupported();
    try {
      const result = await request('passkey-auth-options', { remember: remember === true });
      const credential = await navigator.credentials.get({ publicKey: optionsFromJSON(result.options, false) });
      return await request('passkey-auth-verify', { response: responseToJSON(credential, false) });
    } catch (error) { throw friendly(error); }
  }
  async function register(password, name) {
    ensureSupported();
    try {
      const result = await request('passkey-register-options', { password, name });
      const credential = await navigator.credentials.create({ publicKey: optionsFromJSON(result.options, true) });
      return await request('passkey-register-verify', { response: responseToJSON(credential, true) });
    } catch (error) { throw friendly(error); }
  }
  window.mypixelPasskeys = Object.freeze({ supported, login, register });
})();
