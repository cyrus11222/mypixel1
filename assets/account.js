(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const isFile = location.protocol === 'file:';
  const loginUrl = isFile ? 'login.html' : '/login';
  let publicConfig = null;
  let agreementLoading = false;
  let wasAuthenticated = false;
  const ui = {
    name: $('account-name'), login: $('account-login'), status: $('account-status'),
    home: $('home-view'), community: $('community-view'),
    userDialog: $('user-center'), agreementDialog: $('community-agreement'),
    profileName: $('profile-username'), profileInitial: $('profile-initial'),
    game: $('game-id'), binding: $('game-binding-status'), lock: $('game-lock-status'),
    bindForm: $('game-binding-form'), bindButton: $('game-bind'), unbind: $('game-unbind'),
    unbindConfirm: $('game-unbind-confirm'), unbindYes: $('game-unbind-yes'), unbindNo: $('game-unbind-no'),
    profileMessage: $('profile-message'), logout: $('account-logout'),
    membership: $('profile-membership'), membershipDetail: $('profile-membership-detail'),
    join: $('community-join'), communityMessage: $('community-message'),
    requirementAccount: $('requirement-account'), requirementGame: $('requirement-game'),
    requirementAccountText: $('requirement-account-text'), requirementGameText: $('requirement-game-text'),
    badge: $('community-member-badge'), memberSince: $('community-member-since'),
    agreementCheck: $('agreement-accept'), agreementSubmit: $('agreement-submit'),
    agreementForm: $('agreement-form'), agreementMessage: $('agreement-message'),
  };
  if (!ui.name || !ui.userDialog || !ui.agreementDialog) return;
  let user = null;
  let busy = false;
  let checking = false;
  let revision = 0;
  let pendingAccountMutations = 0;
  let sessionUnknown = false;
  let renderedGameId;
  const invokers = new WeakMap();

  function date(value) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  }
  function message(target, text = '', success = false) {
    target.textContent = text;
    target.dataset.success = String(success);
  }
  function openDialog(dialog) {
    if (dialog.open) return;
    invokers.set(dialog, document.activeElement);
    dialog.showModal();
    document.documentElement.classList.add('account-modal-open');
  }
  function closeDialog(dialog) { dialog.close(); }
  for (const dialog of document.querySelectorAll('.account-dialog')) {
    dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(dialog));
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      if (!document.querySelector('.account-dialog[open]')) document.documentElement.classList.remove('account-modal-open');
      const invoker = invokers.get(dialog);
      if (invoker instanceof HTMLElement && invoker.isConnected && !invoker.hidden && !invoker.disabled) invoker.focus();
      else (user ? ui.name : ui.login).focus();
    });
  }
  ui.login.href = loginUrl;

  function render() {
    const admin = user?.role === 'admin';
    const binding = user?.gameBinding;
    const member = user?.developerCommunity;
    const currentAgreement = Boolean(member && publicConfig?.agreement?.version === member.agreementVersion);
    const locked = Boolean(binding && binding.lockedUntil > Date.now());
    ui.name.hidden = !user;
    ui.login.hidden = Boolean(user);
    ui.status.hidden = Boolean(user);
    ui.status.textContent = sessionUnknown ? '账户暂不可用 · 可继续浏览' : '游客浏览';
    ui.name.textContent = user?.username || '用户中心';
    ui.name.title = user ? `${user.username} · 打开用户中心` : '';
    ui.profileName.textContent = user?.username || '游客';
    ui.profileInitial.textContent = (user?.username || 'M').slice(0, 1).toUpperCase();
    ui.binding.textContent = admin ? '管理员账户无需绑定游戏账号' : binding ? `已绑定 · ${binding.gameId}` : '尚未绑定游戏账号';
    ui.lock.textContent = binding
      ? locked
        ? `保护期至 ${date(binding.lockedUntil)}（北京时间），期间不可修改或删除。`
        : '30 天保护期已结束，可以改绑或解除绑定。改绑或解绑后需重新加入社区。'
      : '绑定成功后，30 天内不可修改或删除。请核对完整游戏 ID 后提交。';
    const currentGameId = binding?.gameId || '';
    if (renderedGameId !== currentGameId) { ui.game.value = currentGameId; renderedGameId = currentGameId; }
    ui.bindForm.hidden = admin;
    ui.game.disabled = busy || locked || !user || admin;
    ui.bindButton.disabled = busy || locked || !user || admin;
    ui.bindButton.textContent = locked ? '30 天绑定保护中' : binding ? '保存新的游戏 ID' : '绑定游戏账号';
    ui.unbind.hidden = !binding;
    ui.unbind.disabled = busy || locked || !user;
    ui.unbindYes.disabled = busy;
    ui.unbindNo.disabled = busy;
    ui.logout.disabled = busy;
    ui.membership.textContent = admin ? '社区管理员' : member ? '玩家开发者社区成员' : '尚未加入玩家开发者社区';
    ui.membershipDetail.textContent = admin ? '管理员通过顶部 Admin 命令台管理社区，不参与游戏账号绑定与玩家社区入会。' : member ? `加入时间：${date(member.joinedAt)} · 加入不直接授予 OP 或创造权限。` : '登录并绑定游戏 ID 后，即可阅读协议并申请加入。';
    ui.requirementAccount.dataset.complete = String(Boolean(user));
    ui.requirementGame.dataset.complete = String(Boolean(binding));
    ui.requirementAccountText.textContent = user ? `已完成 · ${user.username}` : '使用 mypixel club 账户登录';
    ui.requirementGameText.textContent = binding ? `已完成 · ${binding.gameId}` : '在用户中心填写完整游戏 ID';
    ui.badge.hidden = !member;
    ui.memberSince.hidden = !member;
    ui.memberSince.textContent = member ? `${date(member.joinedAt)} 加入 · 协议版本 ${member.agreementVersion}` : '';
    ui.join.disabled = busy || currentAgreement || admin;
    ui.join.textContent = admin ? '管理员不参与玩家社区入会' : currentAgreement ? '已加入玩家开发者社区 ✓' : member ? '阅读并同意最新社区协议 →' : !user ? '登录后加入社区 ↗' : !binding ? '先绑定游戏账号 →' : '加入玩家开发者社区 ↗';
    ui.agreementSubmit.disabled = busy || agreementLoading || !publicConfig?.agreement?.version || !ui.agreementCheck.checked || !binding || currentAgreement || admin;
    ui.agreementSubmit.textContent = busy ? '正在提交…' : '同意协议并加入';
  }

  function syncView() {
    const isCommunity = location.hash === '#developers';
    const isReview = location.hash === '#tickets';
    const isDownloads = location.hash === '#downloads';
    ui.home.hidden = isCommunity || isReview || isDownloads;
    ui.community.hidden = !isCommunity;
    $('review-view').hidden = !isReview;
    $('downloads-view').hidden = !isDownloads;
    document.body.classList.toggle('community-active', isCommunity);
    for (const link of document.querySelectorAll('.nav-links a')) {
      const active = link.hash === '#developers' ? isCommunity : link.hash === '#downloads' ? isDownloads : !isCommunity && !isReview && !isDownloads && link.hash === (location.hash || '#home');
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = isDownloads ? '下载中心 · mypixel club' : isReview ? '工单审批 · mypixel club' : isCommunity ? '玩家开发者社区 · mypixel club' : 'mypixel club · 纯创造机械动力服务器';
    requestAnimationFrame(() => {
      if (isCommunity || isReview || isDownloads) window.scrollTo({ top: 0, behavior: 'instant' });
      else {
        window.dispatchEvent(new Event('resize'));
        const target = document.getElementById(location.hash.slice(1) || 'home');
        if (target && ui.home.contains(target)) target.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    });
  }

  async function readResponse(response) {
    let result;
    try { result = await response.json(); }
    catch { throw new Error('账户接口暂未返回有效结果，请稍后重试。'); }
    if (!response.ok) {
      if (response.status === 401 || result.code === 'ACCOUNT_BANNED') {
        if (wasAuthenticated) location.replace(`${loginUrl}?reason=${result.code === 'ACCOUNT_BANNED' ? 'banned' : 'expired'}`);
        user = null; sessionUnknown = false; render(); publishUser();
      }
      const error = new Error(typeof result.error === 'string' ? result.error : '操作失败，请稍后重试。');
      error.code = result.code;
      throw error;
    }
    return result;
  }

  async function check() {
    if (isFile || checking || busy || pendingAccountMutations) return;
    checking = true;
    const currentRevision = revision;
    try {
      const response = await fetch('/api/auth?action=me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (revision !== currentRevision) return;
      if (response.status === 401) {
        if (wasAuthenticated) { location.replace(`${loginUrl}?reason=expired`); return; }
        user = null; sessionUnknown = false;
      }
      else {
        const result = await readResponse(response);
        if (revision !== currentRevision) return;
        if (!result.user || typeof result.user.username !== 'string') throw new Error('账户数据暂不可用。');
        user = result.user;
        wasAuthenticated = true;
        sessionUnknown = false;
      }
      render();
      publishUser();
    } catch {
      if (revision === currentRevision) { sessionUnknown = !user; render(); }
    } finally { checking = false; }
  }

  async function mutate(action, payload, target, onSuccess) {
    if (busy) return;
    if (isFile) { message(target, '本地文件仅预览界面。绑定和加入社区需在已部署的网站完成。'); return; }
    busy = true;
    revision += 1;
    message(target);
    render();
    try {
      const response = await fetch(`/api/auth?action=${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
      });
      const result = await readResponse(response);
      if (action === 'logout') { user = null; wasAuthenticated = false; }
      else {
        if (!result.user || typeof result.user.username !== 'string') throw new Error('操作已返回，但账户状态不完整。请刷新后检查。');
        user = result.user;
      }
      sessionUnknown = false;
      publishUser();
      onSuccess?.();
    } catch (error) {
      message(target, error.name === 'TimeoutError' ? '请求等待超时，请刷新查看状态后再重试。' : error.message === 'Failed to fetch' ? '暂时无法连接，请检查网络后重试。' : error.message);
    } finally { busy = false; render(); }
  }

  ui.name.addEventListener('click', () => {
    message(ui.profileMessage);
    ui.unbindConfirm.hidden = true;
    render();
    openDialog(ui.userDialog);
  });
  ui.bindForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ui.bindForm.reportValidity() || ui.bindButton.disabled) return;
    const gameId = ui.game.value.trim();
    if (!gameId) { message(ui.profileMessage, '请输入完整游戏 ID。'); return; }
    mutate('bind-game', { gameId }, ui.profileMessage, () => {
      ui.unbindConfirm.hidden = true;
      ui.game.value = user.gameBinding.gameId;
      message(ui.profileMessage, '游戏 ID 已绑定成功，30 天保护期已生效。', true);
    });
  });
  ui.unbind.addEventListener('click', () => { ui.unbindConfirm.hidden = false; ui.unbindNo.focus(); });
  ui.unbindNo.addEventListener('click', () => { ui.unbindConfirm.hidden = true; ui.unbind.focus(); });
  ui.unbindYes.addEventListener('click', () => {
    mutate('unbind-game', {}, ui.profileMessage, () => {
      ui.unbindConfirm.hidden = true;
      message(ui.profileMessage, '已解除绑定。重新绑定游戏 ID 后可再次申请加入社区。', true);
    });
  });
  ui.logout.addEventListener('click', () => {
    mutate('logout', {}, ui.profileMessage, () => {
      closeDialog(ui.userDialog);
      message(ui.communityMessage, '已退出账户，你仍可作为游客浏览网站。', true);
    });
  });
  ui.join.addEventListener('click', async () => {
    if (!user) { location.href = `${loginUrl}?next=developers`; return; }
    if (!user.gameBinding) {
      message(ui.profileMessage, '先完成游戏 ID 绑定，再来加入玩家开发者社区。');
      openDialog(ui.userDialog);
      ui.game.focus();
      return;
    }
    if (user.role === 'admin' || (user.developerCommunity && user.developerCommunity.agreementVersion === publicConfig?.agreement?.version)) return;
    ui.agreementCheck.checked = false;
    message(ui.agreementMessage);
    render();
    openDialog(ui.agreementDialog);
    await loadConfig();
  });
  ui.agreementCheck.addEventListener('change', render);
  ui.agreementForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ui.agreementCheck.checked || ui.agreementSubmit.disabled) return;
    mutate('join-community', { accepted: true, agreementVersion: publicConfig.agreement.version }, ui.agreementMessage, () => {
      closeDialog(ui.agreementDialog);
      message(ui.communityMessage, '欢迎加入玩家开发者社区！你的成员身份已保存。', true);
    });
  });
  $('profile-community-link').addEventListener('click', () => closeDialog(ui.userDialog));
  window.addEventListener('hashchange', syncView);
  window.addEventListener('pageshow', check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(() => { if (!document.hidden && wasAuthenticated) check(); }, 30000);
  function publishUser() { window.dispatchEvent(new CustomEvent('mypixel:account', { detail: user })); }
  async function request(action, payload) {
    if (isFile) throw new Error('请在已部署的网站或本地开发服务器使用此功能。');
    const options = { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) };
    const mutation = payload !== undefined;
    if (mutation) { Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); pendingAccountMutations += 1; revision += 1; }
    try {
      const result = await readResponse(await fetch(`/api/auth?action=${action}`, options));
      if (result.user) { user = result.user; wasAuthenticated = true; render(); publishUser(); }
      return result;
    } finally { if (mutation) pendingAccountMutations -= 1; }
  }
  async function loadConfig() {
    if (isFile || agreementLoading) return publicConfig;
    agreementLoading = true;
    render();
    try {
      const result = await request('public-config');
      if (typeof result.agreement?.content !== 'string' || typeof result.agreement?.version !== 'string') throw new Error('最新社区协议暂不可用，请稍后重试。');
      publicConfig = result;
      $('agreement-default-terms').hidden = true;
      $('agreement-dynamic').hidden = false;
      $('agreement-dynamic').textContent = result.agreement.content;
      $('agreement-version').textContent = `协议版本 ${result.agreement.version} · 更新时间 ${date(result.agreement.updatedAt)}`;
      window.dispatchEvent(new CustomEvent('mypixel:config', { detail: publicConfig }));
    } catch (error) {
      publicConfig = null;
      window.dispatchEvent(new CustomEvent('mypixel:config', { detail: null }));
      $('agreement-version').textContent = '未能读取最新社区协议';
      message(ui.agreementMessage, error.message);
    } finally { agreementLoading = false; render(); }
    return publicConfig;
  }
  window.mypixelAccount = Object.freeze({ getUser: () => user, getConfig: () => publicConfig, refresh: check, request, loadConfig, openDialog, closeDialog });
  syncView();
  render();
  check();
  loadConfig();
})();
