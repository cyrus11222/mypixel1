(() => {
  const name = document.getElementById('account-name');
  const button = document.getElementById('account-logout');
  if (location.protocol === 'file:') { name.textContent = '本地页面预览'; button.textContent = '登录页面'; button.addEventListener('click', () => { location.href = 'login.html'; }); return; }
  let pending = false;
  async function check() {
    try {
      const response = await fetch('/api/auth?action=me', { credentials:'same-origin',cache:'no-store' });
      if (response.status === 401) { location.replace('/login'); return; }
      if (!response.ok) throw Error();
      const result = await response.json(); name.textContent = result.user.username; name.title = result.user.username;
    } catch { name.textContent = '暂无法验证账户'; }
  }
  button.addEventListener('click', async () => {
    if(pending) return; pending = true; button.disabled = true; button.textContent = '正在退出';
    try {
      const response = await fetch('/api/auth?action=logout', { method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}' });
      if (!response.ok) throw Error();
      location.replace('/login');
    } catch { name.textContent = '退出失败，请重试'; button.disabled = false; button.textContent = '退出'; pending = false; }
  });
  window.addEventListener('pageshow',check);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) check();});
})();
