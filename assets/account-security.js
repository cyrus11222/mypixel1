(() => {
  'use strict';
  const account = window.mypixelAccount;
  const passkeys = window.mypixelPasskeys;
  if (!account || !passkeys) return;
  const $ = id => document.getElementById(id);
  let user = account.getUser();
  let list = [];
  let loading = false;
  let busy = false;
  let removeId = null;
  let revision = 0;
  const element = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  };
  const date = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  function message(text = '', success = false) { $('passkeys-message').textContent = text; $('passkeys-message').dataset.success = String(success); }
  function resetRemove() { removeId = null; $('passkey-remove-password').value = ''; $('passkey-remove-confirm').hidden = true; }
  function controls() {
    $('passkeys-refresh').disabled = loading || busy || !user;
    $('passkey-add').disabled = busy || !user || !passkeys.supported();
    for (const id of ['passkey-name', 'passkey-password']) $(id).disabled = busy || !user || !passkeys.supported();
    for (const button of $('passkeys-list').querySelectorAll('button')) button.disabled = busy || !user;
    $('passkey-remove-submit').disabled = busy || !user;
    $('passkey-remove-cancel').disabled = busy;
    $('passkey-remove-password').disabled = busy;
    $('passkey-add').textContent = busy ? '请完成系统安全验证…' : '验证并绑定通行密钥';
  }
  function renderList() {
    const container = $('passkeys-list'); container.replaceChildren();
    if (!list.length) container.append(element('p', 'uc-hint', '还没有绑定通行密钥。你仍可以使用用户名和密码登录。'));
    for (const entry of list) {
      const item = element('article', 'passkey-item');
      const copy = element('div', 'passkey-item-copy');
      copy.append(element('strong', '', entry.name || '通行密钥'));
      copy.append(element('p', '', `创建于 ${date(entry.createdAt)}${entry.lastUsedAt ? ` · 最近使用 ${date(entry.lastUsedAt)}` : ' · 尚未用于登录'}`));
      const remove = element('button', 'uc-text-button', '移除'); remove.type = 'button';
      remove.setAttribute('aria-label', `移除通行密钥 ${entry.name || ''}`);
      remove.addEventListener('click', () => {
        if (busy) return;
        removeId = entry.id; $('passkey-remove-name').textContent = entry.name || '此通行密钥';
        $('passkey-remove-password').value = ''; $('passkey-remove-confirm').hidden = false;
        $('passkey-remove-password').focus(); message();
      });
      item.append(copy, remove); container.append(item);
    }
    controls();
  }
  async function load() {
    if (!user || loading || busy) return;
    loading = true; controls();
    const currentRevision = revision;
    try {
      const result = await account.request('passkeys');
      if (currentRevision !== revision || !user) return;
      if (!Array.isArray(result.passkeys)) throw new Error('通行密钥列表暂不可用，请刷新重试。');
      list = result.passkeys; renderList();
    } catch (error) { if (currentRevision === revision) message(error.message); }
    finally { loading = false; controls(); }
  }
  $('passkeys-refresh').addEventListener('click', () => { message(); load(); });
  $('passkey-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !user || !$('passkey-add-form').reportValidity()) return;
    if (!passkeys.supported()) { message('此设备暂不支持创建通行密钥，请使用 HTTPS 下的新版浏览器。'); return; }
    const password = $('passkey-password').value;
    const name = $('passkey-name').value.trim();
    if (!name) { message('请为这个通行密钥填写一个名称。'); return; }
    busy = true; revision += 1; controls(); $('passkey-password').value = ''; resetRemove();
    message('正在确认密码。随后请按浏览器的系统安全提示，选择本机或其他设备保存通行密钥。');
    try {
      const result = await passkeys.register(password, name);
      if (Array.isArray(result.passkeys)) { list = result.passkeys; renderList(); }
      $('passkey-add-details').open = false;
      message('通行密钥已绑定。下次可直接使用通行密钥登录。', true);
      await account.refresh();
    } catch (error) { message(error.message); }
    finally { busy = false; controls(); }
  });
  $('passkey-remove-cancel').addEventListener('click', resetRemove);
  $('passkey-remove-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !user || !removeId || !$('passkey-remove-form').reportValidity()) return;
    const payload = { id: removeId, password: $('passkey-remove-password').value };
    busy = true; revision += 1; controls(); $('passkey-remove-password').value = ''; message('正在验证密码并移除通行密钥…');
    try {
      const result = await account.request('passkey-remove', payload);
      if (!Array.isArray(result.passkeys)) throw new Error('操作已返回，请刷新列表确认通行密钥状态。');
      list = result.passkeys; resetRemove(); renderList(); message('通行密钥已移除。', true);
    } catch (error) { message(error.message); }
    finally { busy = false; controls(); }
  });
  const dialog = $('user-center');
  new MutationObserver(() => { if (dialog.open) load(); else { $('passkey-password').value = ''; resetRemove(); } }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  window.addEventListener('mypixel:account', event => {
    const oldName = user?.username;
    user = event.detail;
    if (oldName !== user?.username) {
      revision += 1; list = []; resetRemove(); $('passkey-password').value = ''; message(); renderList();
      if (user && dialog.open) load();
    }
    controls();
  });
  if (!passkeys.supported()) $('passkeys-support-message').textContent = '当前环境不支持创建通行密钥。可继续查看和移除已绑定项，或换用 HTTPS 下的新版浏览器。';
  controls();
})();
