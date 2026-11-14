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
      ? (current.qq_connected ? '已通过看板账号进入成分表。' : '已通过看板账号进入成分表；可连接 QQ，方便以后登录原账号。')
      : current.authenticated
        ? '旧站登录成功。连接 QQ 登录后，以后可以直接进入原有成分表。'
        : current.board_authenticated
          ? `当前看板账号：${current.board_name}。有旧成分请先找回，第一次使用可建立成分。`
          : '老用户可用下方 QQ 号和原口令找回成分；新用户请先使用 QQ 登录。';
    $('musicQQButton').hidden = current.linked && current.qq_connected;
    $('musicQQButton').textContent = current.board_authenticated ? '连接当前看板账号的 QQ 登录' : current.authenticated ? '连接 QQ 登录，保留原有成分' : '使用 QQ 登录';
    $('musicPrivacyLabel').hidden = current.linked && current.qq_connected;
    $('musicCreateForm').hidden = !!(!current.board_authenticated || current.authenticated || current.pending);
    $('musicCancelLink').hidden = !current.pending;
    if (!$('musicNewName').value) $('musicNewName').value = current.board_name || '';
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
        mode: me.authenticated ? 'bind' : 'login', confirm: true, return_path: '/music/',
        accept_privacy: true, privacy_version: me.privacy_version
      }, { 'X-Kanban-Version':'2', 'Idempotency-Key':crypto.randomUUID(), 'X-Kanban-Identity':me.draft_scope });
      location.assign(result.authorize_url);
    } catch (error) {
      $('musicLinkError').textContent = error.message;
      $('musicQQButton').disabled = false;
    }
  }
  async function createProfile(event) {
    event.preventDefault();
    $('musicLinkError').textContent = '';
    if (!$('musicNewConsent').checked) {
      $('musicLinkError').textContent = '请先阅读隐私政策并确认建立空白成分';
      return;
    }
    $('musicCreateButton').disabled = true;
    try {
      await request('/music/api/profile/create', {
        name: $('musicNewName').value.trim(), consent: true, confirm_new: true
      });
      location.replace('/music/');
    } catch (error) {
      $('musicLinkError').textContent = error.message;
      $('musicCreateButton').disabled = false;
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('musicQQButton').addEventListener('click', begin);
    $('musicCreateForm').addEventListener('submit', createProfile);
    $('musicCancelLink').addEventListener('click', async () => {
      try {
        await request('/music/api/link/cancel', {});
        $('musicLinkError').textContent = '';
        await refresh();
      } catch (error) { $('musicLinkError').textContent = error.message; }
    });
    refresh().catch((error) => { $('musicLinkError').textContent = error.message; });
  });
  window.addEventListener('music-login', () => refresh().catch((error) => {
    $('musicLinkError').textContent = error.message;
  }));
})();
