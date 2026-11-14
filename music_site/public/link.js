/* QQ login and profile entry share one action; optional QQ numbers are self-reported. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let current = null;
  async function request(path, body, extra = {}) {
    const response = await fetch(path, {method:body ? 'POST' : 'GET',
      headers:{'Content-Type':'application/json',...extra},body:body ? JSON.stringify(body) : undefined,
      credentials:'same-origin',cache:'no-store'});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法完成操作');
    return result;
  }
  async function refresh() {
    current = await request('/music/api/session');
    const pending = current.pending || current.pending_entry;
    $('musicLinkStatus').textContent = current.linked
      ? '已进入原有成分表。'
      : current.authenticated ? '旧成分已找回，点击下方按钮连接登录并保留原资料。'
        : '已有旧成分请先用下方原口令找回；首次使用会在登录后自动建立成分。';
    $('musicEntryForm').hidden = !!(current.linked && current.qq_connected);
    $('musicNameField').hidden = !!current.authenticated;
    $('musicEntryQQField').hidden = !!(current.authenticated && /^\d{4,12}$/.test(current.qq));
    $('musicEntryButton').textContent = current.board_authenticated && current.qq_connected
      ? '进入成分站' : current.authenticated || current.board_authenticated ? '连接 QQ 并进入成分站' : 'QQ 登录并进入成分站';
    $('musicEntryButton').disabled = !!pending;
    $('musicCancelLink').hidden = !pending;
    $('musicNewName').value = current.entry_name || current.board_name || '';
    $('musicEntryQQ').value = current.pending_entry ? current.entry_contactQQ : current.contactQQ || '';
    $('musicContactDetails').hidden = !current.linked || /^\d{4,12}$/.test(current.qq);
    $('musicContactQQ').value = current.contactQQ || '';
    $('musicContactDetails').open = !current.contactQQ;
    if (pending) {
      try {
        await request(current.pending_entry ? '/music/api/entry/complete' : '/music/api/link/complete', {});
        location.replace('/music/');
      } catch (error) { $('musicLinkError').textContent = error.message; }
    }
  }
  async function enter(event) {
    event.preventDefault();
    $('musicLinkError').textContent = '';
    if (!$('musicPrivacy').checked) {
      $('musicLinkError').textContent = '请先阅读并同意成分资料及账号关联说明';
      return;
    }
    const number = $('musicEntryQQ').value.trim();
    if (number && !/^[1-9][0-9]{3,11}$/.test(number)) {
      $('musicLinkError').textContent = 'QQ 号需为 4–12 位数字，或留空';
      return;
    }
    $('musicEntryButton').disabled = true;
    try {
      const me = await request('/api/me');
      const state = await request('/music/api/session');
      if (state.authenticated && !state.linked) {
        await request('/music/api/link/start', {});
      } else {
        const started = await request('/music/api/entry/start', {
          name:$('musicNewName').value.trim(),
          contactQQ:state.authenticated && /^\d{4,12}$/.test(state.qq) ? state.qq : number,
          consent:true
        });
        if (started.complete) { location.replace('/music/'); return; }
      }
      const result = await request('/api/auth/qq/start', {
        mode:me.authenticated ? 'bind' : 'login',confirm:true,return_path:'/music/',
        accept_privacy:true,privacy_version:me.privacy_version
      }, {'X-Kanban-Version':'2','Idempotency-Key':crypto.randomUUID(),'X-Kanban-Identity':me.draft_scope});
      location.assign(result.authorize_url);
    } catch (error) {
      $('musicLinkError').textContent = error.message;
      $('musicEntryButton').disabled = false;
      const state = await request('/music/api/session').catch(() => ({}));
      $('musicCancelLink').hidden = !(state.pending || state.pending_entry);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('musicEntryForm').addEventListener('submit', enter);
    $('musicContactForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('musicContactSave').disabled = true;
      $('musicLinkError').textContent = '';
      try {
        await request('/music/api/profile/contact', {contactQQ:$('musicContactQQ').value.trim()});
        location.replace('/music/');
      } catch (error) { $('musicLinkError').textContent = error.message; }
      finally { $('musicContactSave').disabled = false; }
    });
    $('musicCancelLink').addEventListener('click', async () => {
      try {
        await request('/music/api/link/cancel', {});
        $('musicLinkError').textContent = '';
        await refresh();
      } catch (error) { $('musicLinkError').textContent = error.message; }
    });
    refresh().catch(error => { $('musicLinkError').textContent = error.message; });
  });
  window.addEventListener('music-login', () => refresh().catch(error => {
    $('musicLinkError').textContent = error.message;
  }));
})();
