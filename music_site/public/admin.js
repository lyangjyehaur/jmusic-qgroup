(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CATS = ['歌手', '乐队', '组合', '偶像', 'Vocaloid P', '作曲家', '社团', '企划', '其他'];
  let csrf = '';
  let state = { entries: [] };
  let entryQuery = '';

  function norm(s) {
    return String(s || '').normalize('NFKC').replace(/[\u200b-\u200f\ufeff\u00ad]/g, '')
      .replace(/\s+/g, '').toLowerCase();
  }

  let pyReady = false;
  let pyLoading = false;

  function ensurePinyin() {
    if (pyReady || pyLoading) return;
    pyLoading = true;
    const a = document.createElement('script');
    a.src = '/music/initials.js';
    a.onload = () => {
      const b = document.createElement('script');
      b.src = '/music/pinyin.js';
      b.onload = () => { pyReady = true; renderEntries(); };
      b.onerror = () => { pyLoading = false; };
      document.head.appendChild(b);
    };
    a.onerror = () => { pyLoading = false; };
    document.head.appendChild(a);
  }

  function searchKeys(text) {
    const keys = [norm(text)];
    if (pyReady && window.PY_FULL && window.PY_INITIALS) {
      const full = String(window.PY_FULL).split(' ');
      const ini = String(window.PY_INITIALS);
      const base = 0x4E00;
      let fs = '';
      let is = '';
      for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        if (cp >= base && cp <= base + 20991) {
          const f = full[cp - base];
          if (f) fs += f;
          const i = ini[cp - base];
          if (i && i !== ' ') is += i;
        }
      }
      if (fs) keys.push(fs.toLowerCase());
      if (is) keys.push(is.toLowerCase());
    }
    return keys;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 2400);
  }
  async function api(path, body, method) {
    const opt = { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin', headers: body ? {'X-Kanban-Admin': csrf} : {} };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch('/music' + path, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    try { localStorage.setItem('jpm.theme', theme); } catch (e) {}
  }

  function bindCreate() {
    const btn = $('newEntryBtn');
    if (!btn) return;
    btn.onclick = async () => {
      const text = $('newEntryText').value.trim();
      if (!text) { toast('词条不能为空'); return; }
      btn.disabled = true;
      try {
        const r = await api('/api/admin/create', {
          text,
          category: $('newEntryCat').value,
          kind: $('newEntryKind').value,
        });
        toast('已创建「' + r.entry.text + '」');
        $('newEntryText').value = '';
        await loadState();
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    };
    $('newEntryText').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); btn.click(); }
    });
  }

  bindCreate();

  function fillMerge() {
    const from = $('mergeFrom');
    const to = $('mergeTo');
    if (!from || !to || !state) return;
    const list = (state.entries || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0) || a.text.localeCompare(b.text, 'zh'));
    [from, to].forEach(sel => {
      const keep = sel.value;
      sel.innerHTML = '';
      list.forEach(e => {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.text + '（' + (e.count || 0) + ' 人）';
        sel.appendChild(o);
      });
      if (keep && list.some(e => e.id === keep)) sel.value = keep;
    });
    if (from.value && from.value === to.value && list.length > 1) to.value = list.find(e => e.id !== from.value).id;
  }

  function bindMerge() {
    const btn = $('mergeBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const fromId = $('mergeFrom').value;
      const toId = $('mergeTo').value;
      if (!fromId || !toId || fromId === toId) { toast('选两个不同的词条'); return; }
      if (!confirm('合并后「' + $('mergeFrom').selectedOptions[0].textContent + '」会被删除，确定吗？')) return;
      try {
        await api('/api/admin/merge', { fromId, toId });
        toast('已合并');
        await loadState();
        fillMerge();
      } catch (e) { toast(e.message); }
    });
  }

  function bindPin() {
    const btn = $('pinBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const qq = $('pinQQ').value.trim();
      const pin = $('pinNew').value.trim();
      if (!/^\d{4,12}$/.test(qq)) { toast('QQ 号要 4-12 位数字'); return; }
      if (!/^\d{4,6}$/.test(pin)) { toast('口令要 4-6 位数字'); return; }
      try {
        await api('/api/admin/pin', { qq, pin });
        toast('已重置');
        $('pinQQ').value = '';
        $('pinNew').value = '';
      } catch (e) { toast(e.message); }
    });
  }

  bindMerge();
  bindPin();

  async function loadState() {
    state = await api('/api/admin/state');
    renderEntries();
    fillMerge();
  }

  function renderEntries() {
    const tb = $('entryTbody');
    tb.innerHTML = '';
    const q = norm(entryQuery);
    const list = q ? state.entries.filter(e => searchKeys(e.text).some(k => k.includes(q))) : state.entries;
    const hint = $('adminHint');
    if (hint) {
      hint.textContent = `共 ${state.entries.length} 个词条` +
        (q ? ` · 匹配 ${list.length} 个` : '') + ` · ${state.memberCount || 0} 位群友`;
    }
    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'muted tiny';
      td.textContent = q ? `没有匹配「${entryQuery}」的词条` : '还没有词条';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    list.forEach(e => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const inp = document.createElement('input');
      inp.value = e.text;
      inp.maxLength = 24;
      inp.style.minWidth = '140px';
      tdName.appendChild(inp);

      const tdCat = document.createElement('td');
      const sel = document.createElement('select');
      (state.categories || CATS).forEach(c => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        if (c === (e.category || '其他')) o.selected = true;
        sel.appendChild(o);
      });
      tdCat.appendChild(sel);

      const tdKind = document.createElement('td');
      const ksel = document.createElement('select');
      [['main', '领域'], ['sub', '细分']].forEach(([val, label]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = label;
        if ((e.kind || (e.category === '领域' ? 'main' : 'sub')) === val) o.selected = true;
        ksel.appendChild(o);
      });
      tdKind.appendChild(ksel);

      const tdCnt = document.createElement('td');
      tdCnt.textContent = (e.count || 0) + ' 人';

      const tdCreator = document.createElement('td');
      tdCreator.className = 'muted tiny';
      tdCreator.textContent = (e.creatorName || '—') + (e.createdBy && e.createdBy !== 'admin' ? '（' + e.createdBy + '）' : '');

      const tdAct = document.createElement('td');
      const acts = document.createElement('div');
      acts.className = 'row-actions';
      const save = document.createElement('button');
      save.className = 'primary small';
      save.textContent = '保存';
      save.onclick = async () => {
        try {
          await api('/api/admin/edit', { entryId: e.id, text: inp.value.trim(), category: sel.value, kind: ksel.value });
          toast('已保存');
          loadState();
        } catch (err) { toast(err.message); }
      };
      const del = document.createElement('button');
      del.className = 'danger small';
      del.textContent = '删除';
      del.onclick = async () => {
        if (!confirm(`删除「${e.text}」？选了它的群友记录也会一起移除。`)) return;
        try {
          await api('/api/admin/delete', { entryId: e.id });
          toast('已删除');
          loadState();
        } catch (err) { toast(err.message); }
      };
      acts.append(save, del);
      tdAct.appendChild(acts);

      tr.append(tdName, tdCat, tdKind, tdCnt, tdCreator, tdAct);
      tb.appendChild(tr);
    });
  }

  async function loadBackups() {
    try {
      const r = await api('/api/admin/backups');
      const ul = $('backupList');
      ul.innerHTML = '';
      if (!r.backups.length) {
        ul.innerHTML = '<li class="muted tiny">还没有备份</li>';
        return;
      }
      r.backups.forEach(b => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = b.name;
        const a = document.createElement('a');
        a.className = 'link small';
        a.textContent = '下载';
        a.href = '/music/api/admin/backup?name=' + encodeURIComponent(b.name);
        li.append(name, a);
        ul.appendChild(li);
      });
    } catch (err) {
      toast(err.message);
    }
  }

  let membersCache = [];
  let memberQuery = '';
  async function loadMembers() {
    try {
      const r = await api('/api/admin/members', {});
      membersCache = r.members || [];
      renderMembers();
    } catch (err) { toast(err.message); }
  }
  async function loadShoutsAdmin() {
    const tb = $('shoutList');
    if (!tb) return;
    try {
      const r = await api('/api/admin/shout/list', {});
      const active = r.active || [];
      const history = r.history || [];
      $('shoutAdminHint').textContent = '当前 ' + active.length + ' 条 · 历史 ' + history.length + ' 条';
      tb.innerHTML = '';
      if (!active.length && !history.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'muted tiny';
        td.textContent = '还没有喊话';
        tr.appendChild(td);
        tb.appendChild(tr);
        return;
      }
      const rows = active.map(s => [s, false]).concat(history.map(s => [s, true]));
      rows.forEach(([s, archived]) => {
        const tr = document.createElement('tr');
        const c0 = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'shout-badge' + (archived ? ' old' : '');
        badge.textContent = archived ? '历史' : '当前';
        c0.appendChild(badge);
        const c1 = document.createElement('td');
        c1.className = 'shout-cell-text';
        c1.textContent = s.text;
        const c2 = document.createElement('td');
        c2.textContent = (s.name || '群友') + ' · ' + s.qq;
        const c3 = document.createElement('td');
        c3.className = 'muted tiny';
        const d = new Date((s.createdAt || 0) * 1000);
        const pad = n => String(n).padStart(2, '0');
        c3.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        const c4 = document.createElement('td');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'link small danger';
        del.textContent = '删除';
        del.addEventListener('click', async () => {
          if (!confirm('确定删除这条喊话吗？\n' + s.text)) return;
          try {
            await api('/api/admin/shout/delete', { id: s.id });
            toast('已删除');
            loadShoutsAdmin();
          } catch (err) { toast(err.message); }
        });
        c4.appendChild(del);
        tr.append(c0, c1, c2, c3, c4);
        tb.appendChild(tr);
      });
    } catch (err) { toast(err.message); }
  }

  function pickChip(m) {
    const s = document.createElement('span');
    s.className = 'pick-chip' + (m.kind === 'main' ? ' kind-main' : '');
    s.textContent = m.text;
    if (m.kind !== 'main' && m.level && m.level !== 3) {
      const lv = document.createElement('i');
      lv.className = 'lv-mini lv' + m.level;
      lv.textContent = m.levelLabel || '';
      s.appendChild(lv);
    }
    return s;
  }
  function renderMembers() {
    const tb = $('memberList');
    if (!tb) return;
    const q = memberQuery.toLowerCase();
    const list = membersCache.filter((m) => !q || String(m.qq).includes(q) || String(m.name || '').toLowerCase().includes(q));
    $('membersHint').textContent = '共 ' + membersCache.length + ' 位群友' + (q ? ' · 匹配 ' + list.length + ' 位' : '');
    tb.innerHTML = '';
    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted tiny';
      td.textContent = '没有匹配的群友';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    list.forEach((m) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      const nm = document.createElement('b');
      nm.textContent = m.name || '（无名）';
      if (m.dupName) {
        const dup = document.createElement('span');
        dup.className = 'dup-badge';
        dup.textContent = '同名';
        dup.title = '存在同名账号，可能是重复注册';
        nm.appendChild(dup);
      }
      const qq = document.createElement('div');
      qq.className = 'muted tiny';
      qq.textContent = window.musicMemberLabel(m.qq) + (m.hasPin ? ' · 旧口令已设置' : ' · 使用看板账号登录');
      c1.append(nm, qq);
      const c2 = document.createElement('td');
      c2.textContent = (m.createdCount || 0) + ' 个';
      const c3 = document.createElement('td');
      const box = document.createElement('div');
      box.className = 'pick-chips';
      if (!m.picks || !m.picks.length) {
        box.innerHTML = '<span class="muted tiny">还没选词条</span>';
      } else {
        m.picks.forEach((p) => box.appendChild(pickChip(p)));
      }
      c3.appendChild(box);
      const cBoard = document.createElement('td');
      const boardWrap = document.createElement('div');
      boardWrap.className = 'board-id-cell';
      const boardInput = document.createElement('input');
      boardInput.type = 'text';
      boardInput.className = 'board-id-input';
      boardInput.placeholder = '未绑定';
      boardInput.value = m.boardUserId || '';
      boardInput.readOnly = true;
      const boardSave = document.createElement('button');
      boardSave.type = 'button';
      boardSave.className = 'link small';
      boardSave.textContent = '管理关联';
      boardSave.addEventListener('click', () => { window.location.href = '/admin#music-links-section'; });
      boardWrap.append(boardInput, boardSave);
      cBoard.appendChild(boardWrap);
      const c4 = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link small danger';
      del.textContent = '删账号';
      del.addEventListener('click', async () => {
        if (!confirm('确定删除「' + (m.name || m.qq) + '」（' + window.musicMemberLabel(m.qq) + '）这个账号吗？会同步清理成分关联、会话及该用户的留言；词条保留但移除创建者身份。')) return;
        try {
          await api('/api/admin/member/delete', { qq: m.qq, confirm: 'DELETE' });
          toast('已删除账号');
          loadMembers();
          loadShoutsAdmin();
          loadState();
        } catch (err) { toast(err.message); }
      });
      c4.appendChild(del);
      tr.append(c1, c2, c3, cBoard, c4);
      tb.appendChild(tr);
    });
  }
  async function boot() {
    let theme = 'light';
    try {
      theme = localStorage.getItem('jpm.theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) {}
    applyTheme(theme);
    $('themeBtn').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    $('adminSearch').addEventListener('input', (ev) => {
      entryQuery = ev.target.value.trim();
      ensurePinyin();
      renderEntries();
    });
    $('adminSearch').addEventListener('focus', ensurePinyin, { once: true });
    $('adminSearchClear').addEventListener('click', () => {
      $('adminSearch').value = '';
      entryQuery = '';
      renderEntries();
      $('adminSearch').focus();
    });
    // ---- wallpapers ----
    let lastWalls = null;

    function renderWalls(w) {
      const grid = $('wallGrid');
      if (!grid) return;
      lastWalls = w;
      const items = w.items || [];
      grid.innerHTML = '';
      $('wallSecs').value = w.rotateSeconds || 24;
      const on = items.filter((it) => it.enabled !== false).length;
      if ($('wallCount')) $('wallCount').textContent = items.length;
      if ($('wallOnCount')) $('wallOnCount').textContent = on;
      $('wallHint').textContent = items.length
        ? '共 ' + items.length + ' 张，参与轮换 ' + on + ' 张，每 ' + (w.rotateSeconds || 24) + ' 秒切换一次。'
        : '还没有上传壁纸，首页使用默认背景。';
      items.forEach((it, idx) => {
        const cell = document.createElement('div');
        cell.className = 'wall-item' + (it.enabled === false ? ' off' : '');
        const img = document.createElement('img');
        img.src = '/music' + it.src; img.alt = it.name || '壁纸'; img.loading = 'lazy';
        const en = document.createElement('label');
        en.className = 'wall-en';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = it.enabled !== false;
        cb.addEventListener('change', () => {
          api('/api/admin/wall/toggle', { src: it.src, enabled: cb.checked }).then((r) => {
            if (r && r.walls) renderWalls(r.walls);
            toast(cb.checked ? '已加入轮换' : '已移出轮换');
          }).catch((err) => toast(err.message));
        });
        en.append(cb, document.createTextNode('参与轮换'));
        const meta = document.createElement('div');
        meta.className = 'wall-meta';
        meta.innerHTML = '<b>' + escapeHtml(it.name || '壁纸') + '</b><span class="muted tiny">'
          + (it.size ? (Math.round(it.size / 1024) + ' KB') : '文件缺失') + '</span>';
        const ops = document.createElement('div');
        ops.className = 'wall-ops';
        const up = document.createElement('button');
        up.type = 'button'; up.className = 'link small'; up.textContent = '↑'; up.title = '上移'; up.disabled = idx === 0;
        up.addEventListener('click', () => moveWall(it, -1));
        const down = document.createElement('button');
        down.type = 'button'; down.className = 'link small'; down.textContent = '↓'; down.title = '下移'; down.disabled = idx === items.length - 1;
        down.addEventListener('click', () => moveWall(it, 1));
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'link small danger';
        del.textContent = '删除';
        del.addEventListener('click', () => {
          if (!confirm('删除这张壁纸？')) return;
          api('/api/admin/wall/delete', { src: it.src }).then((r) => {
            if (r && r.walls) renderWalls(r.walls);
            toast('已删除');
          }).catch((err) => toast(err.message));
        });
        ops.append(up, down, del);
        cell.append(img, en, meta, ops);
        grid.appendChild(cell);
      });
    }

    function moveWall(it, dir) {
      api('/api/admin/wall/move', { src: it.src, dir }).then((r) => {
        if (r && r.walls) renderWalls(r.walls);
      }).catch((err) => toast(err.message));
    }

    async function setAllWalls(enabled) {
      const items = (lastWalls && lastWalls.items) || [];
      for (const it of items) {
        try {
          const r = await api('/api/admin/wall/toggle', { src: it.src, enabled });
          if (r && r.walls) lastWalls = r.walls;
        } catch (err) { /* 忽略单张失败 */ }
      }
      if (lastWalls) renderWalls(lastWalls);
      toast(enabled ? '已全部启用' : '已全部停用');
    }

    async function loadWalls() {
      if (!csrf) return;
      try {
        const r = await api('/api/admin/walls', {});
        if (r && r.items) renderWalls(r);
      } catch (err) { /* 权限失效时静默 */ }
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    if ($('wallFile')) {
      $('wallFile').addEventListener('change', (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = '';
        if (!files.length) return;
        let i = 0;
        const next = () => {
          if (i >= files.length) { loadWalls(); toast('壁纸已上传'); return; }
          const f = files[i++];
          if (f.size > 2 * 1024 * 1024) { toast('「' + f.name + '」超过 2MB，跳过'); next(); return; }
          const rd = new FileReader();
          rd.onload = () => api('/api/admin/wall/upload', { name: f.name.replace(/\.[^.]+$/, ''), data: rd.result })
            .then((r) => { if (r && r.walls) renderWalls(r.walls); next(); })
            .catch((err) => { toast(err.message); next(); });
          rd.onerror = () => { toast('读取失败：' + f.name); next(); };
          rd.readAsDataURL(f);
        };
        next();
      });
      if ($('wallAllOn')) $('wallAllOn').addEventListener('click', () => setAllWalls(true));
      if ($('wallAllOff')) $('wallAllOff').addEventListener('click', () => setAllWalls(false));
      if ($('wallJump')) {
        $('wallJump').hidden = false;
        $('wallJump').addEventListener('click', () => {
          const sec = $('wallGrid') && $('wallGrid').closest('.admin-section');
          if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      $('wallSecsBtn').addEventListener('click', () => {
        api('/api/admin/wall/config', { rotateSeconds: Number($('wallSecs').value) || 24 }).then((r) => {
          if (r && r.walls) { renderWalls(r.walls); toast('切换间隔已保存'); }
        }).catch((err) => toast(err.message));
      });
    }

    $('exportBtn').addEventListener('click', () => {
      window.open('/music/api/export', '_blank', 'noopener');
    });
    $('backupBtn').addEventListener('click', loadBackups);
    if ($('shoutRefresh')) $('shoutRefresh').addEventListener('click', loadShoutsAdmin);
    $('memberSearch').addEventListener('input', (ev) => { memberQuery = ev.target.value.trim(); renderMembers(); });
    $('memberSearchClear').addEventListener('click', () => { $('memberSearch').value = ''; memberQuery = ''; renderMembers(); $('memberSearch').focus(); });
    $('resetBtn').addEventListener('click', async () => {
      if ($('resetInput').value.trim() !== 'RESET') { toast('请输入 RESET 确认'); return; }
      if (!confirm('确定清空所有词条和群友记录吗？此操作不可撤销（会先备份）。')) return;
      try {
        await api('/api/admin/reset', { confirm: 'RESET' });
        toast('已清空');
        $('resetInput').value = '';
        loadState();
      } catch (err) { toast(err.message); }
    });

    try {
      const access = await api('/api/admin/session');
      csrf = access.csrf;
      $('loginCard').hidden = true;
      $('adminCard').hidden = false;
      $('membersCard').hidden = false;
      await Promise.all([loadState(), loadBackups(), loadMembers(), loadShoutsAdmin(), loadWalls()]);
    } catch (error) {
      csrf = '';
      $('loginError').textContent = error.message;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
