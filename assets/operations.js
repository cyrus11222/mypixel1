(() => {
  'use strict';
  const account = window.mypixelAccount;
  if (!account) return;
  const $ = id => document.getElementById(id);
  const typeNames = { op: 'OP 权限', creative: '创造模式', materials: '物资申请' };
  const statusNames = { pending: '待审核', approved: '审核通过', rejected: '已拒绝' };
  let user = account.getUser();
  let config = account.getConfig();
  let ownTickets = [];
  let reviewTickets = [];
  let ownLoading = false;
  let reviewLoading = false;
  let ticketBusy = false;
  let adminBusy = false;
  let queuedDeletion = null;
  let shownNotificationIds = [];
  let notificationBusy = false;
  let lastUserKey = '';
  let dismissedNotifications = '';
  const node = (tag, className, content) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (content !== undefined) result.textContent = String(content);
    return result;
  };
  const isAdmin = () => user?.role === 'admin' && user?.permissions?.adminCommands === true;
  const canReview = () => user?.permissions?.reviewTickets === true;
  const isMember = () => user?.role !== 'admin' && Boolean(user?.developerCommunity && user?.gameBinding);
  const hasLatestAgreement = () => Boolean(config?.agreement?.version && user?.developerCommunity?.agreementVersion === config.agreement.version);
  const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';
  function message(id, text = '', success = false) { $(id).textContent = text; $(id).dataset.success = String(success); }
  function errorText(error) { return error.name === 'TimeoutError' ? '请求超时，请刷新记录确认状态后重试。' : error.message === 'Failed to fetch' ? '网络连接失败，请稍后重试。' : error.message; }

  function executionText(ticket) {
    const execution = ticket.execution || {};
    if (execution.status === 'succeeded' || execution.status === 'completed') return execution.message || '服务器已确认执行成功。';
    if (execution.status === 'failed') return execution.message || '游戏服务器执行失败，需管理员处理。';
    if (ticket.status === 'approved') return execution.message || '已通过审核，等待游戏服务器执行；尚未确认发放。';
    return ticket.status === 'rejected' ? '申请未通过，不会执行。' : '审批通过后才会进入执行队列。';
  }
  function detailText(ticket) {
    const detail = ticket.details || {};
    const parts = [];
    if (detail.durationMinutes) parts.push(`时长 ${detail.durationMinutes} 分钟`);
    if (detail.opLevel) parts.push(`OP 等级 ${detail.opLevel}`);
    if (detail.world) parts.push(`世界 / 区域：${detail.world}`);
    if (detail.materials) parts.push(`物资：${detail.materials}`);
    return parts.join(' · ');
  }
  function ticketCard(ticket, reviewer = false) {
    const card = node('article', 'ticket-card');
    const header = node('div', 'ticket-card-heading');
    header.append(node('strong', '', typeNames[ticket.type] || '申请工单'));
    const status = node('span', 'ticket-status', statusNames[ticket.status] || ticket.status);
    status.dataset.status = ticket.status;
    header.append(status);
    card.append(header);
    if (reviewer) card.append(node('p', 'ticket-owner', `${ticket.username} · 游戏 ID：${ticket.gameId}`));
    card.append(node('p', 'ticket-purpose-copy', ticket.purpose));
    const details = detailText(ticket);
    if (details) card.append(node('p', 'ticket-details', details));
    card.append(node('p', 'ticket-execution', executionText(ticket)));
    if (ticket.reviewNote) card.append(node('p', 'ticket-review-note', `审核意见：${ticket.reviewNote}`));
    card.append(node('p', 'ticket-time', `提交 ${date(ticket.createdAt)}${ticket.reviewedAt ? ` · ${date(ticket.reviewedAt)} 由 ${ticket.reviewedBy || '管理员'} 审核` : ''}`));
    card.append(node('p', 'ticket-id', `工单 ${ticket.id}`));
    if (reviewer && ticket.status === 'pending') {
      const form = node('form', 'ticket-review-form');
      const label = node('label', '', '审核意见');
      const input = node('textarea', '');
      input.rows = 2; input.maxLength = 1000; input.placeholder = '填写审核理由或注意事项';
      label.append(input); form.append(label);
      const controls = node('div', 'ticket-review-actions');
      const reject = node('button', 'operations-secondary', '拒绝'); reject.type = 'button';
      const approve = node('button', 'community-primary', '通过审核'); approve.type = 'button';
      const allowed = config?.reviewWindow?.open === true;
      reject.disabled = !allowed; approve.disabled = !allowed;
      controls.append(reject, approve); form.append(controls);
      const feedback = node('p', 'community-message'); feedback.setAttribute('role', 'status'); form.append(feedback);
      if (!allowed) feedback.textContent = config?.reviewWindow?.message || '正在确认审核时段，请刷新队列后重试。';
      let pending = false;
      async function review(decision) {
        if (pending || !canReview()) return;
        if (decision === 'rejected' && !input.value.trim()) { feedback.textContent = '请说明拒绝原因，便于玩家了解。'; input.focus(); return; }
        pending = true; reject.disabled = true; approve.disabled = true; input.disabled = true; feedback.textContent = '正在保存审核结果…';
        try {
          await account.request('ticket-review', { ticketId: ticket.id, decision, note: input.value.trim() });
          await loadReview();
          message('review-message', decision === 'approved' ? '审批已通过。请以工单执行状态确认是否已在游戏中生效。' : '已拒绝此工单。', true);
        } catch (error) { feedback.textContent = errorText(error); }
        finally { pending = false; reject.disabled = !config?.reviewWindow?.open; approve.disabled = !config?.reviewWindow?.open; input.disabled = false; }
      }
      reject.addEventListener('click', () => review('rejected'));
      approve.addEventListener('click', () => review('approved'));
      form.addEventListener('submit', event => event.preventDefault());
      card.append(form);
    }
    return card;
  }
  function renderOwn() {
    const list = $('own-tickets-list'); list.replaceChildren();
    if (!ownTickets.length) list.append(node('p', 'operations-empty', '暂时没有工单记录。'));
    else ownTickets.forEach(ticket => list.append(ticketCard(ticket)));
  }
  function renderReview() {
    const list = $('review-list'); list.replaceChildren();
    $('review-access-message').hidden = canReview(); $('review-tools').hidden = !canReview(); $('review-refresh').hidden = !canReview();
    if (!canReview()) return;
    const filter = $('review-filter').value;
    const tickets = reviewTickets.filter(ticket => filter === 'all' || ticket.status === filter);
    if (!tickets.length) list.append(node('p', 'operations-empty', filter === 'pending' ? '目前没有待审核工单。' : '此分类下没有工单。'));
    else tickets.forEach(ticket => list.append(ticketCard(ticket, true)));
  }
  async function loadOwn() {
    if (!isMember() || ownLoading) return;
    ownLoading = true; $('own-tickets-refresh').disabled = true;
    message('own-tickets-message', '正在读取工单…');
    try {
      await account.loadConfig();
      const result = await account.request('tickets');
      if (!isMember()) return;
      ownTickets = Array.isArray(result.tickets) ? result.tickets : []; renderOwn(); message('own-tickets-message');
    } catch (error) { message('own-tickets-message', errorText(error)); }
    finally { ownLoading = false; $('own-tickets-refresh').disabled = false; }
  }
  async function loadReview() {
    if (!canReview() || reviewLoading) return;
    reviewLoading = true; $('review-refresh').disabled = true; message('review-message', '正在读取工单…');
    try {
      await account.loadConfig();
      const result = await account.request('review-tickets');
      if (!canReview()) return;
      reviewTickets = Array.isArray(result.tickets) ? result.tickets : []; renderReview();
      message('review-message', config?.reviewWindow?.message || '');
    } catch (error) { message('review-message', errorText(error)); }
    finally { reviewLoading = false; $('review-refresh').disabled = false; }
  }
  function typeFields() {
    const type = $('ticket-type').value;
    $('ticket-duration-fields').hidden = type === 'materials';
    $('ticket-op-fields').hidden = type !== 'op';
    $('ticket-world-fields').hidden = type !== 'creative';
    $('ticket-materials-fields').hidden = type !== 'materials';
    $('ticket-duration').required = type !== 'materials'; $('ticket-duration').disabled = type === 'materials';
    $('ticket-world').required = type === 'creative'; $('ticket-world').disabled = type !== 'creative';
    $('ticket-materials').required = type === 'materials'; $('ticket-materials').disabled = type !== 'materials';
    $('ticket-op-level').disabled = type !== 'op';
  }
  $('ticket-type').addEventListener('change', typeFields);
  $('ticket-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (ticketBusy || !isMember() || !$('ticket-form').reportValidity()) return;
    if (!hasLatestAgreement()) { message('ticket-form-message', '请先在上方阅读并同意最新社区协议，再提交工单。'); return; }
    ticketBusy = true; $('ticket-submit').disabled = true; message('ticket-form-message', '正在提交工单…');
    const type = $('ticket-type').value;
    const payload = { type, purpose: $('ticket-purpose').value.trim() };
    if (type !== 'materials') payload.durationMinutes = Number($('ticket-duration').value);
    if (type === 'creative') payload.world = $('ticket-world').value.trim();
    if (type === 'op') payload.opLevel = Number($('ticket-op-level').value);
    if (type === 'materials') payload.materials = $('ticket-materials').value.trim();
    try {
      await account.request('ticket-create', payload);
      message('ticket-form-message', '工单已提交，等待审核。可在右侧或下方查看进度。', true);
      $('ticket-purpose').value = ''; $('ticket-materials').value = ''; await loadOwn();
    } catch (error) { message('ticket-form-message', errorText(error)); if (error.message.includes('协议')) await account.loadConfig(); }
    finally { ticketBusy = false; $('ticket-submit').disabled = !hasLatestAgreement(); }
  });
  $('own-tickets-refresh').addEventListener('click', loadOwn);
  $('review-refresh').addEventListener('click', loadReview);
  $('review-filter').addEventListener('change', renderReview);

  function terminalLine(content, kind = '') {
    const line = node('p', kind, content); $('admin-output').append(line);
    while ($('admin-output').children.length > 80) $('admin-output').firstElementChild.remove();
    $('admin-output').scrollTop = $('admin-output').scrollHeight;
  }
  const helpText = [
    'help                         显示帮助',
    'ban <时长> <原因> <用户名>     封禁账号（另填执行密钥）',
    '  时长：数字+s / m / d / y；inf 为永久，m 为分钟。',
    'unban <用户名>                解除封禁',
    'setintty devplayer <协议全文>  更新入会协议（支持换行）',
    'playerout <用户名>            永久删除账号（另填执行密钥并确认）',
    'ztsset add <用户名>            授予工单管理员',
    'ztsset remove <用户名>         撤销工单管理员',
    '执行密钥不会写入命令记录。带密钥的完整命令请粘贴到下方专用密码框。',
  ].join('\n');
  function keyMode() {
    const command = $('admin-command').value.trim().split(/\s+/, 1)[0].toLowerCase();
    const needsKey = command === 'ban' || command === 'playerout';
    $('admin-key-row').hidden = !needsKey; $('admin-key').required = needsKey;
    if (!needsKey) $('admin-key').value = '';
  }
  function splitFullCommand(raw) {
    $('admin-full-command').value = '';
    const tokens = raw.trim().split(/\s+/);
    const command = tokens[0]?.toLowerCase();
    if ((command !== 'ban' || tokens.length < 5) && (command !== 'playerout' || tokens.length !== 3)) {
      message('admin-command-message', '完整命令格式不匹配。仅在此粘贴带执行密钥的 ban 或 playerout 命令。'); return;
    }
    const secret = tokens.pop();
    $('admin-command').value = tokens.join(' '); keyMode(); $('admin-key').value = secret;
    message('admin-command-message', '命令与执行密钥已分开填写；密钥不会出现在记录中。', true);
    $('admin-command').focus();
  }
  $('admin-full-command').addEventListener('paste', event => { event.preventDefault(); splitFullCommand(event.clipboardData.getData('text')); });
  $('admin-full-command').addEventListener('input', () => { const text = $('admin-full-command').value; if (text) splitFullCommand(text); });
  $('admin-command').addEventListener('input', keyMode);
  $('admin-command').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !$('admin-command').value.trim().toLowerCase().startsWith('setintty ')) { event.preventDefault(); $('admin-form').requestSubmit(); }
  });
  $('admin-command').addEventListener('paste', event => {
    const raw = event.clipboardData.getData('text'); const tokens = raw.trim().split(/\s+/);
    if ((tokens[0]?.toLowerCase() === 'playerout' && tokens.length === 3) || (tokens[0]?.toLowerCase() === 'ban' && tokens.length >= 5 && !$('admin-key').value)) { event.preventDefault(); splitFullCommand(raw); }
  });
  $('admin-entry').addEventListener('click', () => {
    if (!isAdmin()) return;
    message('admin-command-message'); account.openDialog($('admin-dialog')); $('admin-command').focus();
  });
  $('admin-dialog').addEventListener('close', () => { $('admin-key').value = ''; $('admin-full-command').value = ''; });
  async function executeCommand(command, kind) {
    if (adminBusy || !isAdmin()) return;
    adminBusy = true; $('admin-run').disabled = true; $('delete-confirm-submit').disabled = true;
    $('admin-key').value = ''; $('admin-full-command').value = ''; message('admin-command-message');
    terminalLine(`> 执行 ${kind}`, 'terminal-command');
    const secret = kind === 'ban' || kind === 'playerout' ? command.trim().split(/\s+/).at(-1) : '';
    const redact = value => secret ? String(value).replaceAll(secret, '[已隐藏]') : String(value);
    try {
      const result = await account.request('admin-command', { command });
      terminalLine(redact(result.message || '命令已执行。'), 'terminal-success');
      $('admin-command').value = ''; keyMode();
      if (kind === 'setintty') await account.loadConfig();
      await account.refresh();
      if ($('delete-confirm-dialog').open) account.closeDialog($('delete-confirm-dialog'));
    } catch (error) {
      const safeMessage = redact(errorText(error));
      terminalLine(safeMessage, 'terminal-error'); message('admin-command-message', safeMessage);
      if ($('delete-confirm-dialog').open) message('delete-confirm-message', safeMessage);
    } finally { adminBusy = false; $('admin-run').disabled = false; $('delete-confirm-submit').disabled = false; queuedDeletion = null; }
  }
  $('admin-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!isAdmin() || adminBusy) return;
    const input = $('admin-command').value.trim(); const tokens = input.split(/\s+/); const kind = tokens[0].toLowerCase();
    if (kind === 'help') { terminalLine(helpText); $('admin-command').value = ''; keyMode(); return; }
    if (!['ban', 'unban', 'setintty', 'playerout', 'ztsset'].includes(kind)) { message('admin-command-message', '未知命令，输入 help 查看支持的命令。'); return; }
    const secret = $('admin-key').value;
    if ((kind === 'ban' || kind === 'playerout') && !secret) { message('admin-command-message', '请在执行密钥框填写本次授权密钥。'); $('admin-key').focus(); return; }
    if (kind === 'playerout') {
      if (tokens.length !== 2 || !/^[a-zA-Z0-9_]{3,20}$/.test(tokens[1])) { message('admin-command-message', '格式：playerout 用户名；执行密钥请单独填写。'); return; }
      queuedDeletion = `${input} ${secret}`; $('admin-key').value = '';
      $('delete-confirm-target').textContent = tokens[1]; message('delete-confirm-message'); account.openDialog($('delete-confirm-dialog')); return;
    }
    executeCommand(kind === 'ban' ? `${input} ${secret}` : input, kind);
  });
  $('delete-confirm-cancel').addEventListener('click', () => account.closeDialog($('delete-confirm-dialog')));
  $('delete-confirm-dialog').addEventListener('close', () => { queuedDeletion = null; });
  $('delete-confirm-submit').addEventListener('click', () => { if (queuedDeletion && !adminBusy) executeCommand(queuedDeletion, 'playerout'); });

  function showNotifications() {
    if (!user || notificationBusy || document.querySelector('.account-dialog[open]')) return;
    const notifications = Array.isArray(user.notifications) ? user.notifications : [];
    if (!notifications.length) return;
    const ids = notifications.map(item => item.id);
    if (ids.join('|') === dismissedNotifications) return;
    shownNotificationIds = ids;
    const list = $('notification-list'); list.replaceChildren();
    for (const notification of notifications) {
      const block = node('article', 'account-notification');
      block.append(node('p', '', notification.message), node('small', '', date(notification.createdAt))); list.append(block);
    }
    message('notification-message'); account.openDialog($('notification-dialog'));
  }
  $('notification-dialog').addEventListener('close', () => { dismissedNotifications = shownNotificationIds.join('|'); });
  $('notification-ack').addEventListener('click', async () => {
    if (notificationBusy) return;
    notificationBusy = true; $('notification-ack').disabled = true;
    try { await account.request('notifications-ack', { ids: shownNotificationIds }); account.closeDialog($('notification-dialog')); }
    catch (error) { message('notification-message', errorText(error)); }
    finally { notificationBusy = false; $('notification-ack').disabled = false; }
  });
  document.addEventListener('close', () => setTimeout(showNotifications, 0), true);

  function updateAccount(next) {
    const previous = user; user = next;
    $('admin-entry').hidden = !isAdmin(); $('review-entry').hidden = !canReview(); $('member-tickets').hidden = !isMember();
    $('ticket-submit').disabled = ticketBusy || !hasLatestAgreement();
    if (isMember() && !hasLatestAgreement()) message('ticket-form-message', '请先在上方阅读并同意最新社区协议，再提交工单。');
    else if ($('ticket-form-message').textContent.includes('最新社区协议')) message('ticket-form-message');
    if (!isAdmin()) {
      if ($('admin-dialog').open) account.closeDialog($('admin-dialog'));
      if ($('delete-confirm-dialog').open) account.closeDialog($('delete-confirm-dialog'));
      $('admin-output').replaceChildren(node('p', '', 'mypixel club 管理命令台。输入 help 查看可用命令。'));
      $('admin-command').value = ''; $('admin-key').value = ''; queuedDeletion = null;
    }
    if (!user && $('notification-dialog').open) account.closeDialog($('notification-dialog'));
    if (!isMember()) { ownTickets = []; renderOwn(); }
    if (!canReview()) { reviewTickets = []; renderReview(); }
    const key = `${user?.username || ''}|${Boolean(user?.developerCommunity)}|${canReview()}`;
    if (key !== lastUserKey) {
      lastUserKey = key;
      if (isMember()) loadOwn();
      if (canReview() && location.hash === '#tickets') loadReview();
    }
    if (previous?.username !== user?.username) dismissedNotifications = '';
    showNotifications();
  }
  function route() { if (location.hash === '#tickets') { renderReview(); if (canReview()) loadReview(); } else if (location.hash === '#developers' && isMember()) loadOwn(); }
  window.addEventListener('mypixel:account', event => updateAccount(event.detail));
  window.addEventListener('mypixel:config', event => { config = event.detail; updateAccount(user); if (location.hash === '#tickets') renderReview(); });
  window.addEventListener('hashchange', route);
  window.addEventListener('focus', route);
  setInterval(() => { if (!document.hidden && user) { if (location.hash === '#tickets' && canReview()) loadReview(); if (location.hash === '#developers' && isMember()) loadOwn(); } }, 30000);
  typeFields(); updateAccount(user); route();
})();
