(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let mode = 'login', busy = false;
  const message = (text, success = false) => { $('auth-message').textContent = text; $('auth-message').dataset.success = String(success); };
  function setMode(next) {
    if (busy) return;
    mode = next; const register = next === 'register';
    $('tab-login').setAttribute('aria-pressed', String(!register)); $('tab-register').setAttribute('aria-pressed', String(register));
    $('form-title').textContent = register ? '你的创造，从这里开始。' : '欢迎回来。';
    $('form-description').textContent = register ? '创建官网账户，加入 mypixel club。' : '登录你的账户，继续创造。';
    $('submit-label').textContent = register ? '注册并进入' : '登录并进入';
    $('confirm-field').hidden = !register; $('confirm').disabled = !register; $('confirm').required = register;
    $('password').autocomplete = register ? 'new-password' : 'current-password';
    $('password').value = ''; $('confirm').value = ''; $('confirm').setCustomValidity(''); message('');
    document.title = (register ? '注册' : '登录') + ' · mypixel club';
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
  for (const id of ['password','confirm']) $(id).addEventListener('input', () => $('confirm').setCustomValidity(''));
  $('auth-form').addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return;
    if (mode === 'register' && $('confirm').value !== $('password').value) { $('confirm').setCustomValidity('两次输入的密码不一致。'); $('confirm').reportValidity(); return; }
    if (location.protocol === 'file:') { message('账户功能需要通过 Vercel 网站访问，不能直接双击 HTML 使用。'); return; }
    busy = true; $('submit').disabled = true; $('tab-login').disabled = $('tab-register').disabled = true;
    $('auth-form').setAttribute('aria-busy','true'); $('submit-label').textContent = mode === 'register' ? '正在创建账户…' : '正在登录…'; message('');
    try {
      const response = await fetch('/api/auth?action=' + mode, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        username: $('username').value.trim(), password: $('password').value, remember: $('remember').checked
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
      $('password').value = $('confirm').value = ''; message('验证成功，正在进入官网…', true); location.replace('/');
    } catch (e) { message(e instanceof TypeError || e instanceof SyntaxError ? '暂时无法连接账户服务，请稍后重试。' : e.message); }
    finally { busy = false; $('submit').disabled = false; $('tab-login').disabled = $('tab-register').disabled = false; $('auth-form').removeAttribute('aria-busy'); $('submit-label').textContent = mode === 'register' ? '注册并进入' : '登录并进入'; }
  });
  async function restore() {
    if (location.protocol === 'file:') { message('请通过部署后的 Vercel 网站登录。'); return; }
    try { const response = await fetch('/api/auth?action=me', { credentials:'same-origin',cache:'no-store' }); if (response.ok) location.replace('/'); else if(response.status !== 401) message('账户服务暂不可用，请稍后重试或联系服主。'); }
    catch { message('暂时无法连接账户服务，请检查网络后重试。'); }
  }
  window.addEventListener('pageshow', restore);
})();
