(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let busy = false;
  const element = (tag, className, text) => { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; };
  function size(bytes) { if (!Number.isFinite(bytes) || bytes < 0) return '大小未知'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
  async function load() {
    if (busy) return;
    if (location.protocol === 'file:') { $('downloads-message').textContent = '下载列表请通过已部署的官网访问。'; return; }
    busy = true; $('downloads-refresh').disabled = true; $('downloads-message').textContent = '正在读取已发布文件…';
    try {
      const response = await fetch('/api/downloads', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) });
      let result; try { result = await response.json(); } catch { throw new Error('下载服务暂未正确响应，请稍后重试。'); }
      if (!response.ok) throw new Error(result.error || '无法读取下载列表，请稍后重试。');
      if (!Array.isArray(result.downloads)) throw new Error('下载列表格式暂不可用。');
      const container = $('downloads-list'); container.replaceChildren();
      for (const file of result.downloads) {
        const url = new URL(file.url, location.origin);
        if (url.origin !== location.origin || url.pathname !== '/api/downloads') continue;
        const card = element('article', 'download-card', ''); const icon = element('span', 'download-icon', '↓'); icon.setAttribute('aria-hidden', 'true');
        const copy = element('div', 'download-copy', ''); copy.append(element('h2', '', file.name), element('p', '', file.path), element('span', '', size(file.bytes)));
        const link = element('a', 'download-button', '下载文件 ↗'); link.href = url.pathname + url.search; link.setAttribute('aria-label', `下载 ${file.name}`);
        card.append(icon, copy, link); container.append(card);
      }
      $('downloads-message').textContent = container.children.length ? `共 ${container.children.length} 个已发布文件。` : '暂时没有已发布的下载文件，稍后再来看看。';
      $('downloads-message').dataset.success = 'true';
    } catch (error) { $('downloads-message').textContent = error.name === 'TimeoutError' ? '下载列表读取超时，请稍后刷新。' : error.message; $('downloads-message').dataset.success = 'false'; }
    finally { busy = false; $('downloads-refresh').disabled = false; }
  }
  $('downloads-refresh').addEventListener('click', load);
  window.addEventListener('hashchange', () => { if (location.hash === '#downloads') load(); });
  window.addEventListener('mypixel:downloads-updated', () => { if (location.hash === '#downloads') load(); });
  if (location.hash === '#downloads') load();
})();
