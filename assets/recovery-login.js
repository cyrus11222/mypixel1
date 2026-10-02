(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let busy = false;
  let granted = false;
  let deadline = 0;
  let resetComplete = false;
  let savedHeading;
  function message(text = '', success = false) { $('recovery-message').textContent = text; $('recovery-message').dataset.success = String(success); }
  function controls() {
    for (const id of ['recovery-code-submit', 'recovery-passkey-submit', 'recover-method-passkey', 'recover-method-code']) $(id).disabled = busy;
    $('recovery-reset-submit').disabled = busy || !granted || Date.now() >= deadline;
  }
  async function request(action, payload) {
    if (location.protocol === 'file:') throw new Error('请通过官网安全连接进行账户找回。');
    const response = await fetch(`/api/auth?action=${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    let result; try { result = await response.json(); } catch { throw new Error('账户找回服务暂未正确响应，请稍后重试。'); }
    if (!response.ok) throw new Error(result.error || '账户恢复验证失败，请重试。');
    return result;
  }
  function showGrant(result) {
    if (result.recoveryGranted !== true || typeof result.username !== 'string') throw new Error('没有取得有效的账户恢复授权，请重新验证。');
    granted = true; resetComplete = false; deadline = Date.now() + Math.min(300, Number(result.expiresInSeconds) || 300) * 1000;
    $('recovery-verify-panel').hidden = true; $('recovery-reset-panel').hidden = false;
    $('recovered-username').textContent = result.username; $('recovery-code').value = '';
    message('身份已确认。请保存好找回的用户名，并设置新密码。', true); controls(); $('recovery-new-password').focus();
  }
  function method(code) {
    $('recover-method-passkey').setAttribute('aria-pressed', String(!code)); $('recover-method-code').setAttribute('aria-pressed', String(code));
    $('recovery-passkey-fields').hidden = code; $('recovery-code-form').hidden = !code; message();
  }
  $('recover-method-passkey').addEventListener('click', () => method(false));
  $('recover-method-code').addEventListener('click', () => method(true));
  $('recovery-passkey-submit').addEventListener('click', async () => {
    if (busy || !$('recovery-username').reportValidity()) return;
    if (!window.mypixelPasskeys?.supported()) { message('此设备暂不支持通行密钥，请使用安全连接与新版浏览器，或选择一次性恢复码。'); return; }
    busy = true; controls(); message('请在系统安全窗口验证已绑定的通行密钥。');
    try { showGrant(await window.mypixelPasskeys.recover($('recovery-username').value.trim())); }
    catch (error) { message(error.message); }
    finally { busy = false; controls(); }
  });
  $('recovery-code-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !$('recovery-username').reportValidity() || !$('recovery-code-form').reportValidity()) return;
    busy = true; controls(); message('正在验证恢复码…');
    const payload = { code: $('recovery-code').value.trim() }; const username = $('recovery-username').value.trim(); if (username) payload.username = username;
    $('recovery-code').value = '';
    try { showGrant(await request('recovery-code-verify', payload)); }
    catch (error) { message(error.name === 'TimeoutError' ? '请求超时，请重新验证恢复码后继续。最终重置成功前不会消耗恢复码。' : error.message); }
    finally { busy = false; controls(); }
  });
  for (const id of ['recovery-new-password', 'recovery-confirm-password']) $(id).addEventListener('input', () => $('recovery-confirm-password').setCustomValidity(''));
  $('recovery-reset-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !granted || Date.now() >= deadline) { if (!busy) message('本次恢复授权已到期，请返回重新验证。'); return; }
    if ($('recovery-new-password').value !== $('recovery-confirm-password').value) { $('recovery-confirm-password').setCustomValidity('两次输入的密码不一致。'); $('recovery-confirm-password').reportValidity(); return; }
    if (!$('recovery-reset-form').reportValidity()) return;
    busy = true; controls(); message('正在重置密码…');
    try {
      const result = await request('reset-password', { newPassword: $('recovery-new-password').value });
      granted = false; resetComplete = true; $('recovery-new-password').value = $('recovery-confirm-password').value = '';
      $('recovery-reset-form').hidden = true; $('recovery-expiry').textContent = '请点击“返回登录”，使用找回的用户名和新密码登录。';
      message(result.message || '密码已重置。请重新登录，并设置新的恢复方式。', true);
    } catch (error) { message(error.message); }
    finally { busy = false; controls(); }
  });
  function route() {
    const active = location.hash === '#recover';
    if (active && !savedHeading) savedHeading = { title: $('form-title').textContent, description: $('form-description').textContent, pageTitle: document.title };
    $('recovery-panel').hidden = !active; $('auth-form').hidden = active; document.querySelector('.auth-switch').hidden = active;
    const register = $('tab-register').getAttribute('aria-pressed') === 'true';
    $('passkey-login').hidden = $('passkey-login-hint').hidden = active || register; $('forgot-account-link').hidden = active;
    if (active) { $('form-title').textContent = '找回你的创造。'; $('form-description').textContent = '恢复用户名与密码。'; document.title = '账户找回 · mypixel club'; $('password').value = $('confirm').value = ''; }
    else if (savedHeading) {
      $('form-title').textContent = savedHeading.title; $('form-description').textContent = savedHeading.description; document.title = savedHeading.pageTitle; savedHeading = null;
      granted = false; deadline = 0; resetComplete = false;
      $('recovery-code').value = $('recovery-new-password').value = $('recovery-confirm-password').value = '';
      $('recovery-verify-panel').hidden = false; $('recovery-reset-panel').hidden = true; $('recovery-reset-form').hidden = false; message();
    }
    controls();
  }
  setInterval(() => {
    if (!granted || resetComplete) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $('recovery-expiry').textContent = seconds ? `本次恢复授权剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒。请勿刷新此页面。` : '恢复授权已过期，请返回登录，再次验证恢复方式。'; controls();
  }, 1000);
  window.addEventListener('hashchange', route); route();
})();
