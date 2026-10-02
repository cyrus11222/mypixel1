(() => {
  'use strict';
  const account = window.mypixelAccount;
  if (!account) return;
  const $ = id => document.getElementById(id);
  const dialog = $('user-center');
  let user = account.getUser();
  let busy = false;
  let secret = null;
  let promptedUser = null;
  let renderedPhone;
  const required = () => user?.recovery?.required === true;
  const admin = () => user?.recovery?.adminManaged === true || user?.role === 'admin';
  const scrollBehavior = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  const message = (id, text = '', success = false) => { $(id).textContent = text; $(id).dataset.success = String(success); };
  function forgetSecret() { secret = null; $('generated-recovery-code').value = ''; $('recovery-secret-panel').hidden = true; $('recovery-code-saved').checked = false; controls(); }
  function controls() {
    for (const id of ['recovery-generate-submit', 'password-change-submit', 'profile-phone-submit']) $(id).disabled = busy || !user;
    $('recovery-code-confirm').disabled = busy || !secret || Date.now() >= secret.expiresAt || !$('recovery-code-saved').checked;
    $('recovery-code-discard').disabled = busy;
    $('copy-recovery-code').disabled = $('download-recovery-code').disabled = !secret;
  }
  function clearPasswords() {
    for (const id of ['recovery-current-password', 'password-change-old', 'password-change-new', 'password-change-confirm', 'profile-phone-password']) $(id).value = '';
  }
  function render() {
    $('recovery-setup-notice').hidden = !required();
    $('binding-title').closest('.uc-section').hidden = required();
    $('membership-title').closest('.uc-section').hidden = required();
    $('password-settings').hidden = required();
    $('phone-settings').hidden = required();
    $('recovery-settings').hidden = admin();
    $('password-admin-note').hidden = !admin();
    $('password-change-details').hidden = admin();
    $('recovery-setting-status').textContent = user?.recovery?.hasRecoveryCode ? '已设置一次性恢复码。使用后会失效，请保持安全保存。' : user?.recovery?.codePending ? '有尚未确认保存的恢复码。若已关闭显示页面，请重新生成。' : '尚未设置恢复码。你可以选择恢复码或通行密钥作为账户恢复方式。';
    const phone = user?.phone || '';
    if (phone !== renderedPhone) { $('profile-phone').value = phone; renderedPhone = phone; }
    for (const close of dialog.querySelectorAll('[data-dialog-close]')) { close.disabled = required(); close.title = required() ? '请先设置恢复方式，或使用底部退出登录按钮' : ''; }
    if (required() && promptedUser !== user.username) {
      promptedUser = user.username;
      if (!dialog.open) account.openDialog(dialog);
      $('recovery-setup-notice').scrollIntoView({ behavior: 'instant', block: 'start' });
    }
    controls();
  }
  dialog.addEventListener('cancel', event => { if (required()) event.preventDefault(); });
  dialog.addEventListener('click', event => {
    if (!required() || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  $('setup-choose-passkey').addEventListener('click', () => { $('passkey-add-details').open = true; $('passkey-add-details').scrollIntoView({ behavior: scrollBehavior(), block: 'center' }); $('passkey-password').focus({ preventScroll: true }); });
  $('setup-choose-code').addEventListener('click', () => { $('recovery-generate-details').open = true; $('recovery-generate-details').scrollIntoView({ behavior: scrollBehavior(), block: 'center' }); $('recovery-current-password').focus({ preventScroll: true }); });
  $('recovery-generate-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !user || admin() || !$('recovery-generate-form').reportValidity()) return;
    const currentPassword = $('recovery-current-password').value;
    $('recovery-current-password').value = ''; busy = true; controls(); forgetSecret(); message('recovery-settings-message', '正在验证密码并生成一次性恢复码…');
    try {
      const result = await account.request('recovery-code-generate', { currentPassword });
      if (typeof result.recoveryCode !== 'string' || typeof result.confirmationId !== 'string') throw new Error('没有获得有效恢复码，请重试。');
      secret = { code: result.recoveryCode, confirmationId: result.confirmationId, expiresAt: Date.now() + Math.min(600, Number(result.expiresInSeconds) || 600) * 1000 };
      $('generated-recovery-code').value = secret.code; $('recovery-secret-panel').hidden = false; $('recovery-code-saved').checked = false;
      message('recovery-settings-message', '请现在保存恢复码，随后勾选确认。关闭或刷新后无法再次查看。', true);
      $('recovery-secret-panel').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    } catch (error) { message('recovery-settings-message', error.message); }
    finally { busy = false; controls(); }
  });
  $('copy-recovery-code').addEventListener('click', async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.code); message('recovery-settings-message', '恢复码已复制，请保存到安全位置。', true); }
    catch { $('generated-recovery-code').focus(); $('generated-recovery-code').select(); message('recovery-settings-message', '请复制已选中的恢复码，并保存到安全位置。'); }
  });
  $('download-recovery-code').addEventListener('click', () => {
    if (!secret || !user) return;
    const contents = `mypixel club 一次性账户恢复码\n账户：${user.username}\n官网：https://www.mypixel.com.cn\n\n${secret.code}\n\n此码可用于找回用户名和重置密码。请勿分享，使用后失效。\n下载后仍需回到页面勾选“已安全保存”并确认启用。\n`;
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `mypixel-recovery-${user.username}.txt`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('recovery-settings-message', '已请求浏览器下载恢复码文件。请确认文件已保存，再勾选启用。', true);
  });
  $('recovery-code-saved').addEventListener('change', controls);
  $('recovery-code-discard').addEventListener('click', () => { forgetSecret(); message('recovery-settings-message', '已关闭此次恢复码显示；如需继续，请重新生成。'); });
  $('recovery-code-confirm').addEventListener('click', async () => {
    if (busy || !secret || !$('recovery-code-saved').checked || Date.now() >= secret.expiresAt) return;
    busy = true; controls();
    try {
      await account.request('recovery-code-confirm', { confirmationId: secret.confirmationId });
      forgetSecret(); $('recovery-generate-details').open = false; message('recovery-settings-message', '恢复码已启用，恢复方式设置完成。', true);
    } catch (error) { message('recovery-settings-message', error.message); }
    finally { busy = false; controls(); }
  });
  for (const id of ['password-change-new', 'password-change-confirm']) $(id).addEventListener('input', () => $('password-change-confirm').setCustomValidity(''));
  $('password-change-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !user || admin()) return;
    if ($('password-change-new').value !== $('password-change-confirm').value) { $('password-change-confirm').setCustomValidity('两次输入的密码不一致。'); $('password-change-confirm').reportValidity(); return; }
    if (!$('password-change-form').reportValidity()) return;
    busy = true; controls(); message('password-change-message', '正在更新密码…');
    const payload = { oldPassword: $('password-change-old').value, newPassword: $('password-change-new').value }; clearPasswords();
    try { await account.request('change-password', payload); $('password-change-details').open = false; message('password-change-message', '密码已更新，其他设备已退出，本机保持登录。', true); }
    catch (error) { message('password-change-message', error.message); }
    finally { busy = false; controls(); }
  });
  $('phone-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !user || !$('phone-settings-form').reportValidity()) return;
    busy = true; controls(); const payload = { currentPassword: $('profile-phone-password').value, phone: $('profile-phone').value.trim() }; $('profile-phone-password').value = '';
    try { await account.request('phone-set', payload); message('phone-settings-message', payload.phone ? '联系资料已保存。手机号不用于身份认证或账户找回。' : '手机号已移除。', true); }
    catch (error) { message('phone-settings-message', error.message); }
    finally { busy = false; controls(); }
  });
  new MutationObserver(() => { if (!dialog.open) { clearPasswords(); forgetSecret(); } }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  window.addEventListener('mypixel:account', event => {
    const previous = user?.username; user = event.detail;
    if (previous !== user?.username) { clearPasswords(); forgetSecret(); promptedUser = null; }
    render();
  });
  setInterval(() => {
    if (!secret) return;
    const seconds = Math.max(0, Math.ceil((secret.expiresAt - Date.now()) / 1000));
    if (!seconds) { forgetSecret(); message('recovery-settings-message', '保存确认时间已到期，请重新生成恢复码。'); return; }
    $('recovery-secret-expiry').textContent = `请在 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒内确认保存。未确认前不可用于找回。`; controls();
  }, 1000);
  render();
})();
