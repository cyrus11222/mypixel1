(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const COOLDOWN_KEY = 'mypixel:auth-cooldown-until:v1';
  const COOLDOWN_MS = 60_000;
  let mode = 'login', busy = false, cooldownUntil = 0, timer = null, wasCooling = false, attempt = 0;
  const query = new URLSearchParams(location.search);
  const loginReasons = {
    kicked: '你已被退出登录，请重新登录后继续。',
    banned: '你的账户已被封禁，请联系管理员。',
    deleted: '你的账户已被管理员永久删除，原账户无法继续登录。',
    expired: '登录已失效，请重新登录后继续。'
  };
  const reason = query.get('reason');
  const initialNotice = Object.hasOwn(loginReasons, reason) ? loginReasons[reason] : '';
  const home = (location.protocol === 'file:' ? 'index.html' : '/') +
    (query.get('next') === 'developers' ? '#developers' : '');
  $('guest-link').href = home;

  async function responseData(response) {
    try { return await response.json(); }
    catch { throw new Error(`登录接口未正确响应（HTTP ${response.status}），请服主检查 Vercel 部署配置。`); }
  }
  const message = (text, success = false) => {
    $('auth-message').textContent = text;
    $('auth-message').dataset.success = String(success);
  };
  function accountErrorMessage(result, fallback) {
    if (typeof result?.error === 'string' && result.error.trim()) return result.error;
    if (result?.code === 'ACCOUNT_BANNED') return loginReasons.banned;
    if (result?.code === 'SESSION_EXPIRED') return loginReasons.expired;
    return fallback;
  }
  if (initialNotice) message(initialNotice);
  function storedDeadline() {
    try {
      const value = Number(localStorage.getItem(COOLDOWN_KEY));
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch { return 0; }
  }
  function remainingSeconds() { return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)); }
  function renderControls() {
    const remaining = remainingSeconds();
    const cooling = remaining > 0;
    $('submit').disabled = $('tab-login').disabled = $('tab-register').disabled = busy || cooling;
    $('passkey-login').disabled = busy || cooling;
    $('submit').dataset.cooldown = String(cooling);
    const normalLabel = mode === 'register' ? '注册并进入' : '登录并进入';
    $('submit-label').textContent = cooling ? `${remaining} 秒后可再次提交` : busy ? '正在验证…' : normalLabel;
    // Only the start/end are announced; the visual countdown is not a live region.
    $('submit').setAttribute('aria-label', cooling ? '暂时无法提交，请等待倒计时结束' : busy ? '正在验证账户' : normalLabel);
    if (cooling !== wasCooling) {
      $('cooldown-status').textContent = cooling ? `已提交操作，请等待 ${remaining} 秒后再次登录或注册。` : busy ? '等待时间已结束，正在验证账户。' : '现在可以再次登录或注册。';
      wasCooling = cooling;
    }
    if (cooling && timer === null) timer = window.setInterval(syncCooldown, 250);
    if (!cooling && timer !== null) { window.clearInterval(timer); timer = null; }
  }
  function syncCooldown() {
    cooldownUntil = Math.max(cooldownUntil, storedDeadline());
    renderControls();
  }
  function extendCooldown(until) {
    if (!Number.isSafeInteger(until) || until <= Date.now()) return;
    cooldownUntil = Math.max(cooldownUntil, storedDeadline(), until);
    // Only a deadline is persisted. Credentials and session tokens stay out of storage.
    try { localStorage.setItem(COOLDOWN_KEY, String(cooldownUntil)); } catch { /* A server-side limit still applies when storage is unavailable. */ }
    renderControls();
  }
  function applyServerCooldown(response, result) {
    if (response.status !== 429) return;
    const now = Date.now();
    const bodySeconds = Number(result?.retryAfterSeconds);
    const header = response.headers.get('Retry-After');
    let until = now;
    if (Number.isFinite(bodySeconds) && bodySeconds > 0) until = Math.max(until, now + Math.ceil(bodySeconds * 1000));
    if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) until = Math.max(until, now + Math.ceil(Number(header) * 1000));
    else if (header) { const date = Date.parse(header); if (Number.isFinite(date)) until = Math.max(until, date); }
    extendCooldown(until);
  }
  function setMode(next) {
    syncCooldown();
    if (busy || remainingSeconds()) return;
    mode = next;
    const register = next === 'register';
    $('tab-login').setAttribute('aria-pressed', String(!register));
    $('tab-register').setAttribute('aria-pressed', String(register));
    $('form-title').textContent = register ? '你的创造，从这里开始。' : '欢迎回来。';
    $('form-description').textContent = register ? '创建官网账户，加入 mypixel club。' : '登录你的账户，继续创造。';
    $('confirm-field').hidden = !register;
    $('confirm').disabled = !register;
    $('confirm').required = register;
    $('passkey-login').hidden = $('passkey-login-hint').hidden = register;
    $('password').autocomplete = register ? 'new-password' : 'current-password';
    $('password').value = $('confirm').value = '';
    $('confirm').setCustomValidity('');
    message('');
    document.title = (register ? '注册' : '登录') + ' · mypixel club';
    renderControls();
  }
  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-register').addEventListener('click', () => setMode('register'));
  $('show-password').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = $('confirm').type = show ? 'text' : 'password';
    $('show-password').textContent = show ? '隐藏' : '显示';
    $('show-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    $('show-password').setAttribute('aria-pressed', String(show));
  });
  for (const id of ['password', 'confirm']) $(id).addEventListener('input', () => $('confirm').setCustomValidity(''));
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    syncCooldown();
    if (busy || remainingSeconds()) return;
    if (mode === 'register' && $('confirm').value !== $('password').value) {
      $('confirm').setCustomValidity('两次输入的密码不一致。');
      $('confirm').reportValidity();
      return;
    }
    if (!$('auth-form').reportValidity()) return;
    if (location.protocol === 'file:') { message('账户功能需要通过 Vercel 网站访问，不能直接双击 HTML 使用。'); return; }

    busy = true;
    attempt++;
    $('auth-form').setAttribute('aria-busy', 'true');
    message('');
    extendCooldown(Date.now() + COOLDOWN_MS);
    try {
      const response = await fetch('/api/auth?action=' + mode, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value, remember: $('remember').checked }), signal: AbortSignal.timeout(30000)
      });
      // Respect Retry-After even if an upstream error response is not valid JSON.
      applyServerCooldown(response);
      const result = await responseData(response);
      applyServerCooldown(response, result);
      if (!response.ok) throw new Error(accountErrorMessage(result, '操作失败，请重试。'));
      $('password').value = $('confirm').value = '';
      message('验证成功，正在进入官网…', true);
      location.replace(home);
    } catch (error) {
      message(error instanceof TypeError || error instanceof SyntaxError ? '暂时无法连接账户服务，请稍后重试。' : error.message);
    } finally {
      busy = false;
      $('auth-form').removeAttribute('aria-busy');
      syncCooldown();
    }
  });
  async function restore() {
    if (location.protocol === 'file:') { message('请通过部署后的 Vercel 网站登录，或以游客身份预览。'); return; }
    const initialAttempt = attempt;
    try {
      const response = await fetch('/api/auth?action=me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) { await responseData(response); location.replace(home); }
      else {
        const result = await responseData(response);
        if (!busy && initialAttempt === attempt) {
          if (response.status !== 401) message(accountErrorMessage(result, `登录状态验证失败（HTTP ${response.status}）。`));
          else if (result?.code === 'SESSION_EXPIRED' && !initialNotice) message(accountErrorMessage(result, loginReasons.expired));
        }
      }
    } catch (error) {
      if (!busy && initialAttempt === attempt) message(error instanceof TypeError ? '暂时无法连接账户服务，请检查网络后重试。' : error.message);
    }
  }
  $('passkey-login').addEventListener('click', async () => {
    syncCooldown(); if (busy || remainingSeconds()) return;
    if (!window.mypixelPasskeys?.supported()) { message('当前浏览器或访问方式不支持通行密钥。请使用 HTTPS 下的新版浏览器，或继续使用用户名和密码登录。'); return; }
    busy = true; attempt++; extendCooldown(Date.now() + COOLDOWN_MS); message('请在浏览器弹出的安全窗口中完成验证。');
    try { await window.mypixelPasskeys.login($('remember').checked); message('验证成功，正在进入官网…', true); location.replace(home); }
    catch (error) { if (error.retryAfterSeconds > 0) extendCooldown(Date.now() + error.retryAfterSeconds * 1000); message(error.message); }
    finally { busy = false; syncCooldown(); }
  });
  window.addEventListener('storage', event => { if (event.key === COOLDOWN_KEY || event.key === null) syncCooldown(); });
  window.addEventListener('pageshow', () => { syncCooldown(); restore(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncCooldown(); });
  syncCooldown();
})();
