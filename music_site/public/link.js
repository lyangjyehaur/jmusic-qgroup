/* The music app never receives the QQ App Key, OpenID, or board session token. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let current = null;
  async function request(path, body, extra = {}) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法完成操作');
    return result;
  }
  async function refresh() {
    current = await request('/music/api/session');
    $('musicLinkStatus').textContent = current.linked
      ? (current.qq_connected ? '已连接 QQ 登录，原有成分已保留。' : '已通过看板账号进入原有成分表。')
      : current.authenticated
        ? '旧站登录成功。连接 QQ 登录后，以后可以直接进入原有成分表。'
        : '老用户先用下方 QQ 号和原口令登录；已连接的用户可直接使用 QQ 登录。';
    $('musicQQButton').hidden = current.linked;
    $('musicQQButton').textContent = current.authenticated ? '连接 QQ 登录，保留原有成分' : '使用 QQ 登录';
    $('musicPrivacyLabel').hidden = current.linked;
    if (current.pending) {
      try {
        await request('/music/api/link/complete', {});
        location.replace('/music/');
      } catch (error) {
        $('musicLinkError').textContent = error.message;
      }
    }
  }
  async function begin() {
    $('musicLinkError').textContent = '';
    if (!$('musicPrivacy').checked) {
      $('musicLinkError').textContent = '请先阅读并同意隐私政策及账号关联说明';
      return;
    }
    $('musicQQButton').disabled = true;
    try {
      // Establish a board visitor session before recording the legacy proof.
      const me = await request('/api/me');
      if (current?.authenticated && !current.linked) await request('/music/api/link/start', {});
      const result = await request('/api/auth/qq/start', {
        mode: 'login', confirm: true, return_path: '/music/',
        accept_privacy: true, privacy_version: me.privacy_version
      }, { 'X-Kanban-Version':'2', 'Idempotency-Key':crypto.randomUUID(), 'X-Kanban-Identity':me.draft_scope });
      location.assign(result.authorize_url);
    } catch (error) {
      $('musicLinkError').textContent = error.message;
      $('musicQQButton').disabled = false;
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('musicQQButton').addEventListener('click', begin);
    refresh().catch((error) => { $('musicLinkError').textContent = error.message; });
  });
  window.addEventListener('music-login', () => refresh().catch((error) => {
    $('musicLinkError').textContent = error.message;
  }));
})();
