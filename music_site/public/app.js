(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const memberLabel = window.musicMemberLabel;
  const memberKind = window.musicMemberKind;
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_SEL = 20;
  const MAX_CREATE = 8;
  const CREATE_LIMITS = { main: 2, sub: 8 };
  const RANK_LIMIT = { main: 10, sub: 20 };
  const RANK_COLLAPSED = { main: 10, sub: 10 };  // 默认各显示前 10
  const SUB_EXPAND_CAP = 20;                       // 细分榜展开后最多到第 20 名，其余去「更多细分」看
  const rankLimit = (kind) => RANK_LIMIT[kind] || 10;
  const PALETTE = ['#ff8fab','#fca5c8','#c084fc','#a78bfa','#818cf8','#60a5fa','#38bdf8','#34d399','#a3e635','#fbbf24','#fb923c','#f87171','#f472b6','#e879f9','#2dd4bf','#93c5fd'];
  const CATS = ['歌手', '乐队', '组合', '偶像', 'Vocaloid P', '作曲家', '社团', '企划', '其他'];

  let identity = null;          // {qq, name}
  let state = { entries: [], memberCount: 0, categories: CATS };
  let member = null;
  let selection = new Set();
  let selLevels = {};
  const LEVEL_LABELS = { 4: '本命', 3: '常听', 2: '听过一些', 1: '只听过几首' };
  function selLevel(id) { return selLevels[id] || 3; }
  function levelLabel(lv) { return LEVEL_LABELS[lv] || '常听'; }
  let wallTimer = null;
  let wallStarted = false;
  function initWallpapers() {
    const layer = $('wallLayer');
    if (!layer || wallStarted) return;
    const panes = [$('wallA'), $('wallB')];
    if (!panes[0] || !panes[1]) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    wallStarted = true;
    const dims = new Map(); // src -> { w, h }
    const preload = (src) => new Promise((resolve) => {
      let done = false;
      const finish = (d) => { if (!done) { done = true; resolve(d && d.w ? d : null); } };
      const im = new Image();
      im.onload = () => {
        const d = { w: im.naturalWidth || 0, h: im.naturalHeight || 0 };
        if (d.w && d.h) dims.set(src, d);
        if (im.decode) im.decode().then(() => finish(d), () => finish(d));
        else finish(d);
      };
      im.onerror = () => finish(null);
      im.src = src;
      // 兜底：decode 不回调时用已缓存尺寸；但绝不把「还没加载完」的图当作可切换
      setTimeout(() => finish(dims.get(src) || null), 6000);
    });
    // 竖图放在横屏（或横图放在竖屏）时：完整显示 + 两侧填充，避免上下被裁
    const applyFit = (pane, src) => {
      const d = dims.get(src);
      if (!d || !d.w || !d.h) return;
      const imgPortrait = d.h > d.w;
      const viewPortrait = window.innerHeight >= window.innerWidth;
      pane.classList.toggle('fit', imgPortrait !== viewPortrait);
    };
    fetch('/music/walls/manifest.json', { cache: 'no-cache' })
      .then((r) => r.json())
      .then((m) => {
        const items = ((m && m.items) || []).filter((x) => x && x.src && x.enabled !== false).map((x) => ({...x, src: x.src.startsWith('/walls/') ? '/music' + x.src : x.src}));
        if (!items.length) { document.documentElement.classList.add('no-wall'); return; }
        const secs = Math.max(8, Number(m.rotateSeconds) || 24);
        let front = 0;
        let idx = Math.floor(Math.random() * items.length);
        let busy = false;
        const pickNext = (cur) => {
          if (items.length <= 1) return cur;
          let n = cur;
          while (n === cur) n = Math.floor(Math.random() * items.length);
          return n;
        };
        const swap = async (i, instant) => {
          if (busy) return;
          busy = true;
          const src = items[i].src;
          const loaded = await preload(src);
          if (!loaded) { busy = false; return; } // 图没就绪就这一轮不切，避免空白/黑屏闪一下
          const back = 1 - front;
          panes[back].style.setProperty('--wall', 'url("' + src + '")');
          panes[back].dataset.src = src;
          applyFit(panes[back], src);
          void panes[back].offsetWidth;
          panes[back].classList.add('on');
          panes[front].classList.remove('on');
          front = back;
          busy = false;
          // 提前随机解码下一张，切换时零等待
          preload(items[pickNext(i)].src);
        };
        swap(idx, true);
        let rzTimer = null;
        window.addEventListener('resize', () => {
          if (rzTimer) clearTimeout(rzTimer);
          rzTimer = setTimeout(() => { panes.forEach((p) => { if (p.dataset.src) applyFit(p, p.dataset.src); }); }, 120);
        });
        window.addEventListener('orientationchange', () => {
          setTimeout(() => { panes.forEach((p) => { if (p.dataset.src) applyFit(p, p.dataset.src); }); }, 250);
        });
        if (reduce) return;
        wallTimer = setInterval(() => {
          if (document.hidden) return;
          idx = pickNext(idx);
          swap(idx, false);
        }, secs * 1000);
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && wallTimer === null) {
            wallTimer = setInterval(() => {
              if (document.hidden) return;
              idx = pickNext(idx);
              swap(idx, false);
            }, secs * 1000);
          }
        });
      })
      .catch(() => {});
  }

  function setWallEnabled(on) {
    document.documentElement.classList.toggle('no-wall', !on);
    try { localStorage.setItem('jpm.wall', on ? 'on' : 'off'); } catch (e) {}
    if (on) initWallpapers();
    else if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
  }

  function countUp(el, to, ms) {
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    to = Math.round(Number(to) || 0);
    if (reduce || typeof requestAnimationFrame !== 'function') { el.textContent = to + '%'; return; }
    const start = performance.now(); ms = ms || 420;
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - start) / ms));
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * e) + '%';
      if (k < 1) requestAnimationFrame(tick);
    };
    el.textContent = '0%';
    requestAnimationFrame(tick);
    setTimeout(() => { if (el.textContent !== to + '%') el.textContent = to + '%'; }, ms + 140);
  }

  function popEl(el) { if (!el) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  function levelRank(p) { return (p && p.level) ? p.level : 3; }
  function sortByLevel(list) { return (list || []).slice().sort((a, b) => {
    const ka = (a.kind === 'main') ? 0 : 1, kb = (b.kind === 'main') ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return levelRank(b) - levelRank(a) || ((b.count || 0) - (a.count || 0));
  }); }
  function setSelectionFromMember(m) {
    selection = new Set();
    selLevels = {};
    ((m && m.selection) || []).forEach((it) => {
      const id = typeof it === 'string' ? it : it.id;
      if (!id) return;
      selection.add(id);
      selLevels[id] = typeof it === 'object' && it.level ? it.level : 3;
    });
  }
  let matches = null;
  let matchSort = 'rare';
  let dirty = false;
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  let searchQ = '';
  let catFilterRest = '';
  let restCatOpen = {};
  let restJustOpenCat = '';
  let stateEtag = '';
  let rankExpanded = { main: false, sub: false };
  let rankJustExpanded = { main: false, sub: false };
  let selectionLimits = { main: 5, sub: 15 };
  let previewMode = false;
  function entryKind(e) {
    if (!e) return 'sub';
    return e.kind || (e.category === '领域' ? 'main' : 'sub');
  }
  function selectionCounts() {
    let main = 0, sub = 0;
    selection.forEach((id) => {
      const e = state.entries.find((x) => x.id === id);
      if (!e) return;
      if (entryKind(e) === 'main') main += 1; else sub += 1;
    });
    return { main, sub };
  }
  let prevGeom = null;
  let animRaf = null;
  let animateBubbles = false;
  let modalEntryId = null;

  // ---------- api ----------
  async function apiGet(path) {
    const r = await fetch(path, { headers: { 'Accept': 'application/json' } });
    const j = window.musicRememberContacts(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  async function apiGetState() {
    if (stateEtag) {
      const r = await fetch('/music/api/state', { headers: { 'Accept': 'application/json', 'If-None-Match': stateEtag } });
      if (r.status === 304) return null;
      const tag = r.headers.get('ETag');
      if (tag) stateEtag = tag;
      const j = window.musicRememberContacts(await r.json().catch(() => ({})));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    }
    const r = await fetch('/music/api/state', { headers: { 'Accept': 'application/json' } });
    const tag = r.headers.get('ETag');
    if (tag) stateEtag = tag;
    const j = window.musicRememberContacts(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = window.musicRememberContacts(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------- utils ----------
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 2400);
  }
  window.__toast = toast;
  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function normKey(s) {
    return String(s || '').normalize('NFKC')
      .replace(/[\u200b-\u200f\ufeff\u00ad]/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function radiusFor(count, maxCount, kind) {
    const max = Math.max(1, maxCount || 1);
    const ratio = Math.max(0, count) / max;
    if (kind === 'main') return 26 + 26 * Math.sqrt(ratio);
    return 12 + 30 * Math.sqrt(ratio);
  }
  function isNew(entry) {
    const t = entry.createdAt | 0;
    if (!(t > 0)) return false;
    const dt = new Date(t * 1000);
    const now = new Date();
    return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
  }
  function esc(s) {
    return String(s == null ? '' : s);
  }
  // ---------- 首字母（中/日/英）----------
  const KANA_ROW = [
    [0x3041, 0x304A, 'A'], [0x304B, 0x3054, 'K'], [0x3055, 0x305E, 'S'],
    [0x305F, 0x3069, 'T'], [0x306A, 0x306E, 'N'], [0x306F, 0x307D, 'H'],
    [0x307E, 0x3082, 'M'], [0x3083, 0x308A, 'Y'], [0x3089, 0x308D, 'R'],
    [0x308E, 0x3096, 'W'],
  ];
  function kanaInitial(ch) {
    let code = ch.codePointAt(0);
    if (code >= 0x30A1 && code <= 0x30FA) code -= 0x60;
    if (code === 0x30F4 || code === 0x3094) return 'B';
    for (const [a, b, letter] of KANA_ROW) {
      if (code >= a && code <= b) return letter;
    }
    return '';
  }
  function initialOf(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    const c = s[0];
    if (/^[A-Za-z]$/.test(c)) return c.toUpperCase();
    const code = c.codePointAt(0);
    if ((code >= 0x3041 && code <= 0x3096) || (code >= 0x30A1 && code <= 0x30FA)) {
      return kanaInitial(c);
    }
    if (window.PY_INITIALS && code >= window.PY_BASE &&
        code < window.PY_BASE + window.PY_INITIALS.length) {
      const letter = window.PY_INITIALS[code - window.PY_BASE];
      if (letter && letter !== ' ') return letter.toUpperCase();
    }
    return '';
  }
  function initialsOf(text) {
    let out = '';
    for (const ch of String(text || '')) out += initialOf(ch) || '';
    return out;
  }
  const PY_FULL = (typeof window !== 'undefined' && window.PY_FULL)
    ? String(window.PY_FULL).split(' ')
    : null;
  function textPinyin(text) {
    let out = '';
    for (const ch of String(text || '')) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x4e00 && cp <= 0x9fff && PY_FULL) out += PY_FULL[cp - 0x4e00] || '';
      else out += ch.toLowerCase();
    }
    return out;
  }
  function matchSearch(text, q, aliases) {
    const raw = String(q || '').trim();
    if (!raw) return true;
    const key = raw.toUpperCase();
    const low = raw.toLowerCase();
    const candidates = [String(text || '')].concat((aliases || []).map(x => String(x || '')));
    return candidates.some(t => {
      if (!t) return false;
      const first = t.trim().slice(0, 1);
      if (first && first.toUpperCase().startsWith(key)) return true;
      if (initialsOf(t).startsWith(key)) return true;
      if (t.toUpperCase().indexOf(key) >= 0) return true;
      if (PY_FULL) {
        const py = textPinyin(t);
        if (py && (py.startsWith(low) || py.indexOf(low) >= 0)) return true;
      }
      return false;
    });
  }
  function hashId(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function updateStats() {
    $('statMembers').textContent = (state.memberCount || 0) + ' 位群友';
    $('statEntries').textContent = (state.entries.length || 0) + ' 个词条';
    const recentEl = $('statRecent');
    if (recentEl) {
      const rm = state.recentMembers24h || 0, re = state.recentEntries24h || 0;
      recentEl.hidden = !(rm || re);
      recentEl.textContent = (rm || re) ? `近 24h +${re} 词条 · +${rm} 群友` : '';
      if (rm || re) popEl(recentEl);
    }
  }

  // ---------- layout ----------
  function layout(items, W, H) {
    const gap = 12;
    const pad = 10;
    const usable = Math.max(1, W - pad * 2) * Math.max(1, H - pad * 2);
    const total = items.reduce((s, it) => s + Math.PI * (it.baseR || it.r) * (it.baseR || it.r), 0);
    let scale = total > 0 ? Math.min(1, Math.sqrt((usable * 0.46) / total)) : 1;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (tryPlace(items, W, H, pad, gap, scale)) return items;
      scale *= 0.9;
    }
    tryPlace(items, W, H, pad, gap, scale);
    return items;
  }
  function tryPlace(items, W, H, pad, gap, scale) {
    const placed = [];
    const cx = W / 2, cy = H / 2;
    const maxDist = Math.max(1, Math.hypot(W / 2 - pad - 8, H / 2 - pad - 8));
    const counts = items.map(it => it.count || 0);
    const maxCount = Math.max(1, ...counts);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = Math.max(9, (it.baseR || it.r) * scale);
      const rnd = makeRng(hashId(it.id) + i * 7919 + 101);
      const spanX = Math.max(1, W - 2 * (pad + r));
      const spanY = Math.max(1, H - 2 * (pad + r));
      const weight = Math.min(1, (it.count || 0) / maxCount);
      const desired = 1 - weight;
      let best = null;
      let bestScore = -Infinity;
      const tries = 320 + i * 24;
      for (let t = 0; t < tries; t++) {
        const x = pad + r + rnd() * spanX;
        const y = pad + r + rnd() * spanY;
        let minGap = Infinity;
        let ok = true;
        for (const p of placed) {
          const d = Math.hypot(p.x - x, p.y - y) - (p.r + r) - gap;
          if (d < minGap) minGap = d;
          if (d < 0) { ok = false; break; }
        }
        if (!ok) continue;
        const cd = Math.min(1, Math.hypot(x - cx, y - cy) / maxDist);
        const bias = Math.abs(cd - desired);
        const score = -bias * 100 + Math.min(minGap, 40) * 0.4;
        if (score > bestScore) { bestScore = score; best = { x, y }; }
        if (bias < 0.02 && minGap > gap * 3) break;
      }
      if (!best) return false;
      it.x = best.x; it.y = best.y; it.r = r;
      placed.push(it);
    }
    return true;
  }
  function charW(ch) {
    return /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
  }
  function measure(s, fs) {
    let w = 0;
    for (const ch of s) w += charW(ch) * fs;
    return w;
  }
  function wrapToWidth(text, maxW, fs, maxLines) {
    const lines = [];
    let cur = '';
    let curW = 0;
    for (const ch of Array.from(text)) {
      const w = charW(ch) * fs;
      if (curW + w > maxW && cur) { lines.push(cur); cur = ''; curW = 0; }
      cur += ch;
      curW += w;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      const keep = lines.slice(0, maxLines - 1);
      let rest = lines.slice(maxLines - 1).join('');
      while (rest && measure(rest + '…', fs) > maxW) rest = rest.slice(0, -1);
      keep.push(rest + '…');
      return keep;
    }
    return lines;
  }
  function labelLines(text, r) {
    const maxW = r * 1.72;
    for (let fs = Math.max(9, Math.min(20, r * 0.33)); fs >= 10.5; fs -= 0.5) {
      const one = wrapToWidth(text, maxW, fs, 1);
      if (one.length === 1 && one[0] === text) return { lines: one, fs };
    }
    for (let fs = Math.max(9, Math.min(20, r * 0.33)); fs >= 8; fs -= 0.5) {
      const lines = wrapToWidth(text, maxW, fs, 2);
      if (lines.every(l => l.length > 1 || text.length <= 1)) return { lines, fs };
    }
    const fs = Math.max(7.5, r * 0.24);
    return { lines: wrapToWidth(text, maxW, fs, 2), fs };
  }

  // ---------- render ----------

  const pageReady = {};
  function renderAll() {
    updateStats();
    renderBoard();
    renderCreateHint();
    renderCreatedList();
    renderSelection();
    renderRank();
    if (pageReady.rest) { renderRest(); renderRestMain(); }
    if (pageReady.matches) renderMatches();
    try { if (window.__refreshNav) window.__refreshNav(); } catch (e) {}
  }

  function renderCatFilterInto(box, active, list, onPick) {
    if (!box) return;
    const counts = {};
    for (const e of list) counts[e.category || '其他'] = (counts[e.category || '其他'] || 0) + 1;
    const items = [['', '全部', list.length]].concat(
      [...new Set([...(state.categories || CATS), ...Object.keys(counts)])].filter(c => counts[c]).map(c => [c, c, counts[c]])
    );
    box.innerHTML = '';
    for (const [val, label, count] of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cat-chip' + (active === val ? ' active' : '');
      chip.textContent = label + (count ? ' ' + count : '');
      chip.addEventListener('click', () => onPick(val));
      box.appendChild(chip);
    }
  }

  const KIND_DOM = {
    main: { box: 'bubbleBoxMain', svg: 'bubbleSvgMain', hint: 'boardHintMain', title: 'boardTitleMain' },
    sub: { box: 'bubbleBoxSub', svg: 'bubbleSvgSub', hint: 'boardHintSub', title: 'boardTitleSub' }
  };
  const prevGeomByKind = { main: null, sub: null };
  const kindLabelOf = (kind) => (kind === 'main' ? '领域' : '细分');

  function renderBoard() {
    renderKindBoard('main');
    renderKindBoard('sub');
  }

  const boardView = { main: 'list', sub: 'list' };
  function applyBoardView(kind, view) {
    if (!view) view = boardView[kind] || 'list';
    boardView[kind] = view;
    const listEl = $(kind === 'main' ? 'listViewMain' : 'listViewSub');
    const bubEl = $(kind === 'main' ? 'bubbleViewMain' : 'bubbleViewSub');
    if (listEl) listEl.hidden = view !== 'list';
    if (bubEl) bubEl.hidden = view !== 'bubble';
    document.querySelectorAll(`.view-switch[data-kind="${kind}"] .vs-btn`).forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const toggle = $(kind === 'main' ? 'rankToggleMain' : 'rankToggleSub');
    if (toggle) toggle.hidden = view !== 'list';
    if (view === 'bubble') setTimeout(() => renderKindBoard(kind), 30);
    else setTimeout(() => renderRankFor(kind), 30);
  }

  function renderKindBoard(kind) {
    const dom = KIND_DOM[kind];
    const box = $(dom.box);
    const svg = $(dom.svg);
    if (!box || !svg) return;
    const list = state.entries.filter(e => entryKind(e) === kind);
    const hint = $(dom.hint);
    if (hint) hint.textContent = list.length
      ? `共 ${list.length} 条 · 点圆圈看谁选了`
      : '这个分类下还没有词条';
    if (!box.offsetWidth) {
      setTimeout(() => { if (box.offsetWidth) renderKindBoard(kind); }, 60);
      return; // 气泡视图隐藏时跳过布局，切回来再画
    }
    renderBubbleInto(kind, svg, box, list);
  }


  function renderBubbleInto(kind, svg, box, entries) {
    const W = Math.max(280, box.clientWidth || 680);
    const n = entries.length;
    const base = kind === 'main' ? W * 0.42 : W * 0.60;
    const extra = kind === 'main' ? n * 8 : n * 4;
    const cap = kind === 'main' ? 560 : 720;
    const H = Math.round(Math.min(cap, Math.max(kind === 'main' ? 280 : 360, base + extra)));
    const maxCount = Math.max(1, ...entries.map(e => e.count || 0));
    const items = entries.map(e => {
      const r = radiusFor(e.count || 0, maxCount, kind);
      const full = String(e.text || '');
      const label = full;
      return { id: e.id, text: e.text, label, count: e.count || 0, baseR: r, r, kind };
    });
    items.sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh'));
    if (items.length) layout(items, W, H);

    if (animRaf) { cancelAnimationFrame(animRaf); animRaf = null; }
    const doAnim = animateBubbles;
    animateBubbles = false;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    if (!items.length) {
      const empty = document.createElementNS(NS, 'text');
      empty.setAttribute('x', W / 2);
      empty.setAttribute('y', H / 2);
      empty.setAttribute('text-anchor', 'middle');
      empty.setAttribute('font-size', '14');
      empty.setAttribute('fill', '#8a7f86');
      empty.textContent = '还没有词条，可以在下面创建';
      svg.appendChild(empty);
      prevGeomByKind[kind] = new Map();
      return;
    }

    const nodes = [];
    for (const it of items) {
      const selected = selection.has(it.id);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'bubble-g' + (selected ? ' selected' : ''));
      g.dataset.id = it.id;

      const hit = document.createElementNS(NS, 'circle');
      hit.setAttribute('class', 'bubble-hit');
      hit.setAttribute('cx', it.x); hit.setAttribute('cy', it.y);
      hit.setAttribute('r', Math.max(it.r, 26));
      hit.setAttribute('fill', 'transparent');
      g.appendChild(hit);

      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('class', 'bubble-circle' + (it.kind === 'main' ? ' kind-main' : ''));
      circle.setAttribute('cx', it.x); circle.setAttribute('cy', it.y); circle.setAttribute('r', it.r);
      circle.setAttribute('fill', colorFor(it.id));
      circle.setAttribute('fill-opacity', '0.88');
      circle.setAttribute('stroke', selected ? '#1f2430' : 'rgba(255,255,255,.92)');
      circle.setAttribute('stroke-width', selected ? '4' : '2');
      g.appendChild(circle);

      const gloss = document.createElementNS(NS, 'circle');
      gloss.setAttribute('class', 'bubble-gloss');
      gloss.setAttribute('cx', it.x - it.r * 0.30);
      gloss.setAttribute('cy', it.y - it.r * 0.34);
      gloss.setAttribute('r', Math.max(2, it.r * 0.42));
      gloss.setAttribute('fill', 'rgba(255,255,255,.22)');
      gloss.setAttribute('pointer-events', 'none');
      g.appendChild(gloss);

      const tip = document.createElementNS(NS, 'title');
      tip.textContent = `${it.text} · ${it.count} 人选`;
      g.appendChild(tip);

      const texts = [];
      const { lines, fs } = labelLines(it.label || it.text, it.r);
      const lineH = fs * 1.18;
      const hasCount = it.r >= 26;
      const countFs = Math.max(7.5, Math.min(11, it.r * 0.18));
      const blockH = lines.length * lineH + (hasCount ? countFs * 1.5 : 0);
      let y = it.y - blockH / 2 + fs;
      for (const line of lines) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'bubble-label');
        t.setAttribute('x', it.x); t.setAttribute('y', y);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size', fs);
        t.setAttribute('font-weight', '600');
        t.setAttribute('fill', '#3d2233');
        t.textContent = line;
        g.appendChild(t);
        texts.push({ el: t, dx: 0, dy: y - it.y });
        y += lineH;
      }
      if (hasCount) {
        const c = document.createElementNS(NS, 'text');
        c.setAttribute('class', 'bubble-label');
        c.setAttribute('x', it.x); c.setAttribute('y', y + countFs * 0.7);
        c.setAttribute('text-anchor', 'middle');
        c.setAttribute('font-size', countFs);
        c.setAttribute('fill', 'rgba(61,34,51,.62)');
        c.textContent = it.count + ' 人';
        g.appendChild(c);
        texts.push({ el: c, dx: 0, dy: y + countFs * 0.7 - it.y });
      }
      svg.appendChild(g);
      nodes.push({ it, circle, hit, gloss, texts, target: { x: it.x, y: it.y, r: it.r } });
    }

    const prev = prevGeomByKind[kind];
    prevGeomByKind[kind] = new Map(items.map(it => [it.id, { x: it.x, y: it.y, r: it.r }]));
    if (!doAnim) return;
    const starts = new Map();
    for (const n of nodes) {
      const p = prev && prev.get(n.it.id);
      starts.set(n.it.id, p || { x: W / 2, y: H / 2, r: 0 });
    }
    function applyFrame(t) {
      for (const n of nodes) {
        const s = starts.get(n.it.id), tg = n.target;
        const x = s.x + (tg.x - s.x) * t;
        const y = s.y + (tg.y - s.y) * t;
        const r = Math.max(0.5, s.r + (tg.r - s.r) * t);
        n.circle.setAttribute('cx', x.toFixed(1));
        n.circle.setAttribute('cy', y.toFixed(1));
        n.circle.setAttribute('r', r.toFixed(1));
        if (n.hit) {
          n.hit.setAttribute('cx', x.toFixed(1));
          n.hit.setAttribute('cy', y.toFixed(1));
          n.hit.setAttribute('r', Math.max(r, 26).toFixed(1));
        }
        if (n.gloss) {
          n.gloss.setAttribute('cx', (x - r * 0.30).toFixed(1));
          n.gloss.setAttribute('cy', (y - r * 0.34).toFixed(1));
          n.gloss.setAttribute('r', Math.max(2, r * 0.42).toFixed(1));
        }
        for (const tx of n.texts) {
          tx.el.setAttribute('x', (x + tx.dx).toFixed(1));
          tx.el.setAttribute('y', (y + tx.dy).toFixed(1));
        }
      }
    }
    const dur = 550;
    const t0 = performance.now();
    applyFrame(0);
    function step(now) {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      applyFrame(e);
      if (t < 1) { animRaf = requestAnimationFrame(step); }
      else { animRaf = null; }
    }
    animRaf = requestAnimationFrame(step);
  }

  function renderCreateHint() {
    const roots = [...document.querySelectorAll('.create-card')];
    roots.forEach((root) => {
      const hint = root.querySelector('.create-hint');
      const kindSel = root.querySelector('.create-kind');
      const catSel = root.querySelector('.create-cat');
      const btn = root.querySelector('.create-btn');
      if (catSel) {
        const cats = (state.categories || CATS);
        if (catSel.options.length !== cats.length) {
          const cur = catSel.value;
          catSel.innerHTML = '';
          cats.forEach((c) => {
            const o = document.createElement('option');
            o.value = c;
            o.textContent = c;
            catSel.appendChild(o);
          });
          if (cur && cats.includes(cur)) catSel.value = cur;
        }
      }
      if (!member || !hint) return;
      const cm = member.createdMain || 0;
      const cs = member.createdSub || 0;
      hint.textContent = `自建名额：领域 ${cm}/${CREATE_LIMITS.main} · 细分 ${cs}/${CREATE_LIMITS.sub}`;
      const kind = (kindSel && kindSel.value) || 'sub';
      const full = kind === 'main' ? cm >= CREATE_LIMITS.main : cs >= CREATE_LIMITS.sub;
      if (btn) btn.disabled = full;
      if (catSel) catSel.disabled = kind === 'main';
    });
  }

  function renderCreatedList() {
    document.querySelectorAll('.create-card').forEach((root) => renderCreatedListInto(root));
  }

  function renderCreatedListInto(root) {
    const wrap = root.querySelector('.created-wrap');
    const box = root.querySelector('.created-list');
    if (!wrap || !box) return;
    const ids = (member && member.created) || [];
    const list = ids.map(id => state.entries.find(e => e.id === id)).filter(Boolean);
    wrap.hidden = list.length === 0;
    const sum = root.querySelector('.create-sum');
    if (sum) sum.textContent = list.length ? `已有 ${list.length} 个` : '';
    box.innerHTML = '';

    const makeItem = (e) => {
      const row = document.createElement('div');
      row.className = 'created-item';
      const name = document.createElement('span');
      name.className = 'created-name';
      name.textContent = e.text;
      const cat = document.createElement('span');
      cat.className = 'cat-tag';
      cat.textContent = entryKind(e) === 'main' ? '领域' : (e.category || '其他');
      const edit = document.createElement('button');
      edit.className = 'link small';
      edit.type = 'button';
      edit.textContent = '改';
      edit.onclick = () => startEdit(e.id, row);
      const del = document.createElement('button');
      del.className = 'danger small';
      del.type = 'button';
      del.textContent = '删';
      del.onclick = () => deleteEntry(e.id);
      row.append(name, cat, edit, del);
      return row;
    };

    const groups = [
      ['领域', list.filter(e => entryKind(e) === 'main')],
      ['细分', list.filter(e => entryKind(e) !== 'main')],
    ];
    for (const [title, items] of groups) {
      const g = document.createElement('div');
      g.className = 'created-group';
      const head = document.createElement('div');
      head.className = 'created-group-head';
      head.textContent = `${title} ${items.length}`;
      g.appendChild(head);
      if (!items.length) {
        const empty = document.createElement('span');
        empty.className = 'muted tiny';
        empty.textContent = '还没创建';
        g.appendChild(empty);
      }
      items.forEach(e => g.appendChild(makeItem(e)));
      box.appendChild(g);
    }
  }

  function startEdit(entryId, row) {
    const entry = state.entries.find(x => x.id === entryId);
    if (!entry) return;
    const currentCat = entry.category || '其他';
    row.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'edit-input';
    input.maxLength = 24;
    input.value = entry.text;
    const sel = document.createElement('select');
    sel.className = 'cat-select';
    const cats = (state.categories || CATS).slice();
    if (!cats.includes(currentCat)) cats.push(currentCat);
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      if (c === currentCat) o.selected = true;
      sel.appendChild(o);
    }
    const save = document.createElement('button');
    save.className = 'primary small';
    save.type = 'button';
    save.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.className = 'link small';
    cancel.type = 'button';
    cancel.textContent = '取消';
    row.append(input, sel, save, cancel);
    const done = () => renderCreatedList();
    save.onclick = async () => {
      const text = input.value.trim();
      if (!text) { toast('词条不能为空'); return; }
      save.disabled = true;
      try {
        const r = await apiPost('/music/api/entry/update', { qq: identity.qq, entryId, text, category: sel.value });
        member = r.member;
        if (r.entries) state.entries = r.entries; else state = await apiGet('/music/api/state');
        dirty = true;
        renderAll();
        toast('词条已修改');
      } catch (err) {
        toast(err.message || '修改失败');
        save.disabled = false;
      }
    };
    cancel.onclick = done;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save.click(); }
      if (e.key === 'Escape') done();
    });
    input.focus();
    input.select();
  }

  async function deleteEntry(entryId) {
    const entry = state.entries.find(x => x.id === entryId);
    if (!entry) return;
    if (!confirm(`确定删掉「${entry.text}」吗？\n（已经有人选了的词条不能删）`)) return;
    try {
      const r = await apiPost('/music/api/entry/delete', { qq: identity.qq, entryId });
      member = r.member;
      state.entries = r.entries;
      if (selection.has(entryId)) selection.delete(entryId);
      renderAll();
      toast('已删除');
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  let selPrev = null;
  let selOrder = null; // 已选顺序缓存：只有「保存并匹配」后才重新排序
  let selCat = '全部'; // 「你选的词条」细分的分类筛选
  function renderSelection() {
    const box = $('selChips');
    box.innerHTML = '';
    const c = selectionCounts();
    $('selCount').textContent = `领域 ${c.main}/${selectionLimits.main} · 细分 ${c.sub}/${selectionLimits.sub}`;
    popEl($('selCount'));
    const LEVEL_OPTS = [4, 3, 2, 1];
    const rowOf = (e) => {
      const kind = entryKind(e);
      const row = document.createElement('div');
      row.className = 'sel-row' + (kind === 'main' ? ' kind-main' : '') + (selPrev && !selPrev.has(e.id) ? ' row-new' : '');
      row.dataset.id = e.id;
      const nameEl = document.createElement('span');
      nameEl.className = 'sel-row-name';
      nameEl.textContent = e.text;
      row.appendChild(nameEl);
      if (kind !== 'main') {
        const seg = document.createElement('div');
        seg.className = 'sel-seg';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', e.text + '的熟悉程度');
        const cur = selLevel(e.id);
        LEVEL_OPTS.forEach((lv) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sel-seg-btn lv' + lv + (cur === lv ? ' on' : '');
          b.textContent = levelLabel(lv);
          b.title = '设为' + levelLabel(lv);
          b.setAttribute('aria-pressed', String(cur === lv));
          b.addEventListener('click', (ev) => { ev.stopPropagation(); applyLevel(e.id, lv); });
          seg.appendChild(b);
        });
        row.appendChild(seg);
      }
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = (e.count || 0) + ' 人';
      row.appendChild(cnt);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = '移除这个词条';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selection.delete(e.id);
        if (selOrder) selOrder = selOrder.filter(x => x !== e.id);
        dirty = true;
        renderBoard(); renderSelection(); renderRank();
      });
      row.appendChild(x);
      return row;
    };
    const group = (title, list, used, max) => {
      const g = document.createElement('div');
      g.className = 'sel-group';
      const h = document.createElement('div');
      h.className = 'sel-group-head';
      const t = document.createElement('span');
      t.textContent = title;
      const n = document.createElement('span');
      n.className = 'muted tiny';
      n.textContent = used + ' / ' + max;
      h.append(t, n);
      g.appendChild(h);
      if (!list.length) {
        const s = document.createElement('span');
        s.className = 'muted tiny sel-empty';
        s.textContent = '还没选，去「发现」挑选喜欢的词条 →';
        g.appendChild(s);
      }
      const grouped = title === '细分';
      if (!grouped) {
        list.forEach(e => g.appendChild(rowOf(e)));
      } else {
        const catOrder = (state.categories || CATS).slice();
        list.forEach(e => { const cc = e.category || '其他'; if (catOrder.indexOf(cc) < 0) catOrder.push(cc); });
        const present = catOrder.filter(cat => list.some(e => (e.category || '其他') === cat));
        const bar = document.createElement('div');
        bar.className = 'sel-cats';
        const mkBtn = (label, value, n) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sel-cat-btn' + (selCat === value ? ' on' : '');
          b.textContent = label + ' ' + n;
          b.addEventListener('click', (ev) => { ev.stopPropagation(); selCat = value; renderSelection(); });
          return b;
        };
        bar.appendChild(mkBtn('全部', '全部', list.length));
        present.forEach(cat => bar.appendChild(mkBtn(cat, cat, list.filter(e => (e.category || '其他') === cat).length)));
        g.appendChild(bar);
        if (selCat === '全部') {
          catOrder.forEach((cat) => {
            const items = list.filter(e => (e.category || '其他') === cat);
            if (!items.length) return;
            const ch = document.createElement('div');
            ch.className = 'sel-cat';
            ch.textContent = cat + ' · ' + items.length;
            g.appendChild(ch);
            items.forEach(e => g.appendChild(rowOf(e)));
          });
        } else {
          const items = list.filter(e => (e.category || '其他') === selCat);
          if (!items.length) {
            const s2 = document.createElement('span');
            s2.className = 'muted tiny sel-empty';
            s2.textContent = '这个分类下还没选词条，去上方榜单里点一个 →';
            g.appendChild(s2);
          }
          items.forEach(e => g.appendChild(rowOf(e)));
        }
      }
      box.appendChild(g);
    };
    // 排序：熟悉程度优先（本命→只听过几首），其次按已选人数降序，最后按名称
    const sortSel = (x, y) =>
      (selLevel(y.id) - selLevel(x.id)) ||
      ((y.count || 0) - (x.count || 0)) ||
      x.text.localeCompare(y.text, 'zh');
    const chosenAll = [...selection].map(id => state.entries.find(x => x.id === id)).filter(Boolean);
    if (!selOrder) selOrder = chosenAll.slice().sort(sortSel).map(e => e.id);
    selOrder = selOrder.filter(id => selection.has(id));
    chosenAll.forEach(e => { if (selOrder.indexOf(e.id) < 0) selOrder.push(e.id); });
    const byId = new Map(chosenAll.map(e => [e.id, e]));
    const chosen = selOrder.map(id => byId.get(id)).filter(Boolean);
    group('领域', chosen.filter(e => entryKind(e) === 'main'), c.main, selectionLimits.main);
    const chosenSub = chosen.filter(e => entryKind(e) !== 'main');
    if (selCat !== '全部' && !chosenSub.some(e => (e.category || '其他') === selCat)) selCat = '全部';
    group('细分', chosenSub, c.sub, selectionLimits.sub);
    selPrev = new Set(selection.keys());
    $('saveBtn').disabled = selection.size === 0;
    const mb = $('mobCount'), ms = $('mobSave');
    if (mb) mb.textContent = `领域 ${c.main}/${selectionLimits.main} · 细分 ${c.sub}/${selectionLimits.sub}`;
    if (ms) ms.disabled = selection.size === 0;
    const se = $('selEmpty');
    if (se) se.hidden = selection.size > 0;
    updateSaveState();
    updateMobBar();
  }

  function renderRank() {
    renderRankFor('main');
    renderRankFor('sub');
  }

  function collapseRank(kind) {
    const listEl = $(kind === 'main' ? 'rankListMain' : 'rankListSub');
    const toggle = $(kind === 'main' ? 'rankToggleMain' : 'rankToggleSub');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const LIMIT = RANK_COLLAPSED[kind] || 10;
    if (!listEl) { rankExpanded[kind] = false; return; }
    const extra = [...listEl.querySelectorAll('.rank-row')].filter(r => +(r.dataset.rank || 0) > LIMIT);
    const finish = () => {
      extra.forEach((r) => r.remove());
      rankExpanded[kind] = false;
      const total = +(listEl.dataset.total || 0);
      const headText = total <= LIMIT ? `共 ${total} 条` : `前 ${LIMIT} 名`;
      const counts = selectionCounts();
      const used = kind === 'main' ? counts.main : counts.sub;
      const kindTotal = state.entries.filter(e => entryKind(e) === kind).length;
      const suffix = previewMode ? '' : ` · 已选 ${used} / ${kindTotal}`;
      const hintEl = $(kind === 'main' ? 'rankHintMain' : 'rankHintSub');
      const boardHintEl = $(kind === 'main' ? 'boardHintMain' : 'boardHintSub');
      if (hintEl) hintEl.textContent = headText + suffix;
      if (boardHintEl) boardHintEl.textContent = headText + suffix;
      if (toggle) {
        toggle.textContent = '';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', '展开');
      }
    };
    if (reduce || !extra.length) { finish(); return; }
    extra.slice(12).forEach((r) => r.remove());
    extra.slice(0, 12).forEach((row, i) => {
      row.classList.add('row-leave');
      row.style.setProperty('--rd', Math.min(i, 12) * 10 + 'ms');
    });
    setTimeout(finish, 240);
  }

  function restGroupRows(cat) {
    const all = state.entries.filter(e => entryKind(e) === 'sub')
      .sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh') || a.id.localeCompare(b.id));
    const rest = all;
    return rest.filter(e => (e.category || '其他') === cat).sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh'));
  }

  function restMaxCount() {
    const subs = state.entries.filter(e => entryKind(e) === 'sub');
    return Math.max(1, ...subs.map(e => e.count || 0));
  }

  function expandRestCat(cat, head) {
    const box = $('rankListRest');
    if (!box || !head) return;
    const all = restGroupRows(cat);
    const shown = new Set([...box.querySelectorAll('.rank-row')]
      .filter(r => r.dataset.cat === cat).map(r => r.dataset.id));
    const rows = all.slice(5).filter(e => !shown.has(e.id));
    const maxCount = restMaxCount();
    const anchor = [...box.querySelectorAll('.rank-row')].filter(r => r.dataset.cat === cat).pop() || head;
    const frag = document.createDocumentFragment();
    rows.forEach((e, i) => {
      const row = rankRow(e, maxCount, null, true);
      row.dataset.cat = cat;
      row.classList.add('row-enter');
      row.style.setProperty('--rd', Math.min(i, 24) * 18 + 'ms');
      frag.appendChild(row);
    });
    anchor.parentNode.insertBefore(frag, anchor.nextSibling);
    restCatOpen[cat] = true;
    head.classList.add('open');
    head.setAttribute('aria-expanded', 'true');
    head.dataset.open = 'true';
  }

  function toggleRestCat(cat, btn) {
    const box = $('rankListRest');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!box) return;
    const head = (btn && btn.classList && btn.classList.contains('rest-cat-head'))
      ? btn : box.querySelector(`.rest-cat-head[data-cat="${cat}"]`);
    const own = [...box.querySelectorAll('.rank-row')].filter(r => r.dataset.cat === cat);
    const extra = own.slice(5);
    if (!extra.length) return;
    const beforeTop = head ? head.getBoundingClientRect().top : 0;
    const finish = () => {
      extra.forEach((r) => r.remove());
      restCatOpen[cat] = false;
      if (head) {
        head.classList.remove('open');
        head.setAttribute('aria-expanded', 'false');
        head.dataset.open = 'false';
        window.scrollBy(0, head.getBoundingClientRect().top - beforeTop);
      }
    };
    if (reduce) { finish(); return; }
    extra.slice(12).forEach((r) => r.remove());
    extra.slice(0, 12).forEach((row, i) => {
      row.classList.add('row-leave');
      row.style.setProperty('--rd', Math.min(i, 12) * 10 + 'ms');
    });
    setTimeout(finish, 240);
  }

  function renderRest() {
    const card = $('restCard');
    if (!card) return;
    const all = state.entries.filter(e => entryKind(e) === 'sub')
      .sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh') || a.id.localeCompare(b.id));
    const q = (searchQ || '').trim();
    const rest = q ? all.filter(e => matchSearch(e.text, q, e.aliases)) : all;
    const hint = $('restHint');
    const sh = $('searchHint');
    if (sh) sh.textContent = q ? `匹配 ${rest.length} / ${all.length}` : '';
    if (!rest.length) {
      card.hidden = false;
      if (hint) hint.textContent = q ? `没有匹配「${q}」的词条` : '';
      if ($('catFilterRest')) $('catFilterRest').innerHTML = '';
      const box0 = $('rankListRest');
      if (box0) box0.innerHTML = '<span class="muted tiny">没有匹配的词条</span>';
      return;
    }
    card.hidden = false;
    const catsAll = (state.categories || CATS).filter(c => rest.some(e => (e.category || '其他') === c));
    if (hint) hint.textContent = q
      ? `共 ${rest.length} 条匹配「${q}」 · 按分类分组`
      : `共 ${rest.length} 条 · ${catsAll.length} 个分类`;
    if (catFilterRest && !rest.some(e => (e.category || '其他') === catFilterRest)) catFilterRest = '';
    renderCatFilterInto($('catFilterRest'), catFilterRest, rest, (val) => { catFilterRest = val; renderRest(); });
    const box = $('rankListRest');
    if (!box) return;
    box.innerHTML = '';
    const filtered = catFilterRest ? rest.filter(e => (e.category || '其他') === catFilterRest) : rest;
    if (!filtered.length) {
      const s = document.createElement('span');
      s.className = 'muted tiny';
      s.textContent = '这个分类下没有词条';
      box.appendChild(s);
      return;
    }
    const maxCount = Math.max(1, ...rest.map(e => e.count || 0));
    const order = state.categories || CATS;
    const groups = {};
    filtered.forEach((e) => { const c = e.category || '其他'; (groups[c] = groups[c] || []).push(e); });
    const cats = Object.keys(groups).sort((x, y) => order.indexOf(x) - order.indexOf(y));
    const animIds = (restJustOpenCat && restCatOpen[restJustOpenCat])
      ? new Set(restGroupRows(restJustOpenCat).slice(5).map(e => e.id))
      : null;
    restJustOpenCat = '';
    cats.forEach((c) => {
      const small = groups[c].length <= 5;
      const open = small ? true : (!!restCatOpen[c] || !!q);
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'rest-cat-head' + (open ? ' open' : '');
      head.dataset.cat = c;
      const headName = document.createElement('span');
      headName.className = 'rest-cat-name';
      headName.textContent = c;
      const side = document.createElement('span');
      side.className = 'rest-cat-side';
      const picked = groups[c].filter((e) => selection.has(e.id)).length;
      if (picked) {
        const pk = document.createElement('span');
        pk.className = 'rest-cat-picked';
        pk.textContent = '已选 ' + picked;
        side.appendChild(pk);
      }
      const headCount = document.createElement('span');
      headCount.className = 'rest-cat-count';
      headCount.textContent = groups[c].length + ' 条';
      side.appendChild(headCount);
      if (!small) {
        const chev = document.createElement('span');
        chev.className = 'rest-cat-chev';
        chev.setAttribute('aria-hidden', 'true');
        side.appendChild(chev);
      }
      head.append(headName, side);
      head.setAttribute('aria-expanded', open ? 'true' : 'false'); head.dataset.open = open ? 'true' : 'false';
      if (q || small) {
        head.disabled = true;
        head.classList.add('inert');
      } else {
        head.addEventListener('click', () => {
          if (restCatOpen[c]) { toggleRestCat(c, head); }
          else { expandRestCat(c, head); }
        });
      }
      const groupEl = document.createElement('div');
      groupEl.className = 'rest-group';
      groupEl.appendChild(head);
      const rows = small
        ? groups[c]
        : ((open || q) ? groups[c] : groups[c].slice(0, 5));
      rows.forEach((e) => {
        const row = rankRow(e, maxCount, null, true);
        row.dataset.cat = c;
        groupEl.appendChild(row);
      });
      box.appendChild(groupEl);
    });
    if (animIds) {
      [...box.querySelectorAll('.rank-row')].forEach((row, i) => {
        if (!animIds.has(row.dataset.id)) return;
        row.classList.add('row-enter');
        row.style.setProperty('--rd', Math.min(i, 24) * 18 + 'ms');
      });
    }
  }

  function renderRestMain() {
    const card = $('restMainCard');
    if (!card) return;
    const all = state.entries.filter(e => entryKind(e) === 'main' && (!searchQ.trim() || matchSearch(e.text, searchQ.trim(), e.aliases)))
      .sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh') || a.id.localeCompare(b.id));
    card.hidden = false;
    const hint = $('restMainHint');
    if (hint) hint.textContent = `共 ${all.length} 个领域`;
    const box = $('rankListRestMain');
    if (!box) return;
    box.innerHTML = '';
    if (!all.length) {
      const s = document.createElement('span');
      s.className = 'muted tiny';
      s.textContent = searchQ.trim() ? '没有匹配的领域' : '还没有领域词条';
      box.appendChild(s);
      return;
    }
    const maxCount = Math.max(1, ...all.map(e => e.count || 0));
    const rankOf = new Map(all.map((e, i) => [e.id, i + 1]));
    all.forEach((e) => box.appendChild(rankRow(e, maxCount, rankOf, false)));
  }

  function renderRankFor(kind) {
    const ids = kind === 'main'
      ? { list: 'rankListMain', hint: 'rankHintMain', toggle: 'rankToggleMain' }
      : { list: 'rankListSub', hint: 'rankHintSub', toggle: 'rankToggleSub' };
    const box = $(ids.list);
    if (!box) return;
    const hint = $(ids.hint);
    const toggle = $(ids.toggle);
    box.innerHTML = '';
    let list = state.entries.filter(e => entryKind(e) === kind);

    list.sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'zh') || a.id.localeCompare(b.id));
    const LIMIT = RANK_COLLAPSED[kind] || 10;
    const counts = selectionCounts();
    const used = kind === 'main' ? counts.main : counts.sub;
    const kindTotal = state.entries.filter(e => entryKind(e) === kind).length;
    const subCap = Math.min(list.length, SUB_EXPAND_CAP);
    const headText = kind === 'sub'
      ? (list.length <= LIMIT ? `共 ${list.length} 条`
        : (rankExpanded.sub ? (list.length > subCap ? `前 ${subCap} 名` : `共 ${list.length} 条`) : `前 ${LIMIT} 名`))
      : (list.length > LIMIT ? `前 ${LIMIT} 名` : `共 ${list.length} 条`);
    if (hint) hint.textContent = headText + (previewMode ? '' : ` · 已选 ${used} / ${kindTotal}`);
    const boardHint = kind === 'main' ? $('boardHintMain') : $('boardHintSub');
    if (boardHint) boardHint.textContent = headText + (previewMode ? '' : ` · 已选 ${used} / ${kindTotal}`);
    if (!list.length) {
      const s = document.createElement('span');
      s.className = 'muted tiny';
      s.textContent = '还没有词条';
      box.appendChild(s);
      if (toggle) toggle.hidden = true;
      return;
    }
    box.dataset.total = String(list.length);
    const maxCount = Math.max(1, ...list.map(e => e.count || 0));
    const expanded = !!rankExpanded[kind];
    const cap = kind === 'sub' ? subCap : list.length;
    const local = new Map(list.map((e, i) => [e.id, i + 1]));
    const start = 0;
    const rows = expanded ? list.slice(start, cap) : list.slice(start, LIMIT);
    rows.forEach(e => box.appendChild(rankRow(e, maxCount, local)));
    if (expanded && rankJustExpanded[kind]) {
      const extras = [...box.querySelectorAll('.rank-row')].filter(r => +(r.dataset.rank || 0) > LIMIT);
      extras.forEach((row, i) => {
        row.classList.add('row-enter');
        row.style.setProperty('--rd', Math.min(i, 24) * 18 + 'ms');
      });
      rankJustExpanded[kind] = false;
    }
    if (kind === 'sub' && list.length > SUB_EXPAND_CAP) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'rank-more-link';
      more.textContent = `还有 ${list.length - SUB_EXPAND_CAP} 条 · 去「全部词条」查看 →`;
      more.addEventListener('click', () => window.__showPage('rest'));
      box.appendChild(more);
    }
    if (toggle) {
      toggle.hidden = list.length <= LIMIT;
      toggle.textContent = '';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', expanded ? '收起' : '展开');
    }
  }

  function rankRow(e, maxCount, rankOf, noRank) {
    const row = document.createElement('div');
    const rk = (rankOf && !noRank) ? +(rankOf.get(e.id) || 0) : 0;
    row.dataset.rank = String(rk);
    row.className = 'rank-row' + (selection.has(e.id) ? ' selected' : '') + (entryKind(e) === 'main' ? ' kind-main' : '') + (!noRank && rk > 0 && rk <= 3 ? ' top' + rk : '') + (noRank ? ' no-rank' : '');
    row.dataset.id = e.id;
    const no = document.createElement('span');
    no.className = 'rank-no';
    no.textContent = noRank ? '' : String((rankOf && rankOf.get(e.id)) || '');
    const name = document.createElement('span');
    name.className = 'rank-name';
    name.textContent = e.text;
    if (isNew(e)) {
      const nb = document.createElement('span');
      nb.className = 'mini-tag';
      nb.textContent = '新';
      name.appendChild(nb);
    }
    if (selection.has(e.id) && entryKind(e) !== 'main') {
      const lv = selLevel(e.id);
      const lvb = document.createElement('span');
      lvb.className = 'lv-mini lv' + lv + ' lv-rank';
      lvb.textContent = LEVEL_LABELS[lv] || '';
      name.appendChild(lvb);
    }
    const isMain = entryKind(e) === 'main';
    const cat = document.createElement('span');
    cat.className = 'cat-tag' + (isMain ? ' empty' : '');
    cat.textContent = isMain ? '' : (e.category || '其他');
    const bar = document.createElement('span');
    bar.className = 'rank-bar';
    const fill = document.createElement('i');
    fill.style.width = Math.round(((e.count || 0) / maxCount) * 100) + '%';
    bar.appendChild(fill);
    const cnt = document.createElement('span');
    cnt.className = 'rank-count';
    cnt.textContent = (e.count || 0) + ' 人';
    const check = document.createElement('span');
    check.className = 'rank-check';
    check.textContent = selection.has(e.id) ? '✓' : '';
    row.append(no, name, cat, bar, cnt, check);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', String(selection.has(e.id)));
    row.setAttribute('aria-label', e.text + (selection.has(e.id) ? '，已选' : '，选择词条'));
    row.addEventListener('click', () => toggleEntry(e.id));
    row.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleEntry(e.id); }
    });
    return row;
  }

  let matchesLowOpen = false;
  let otherOnlyOpen = false;
  function avatarStyle(name) {
    const str = String(name || '?');
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `background:linear-gradient(135deg,hsl(${h},72%,93%),hsl(${(h + 40) % 360},70%,86%));color:hsl(${h},45%,40%)`;
  }

  function kindGrouped(wrap, list, makeChip, opts) {
    const caption = !!(opts && opts.caption);
    const main = list.filter(x => (x.kind || 'sub') === 'main');
    const sub = list.filter(x => (x.kind || 'sub') !== 'main');
    const rows = [];
    if (main.length) rows.push(['领域', 'main', main]);
    if (sub.length) rows.push(['细分', 'sub', sub]);
    rows.forEach(([label, cls, items]) => {
      const row = document.createElement('div');
      row.className = 'kind-row';
      if (caption) {
        const block = document.createElement('div');
        block.className = 'kind-block';
        const cap = document.createElement('span');
        cap.className = 'kind-cap ' + cls;
        cap.textContent = label;
        block.appendChild(cap);
        block.appendChild(row);
        items.forEach(t => row.appendChild(makeChip(t)));
        wrap.appendChild(block);
        return;
      }
      const tag = document.createElement('span');
      tag.className = 'kind-tag ' + cls;
      tag.textContent = label;
      row.appendChild(tag);
      items.forEach(t => row.appendChild(makeChip(t)));
      wrap.appendChild(row);
    });
  }

  function renderMatches(opts = {}) {
    const card = $('matchesCard');
    if (!matches || !Array.isArray(matches.matches)) { card.hidden = true; return; }
    card.hidden = false;
    const list = matches.matches;
    const sparseList = matches.sparseMatches || [];
    const first = list.slice(0, 3);
    const rest = list.slice(3);
    const lowLabels = ['同圈可聊', '只碰上一首', '没有重合'];
    const highCount = list.filter(m => !lowLabels.includes(m.label || '')).length;
    $('matchesHint').textContent = (!list.length
      ? '还没有和你重合的群友——等大家多选几个词条再来看看。'
      : (highCount
        ? `共 ${list.length} 位群友和你重合：${highCount} 位值得先聊，${list.length - highCount} 位交集较少（前 ${first.length} 位已展开）。`
        : `共 ${list.length} 位群友和你重合：暂无高度重合，${list.length} 位交集较少（前 ${first.length} 位已展开）。`))
      + ' 匹配度为校准分（100×√严格重合率，按共同项设上限）；排序：' + (matchSort === 'familiar' ? '熟悉度优先（共同本命 → 常听 → 其余）' : '稀有度优先（共同项越冷门越靠前）') + '。'
      + (sparseList.length ? ` 另有 ${sparseList.length} 位资料较少的群友，列在下方。` : '');
    let emptyBox = card.querySelector('.matches-empty');
    if (!list.length && !sparseList.length) {
      if (!emptyBox) {
        emptyBox = document.createElement('div');
        emptyBox.className = 'matches-empty';
        card.appendChild(emptyBox);
      }
      const hasSel = !!(member && (member.selection || []).length);
      emptyBox.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'muted tiny';
      p.textContent = hasSel
        ? '还没有和你重合的群友——等大家多选几个词条再来看看。'
        : '你还没有选过词条，先选几个才能匹配同好。';
      emptyBox.appendChild(p);
      if (!hasSel) {
        const b = document.createElement('button');
        b.className = 'primary';
        b.type = 'button';
        b.textContent = '去选词条';
        b.onclick = () => { if (window.__showPage) window.__showPage('mine', { anim: true, top: true }); };
        emptyBox.appendChild(b);
      }
    } else if (emptyBox) {
      emptyBox.remove();
    }

    const ol = $('matchesList');
    ol.innerHTML = '';
    const oldLow = $('matchesLow');
    if (oldLow) oldLow.remove();
    const oldFold = $('lowToggleRow');
    if (oldFold) oldFold.remove();
    const oldSparse = card.querySelector('.sparse-block');
    if (oldSparse) oldSparse.remove();

    const addItem = (parent, m, idx) => {
      const li = document.createElement('li');
      if (idx < 3) li.classList.add('m-top' + (idx + 1));
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = String(m.name || '?').slice(0, 1);
      if (idx >= 3) av.style.cssText = avatarStyle(m.name);
      li.appendChild(av);
      const rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = String(idx + 1);
      const main = document.createElement('div');
      main.className = 'match-main';
      const name = document.createElement('div');
      name.className = 'match-name';
      name.textContent = m.name;
      if (m.gender) {
        const gt = document.createElement('span');
        gt.className = 'gender-tag ' + m.gender;
        gt.textContent = m.gender === 'female' ? '女' : '男';
        gt.title = 'TA 公开的性别';
        name.appendChild(gt);
      }
      const qq = document.createElement('span');
      qq.className = 'qq';
      qq.textContent = memberLabel(m.qq);
      name.appendChild(qq);
      if (m.nicheShared) {
        const nb = document.createElement('span');
        nb.className = 'niche-badge';
        nb.title = `你们共同选了 ${m.nicheShared} 个冷门词条（全群 ≤2 人选）`;
        nb.textContent = '冷门同好 ' + m.nicheShared;
        name.appendChild(nb);
      }
      main.appendChild(name);
      const shared = sortByLevel((m.shared || []).map(x => (typeof x === 'string' ? { text: x } : x)));
      const otherOnly = sortByLevel((m.otherOnly || []).map(x => (typeof x === 'string' ? { text: x } : x)));
      if (m.mineCovered || m.theirsCovered) {
        const cov = document.createElement('div');
        cov.className = 'match-note';
        if (m.mineCovered && m.theirsCovered) {
          cov.textContent = '你们的词条完全一样';
        } else if (m.mineCovered) {
          cov.textContent = `包含关系：TA 覆盖了你选的全部 ${shared.length} 项`;
        } else {
          cov.textContent = `包含关系：你选了 TA 的全部 ${shared.length} 项`;
        }
        main.appendChild(cov);
      }
      if (m.lowData) {
        const note = document.createElement('div');
        note.className = 'match-note low-data';
        note.textContent = `已填词条重合，但资料较少（你 ${m.mineCount || '?'} 项 / TA ${m.theirsCount || '?'} 项），可以先从共同词条聊起`;
        main.appendChild(note);
      }
      if (shared.length) {
        const sh = document.createElement('div');
        sh.className = 'match-shared';
        kindGrouped(sh, shared, t => {
          const s = document.createElement('span');
          s.textContent = t.text;
          {
            const my = (typeof t.myLevel === 'number') ? t.myLevel : (t.kind === 'sub' ? t.level : 0);
            const th = (typeof t.theirLevel === 'number') ? t.theirLevel : (t.kind === 'sub' ? t.level : 0);
            const base = my || th || 3;
            if (my || th) {
              const txt = (my && th && my !== th)
                ? ('我' + levelLabel(my) + ' / TA ' + levelLabel(th))
                : levelLabel(base);
              const lv = document.createElement('i');
              lv.className = 'lv-mini lv' + base;
              lv.textContent = txt;
              s.appendChild(lv);
            }
          }
          if (t.id) {
            s.className = 'clickable';
            s.title = selection.has(t.id) ? '点一下移出我的选择' : '点一下加进我的选择';
            s.addEventListener('click', () => toggleEntry(t.id));
          }
          return s;
        }, { caption: true });
        main.appendChild(sh);
      }
      if (otherOnly.length) {
        const sh2 = document.createElement('div');
        sh2.className = 'match-shared other-block';
        const lab = document.createElement('span');
        lab.className = 'split-label split-head';
        lab.textContent = 'TA 独有';
        const cnt = document.createElement('span');
        cnt.className = 'other-count';
        cnt.textContent = otherOnly.length + ' 个';
        const tgl = document.createElement('button');
        tgl.type = 'button';
        tgl.className = 'mini-toggle';
        tgl.setAttribute('aria-expanded', otherOnlyOpen ? 'true' : 'false');
        tgl.textContent = otherOnlyOpen ? '收起' : '展开';
        lab.append(cnt, tgl);
        sh2.appendChild(lab);
        const sh2k = document.createElement('div');
        sh2k.className = 'kind-rows';
        sh2k.hidden = !otherOnlyOpen;
        kindGrouped(sh2k, otherOnly, t => {
          const s = document.createElement('span');
          s.className = 'other';
          s.textContent = (t && t.text) ? t.text : String(t || '');
          if (t) {
            const th = (typeof t.theirLevel === 'number') ? t.theirLevel : t.level;
            if (th) {
              const lv = document.createElement('i');
              lv.className = 'lv-mini lv' + th;
              lv.textContent = 'TA ' + levelLabel(th);
              s.appendChild(lv);
            }
          }
          if (t.id) {
            s.className = 'other clickable';
            s.title = '点一下加进我的选择';
            s.addEventListener('click', () => toggleEntry(t.id));
          }
          return s;
        }, { caption: true });
        tgl.addEventListener('click', () => {
          otherOnlyOpen = !otherOnlyOpen;
          tgl.textContent = otherOnlyOpen ? '收起' : '展开';
          tgl.setAttribute('aria-expanded', otherOnlyOpen ? 'true' : 'false');
          sh2k.hidden = !otherOnlyOpen;
        });
        sh2.appendChild(sh2k);
        main.appendChild(sh2);
      }
      if (m.note) {
        const nq = document.createElement('div');
        nq.className = 'note-quote match-note-quote';
        nq.textContent = 'TA 的留言：' + m.note;
        main.appendChild(nq);
      }
      const acts = document.createElement('div');
      acts.className = 'match-actions';
      const bName = document.createElement('button');
      bName.type = 'button';
      bName.className = 'copy-btn';
      bName.textContent = '复制名称';
      bName.addEventListener('click', () => copyText(m.name, '名称'));
      const bQq = document.createElement('button');
      bQq.type = 'button';
      bQq.className = 'copy-btn';
      bQq.textContent = '复制' + memberKind(m.qq);
      bQq.addEventListener('click', () => copyText(window.musicMemberValue(m.qq), memberKind(m.qq)));
      const bView = document.createElement('button');
      bView.type = 'button';
      bView.className = 'copy-btn';
      bView.textContent = '看 TA 的词条';
      bView.addEventListener('click', () => openMemberModal(m));
      acts.append(bName, bQq, bView);
      main.appendChild(acts);
      const score = document.createElement('div');
      score.className = 'match-score';
      const bits = [];
      if (m.sharedDomain) bits.push('领域 ' + m.sharedDomain);
      if (m.sharedSub) bits.push('细分 ' + m.sharedSub);
      const labelText = m.label || '';
      const rawPct = (typeof m.similarity === 'number') ? m.similarity : 0;
      const shownPct = (typeof m.matchPercent === 'number') ? m.matchPercent : rawPct;
      score.innerHTML = `<span class="sim-badge" title="校准匹配度（100×√严格重合率，按共同项设上限）">${labelText ? labelText + ' ' : ''}${shownPct}%</span>` +
        `<span class="match-ratio">严格重合 ${rawPct}%</span>` +
        (m.bothTop ? `<span class="both-top">同为${levelLabel(4)} ${m.bothTop}</span>` : '') +
        `共同 ${m.sharedCount || m.overlap || 0} 个` + (bits.length ? `（${bits.join(' / ')}）` : '');
      li.append(rank, main, score);
      parent.appendChild(li);
    };

    first.forEach((m, i) => addItem(ol, m, i));
    if (!renderMatches._animated && first.length && !opts.instant) {
      renderMatches._animated = true;
      ol.classList.add('matches-in');
      setTimeout(() => ol.classList.remove('matches-in'), 1000);
    }

    if (rest.length) {
      const lowOl = document.createElement('ol');
      lowOl.className = 'matches-list matches-low';
      lowOl.id = 'matchesLow';
      lowOl.hidden = !matchesLowOpen;
      rest.forEach((m, i) => addItem(lowOl, m, first.length + i));
      const foldLi = document.createElement('li');
      foldLi.className = 'fold-row';
      foldLi.id = 'lowToggleRow';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fold-btn';
      btn.textContent = matchesLowOpen
        ? `收起其余群友（${rest.length} 位）`
        : `展开其余群友（${rest.length} 位）`;
      btn.addEventListener('click', () => { matchesLowOpen = !matchesLowOpen; renderMatches(); });
      foldLi.appendChild(btn);
      if (matchesLowOpen) {
        // 展开时：列表在上、收起按钮在下，点完不必往上找
        ol.parentNode.insertBefore(lowOl, ol.nextSibling);
        ol.parentNode.insertBefore(foldLi, lowOl.nextSibling);
      } else {
        ol.appendChild(foldLi);
        ol.parentNode.insertBefore(lowOl, ol.nextSibling);
      }
    }

    if (sparseList.length) {
      const sec = document.createElement('div');
      sec.className = 'sparse-block';
      const head = document.createElement('div');
      head.className = 'sparse-head';
      head.innerHTML = '<b>资料还很少的群友</b><span class="muted tiny">只填了 1–3 项，先看共同项，别急着下结论</span>';
      const ul = document.createElement('ul');
      ul.className = 'sparse-list';
      sparseList.forEach(m => {
        const li = document.createElement('li');
        const av = document.createElement('div');
        av.className = 'avatar';
        av.textContent = String(m.name || '?').slice(0, 1);
        av.style.cssText = avatarStyle(m.name);
        const main = document.createElement('div');
        main.className = 'sparse-main';
        const nm = document.createElement('div');
        nm.className = 'match-name';
        nm.textContent = m.name;
        if (m.gender) {
          const gt = document.createElement('span');
          gt.className = 'gender-tag ' + m.gender;
          gt.textContent = m.gender === 'female' ? '女' : '男';
          nm.appendChild(gt);
        }
        const qq = document.createElement('span');
        qq.className = 'qq';
        qq.textContent = memberLabel(m.qq);
        nm.appendChild(qq);
        const meta = document.createElement('div');
        meta.className = 'sparse-meta muted tiny';
        const names = (m.shared || []).map(x => (typeof x === 'string' ? x : x.text)).filter(Boolean);
        meta.textContent = `共同 ${m.sharedCount} 项（TA 共 ${m.theirsCount} 项）` + (names.length ? '：' + names.join('、') : '');
        main.append(nm, meta);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.textContent = '看 TA 的词条';
        btn.addEventListener('click', () => openMemberModal(m));
        li.append(av, main, btn);
        ul.appendChild(li);
      });
      sec.append(head, ul);
      card.appendChild(sec);
    }
  }

  const NOTE_MAX = 140;
  let noteEditing = false;
  function givenNote() { return (member && member.note) || ''; }
  function setNoteEditing(on) {
    noteEditing = !!on;
    const view = $('noteView'), wrap = $('noteEditWrap');
    if (view) view.hidden = noteEditing;
    if (wrap) wrap.hidden = !noteEditing;
    if (noteEditing) {
      const input = $('noteInput');
      if (input) { input.value = givenNote(); input.focus(); }
    }
    renderNote();
  }
  function renderNote() {
    const input = $('noteInput');
    if (input && !noteEditing && document.activeElement !== input) input.value = givenNote();
    const note = givenNote();
    const txt = $('noteText');
    if (txt) {
      txt.textContent = note || '还没有写留言。写一句，让和你最像的人看到你。';
      txt.classList.toggle('empty', !note);
    }
    const edit = $('noteEdit');
    if (edit) edit.textContent = note ? '修改' : '写一句';
    const meta = $('noteMeta');
    if (meta) meta.textContent = note ? '已保存 · ' + note.length + ' / ' + NOTE_MAX : '';
    const cnt = $('noteCount');
    if (cnt && input) cnt.textContent = input.value.length + ' / ' + NOTE_MAX;
  }

  async function saveNote() {
    if (previewMode) { toast('只读预览中：登录后才能留言'); return; }
    if (!identity) return;
    const input = $('noteInput');
    if (!input) return;
    const note = input.value.trim().slice(0, NOTE_MAX);
    const btn = $('noteSave');
    if (btn) btn.disabled = true;
    try {
      const r = await apiPost('/music/api/note', { qq: identity.qq, note });
      if (r && r.ok) {
        if (member) member.note = r.note;
        else member = { note: r.note };
        toast(note ? '留言已保存，匹配到你的群友能看到' : '留言已清空');
        setNoteEditing(false);
      } else {
        toast((r && r.error) || '保存失败，稍后再试');
      }
    } catch (err) {
      toast('保存失败：' + (err && err.message ? err.message : '网络错误'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openMemberModal(match) {
    $('memberModalTitle').textContent = match.name + ' 的成分';
    $('memberModalSub').textContent = memberLabel(match.qq) + (match.gender ? ' · ' + (match.gender === 'female' ? '女' : (match.gender === 'male' ? '男' : match.gender)) : '');
    $('memberModalList').innerHTML = '<p class="muted tiny">加载中…</p>';
    $('memberModal').hidden = false;
    try {
      const r = await apiGet('/music/api/member?qq=' + encodeURIComponent(match.qq)
        + (identity ? '&me=' + encodeURIComponent(identity.qq) : ''));
      const box = $('memberModalList');
      box.innerHTML = '';
      const theirNote = (r.member && r.member.note) || '';
      if (theirNote) {
        const nb = document.createElement('div');
        nb.className = 'note-quote modal-note';
        nb.textContent = theirNote;
        box.appendChild(nb);
      }
      if (!r.picks || !r.picks.length) {
        box.innerHTML = '<p class="muted tiny">TA 还没选词条。</p>';
        return;
      }
      sortByLevel(r.picks).forEach(p => {
        const row = document.createElement('div');
        row.className = 'member-item';
        if (selection.has(p.id)) row.classList.add('shared');
        const name = document.createElement('span');
        name.className = 'member-name';
        name.textContent = p.text;
        if (p.level) {
          const lv = document.createElement('span');
          lv.className = 'lv-badge lv' + p.level;
          lv.textContent = levelLabel(p.level);
          row.appendChild(lv);
        }
        const cat = document.createElement('span');
        cat.className = 'cat-tag';
        cat.textContent = p.category || '其他';
        const cnt = document.createElement('span');
        cnt.className = 'member-qq';
        cnt.textContent = p.count + ' 人';
        const one = document.createElement('button');
        one.type = 'button';
        one.className = 'copy-btn';
        one.textContent = '复制';
        one.onclick = () => copyText(p.text, '词条');
        row.append(name, cat, cnt, one);
        box.appendChild(row);
      });
    } catch (err) {
      $('memberModalList').innerHTML = '<p class="muted tiny">加载失败：' + esc(err.message) + '</p>';
    }
  }
  function closeMemberModal() {
    $('memberModal').hidden = true;
  }
  function copySelection() {
    if (previewMode) { toast('只读预览中：登录后才能复制选择'); return; }
    if (!selection.size) { toast('还没选词条'); return; }
    const texts = [...selection]
      .map(id => (state.entries.find(e => e.id === id) || {}).text)
      .filter(Boolean);
    copyText(texts.join('、'), '我选的词条');
  }
  function showUpdateBanner() {
    const b = $('updateBanner');
    if (!b) return;
    b.hidden = false;
    b.onclick = () => {
      b.textContent = '更新中…';
      b.disabled = true;
      setTimeout(() => location.reload(), 300);
    };
  }

  function copyText(text, label) {
    const done = () => toast(`已复制${label}：${text}`);
    const fail = () => toast(`复制失败，请长按手动复制：${text}`);
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? done() : fail();
      } catch (e) {
        fail();
      }
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          legacy();
        }, 900);
        navigator.clipboard.writeText(text).then(
          () => { if (settled) return; settled = true; clearTimeout(timer); done(); },
          () => { if (settled) return; settled = true; clearTimeout(timer); legacy(); }
        );
      } else {
        legacy();
      }
    } catch (e) {
      fail();
    }
  }

  // ---------- 词条弹窗：谁选了 ----------
  async function openEntryModal(entryId) {
    modalEntryId = entryId;
    const entry = state.entries.find(e => e.id === entryId);
    if (!entry) return;
    $('entryModalTitle').textContent = `「${entry.text}」`;
    const aliasText = (entry.aliases && entry.aliases.length) ? `又名：${entry.aliases.join(' / ')}` : '';
    $('entryModalSub').textContent = `${entry.count || 0} 人选了这个词条` + (aliasText ? ' · ' + aliasText : '');
    $('entryMembers').innerHTML = '<p class="muted tiny">加载中…</p>';
    $('entryModal').hidden = false;
    updateEntryToggle();
    try {
      const r = await apiGet('/music/api/entry/members?id=' + encodeURIComponent(entryId));
      const box = $('entryMembers');
      box.innerHTML = '';
      if (!r.members || !r.members.length) {
        const p = document.createElement('p');
        p.className = 'muted tiny';
        p.textContent = '还没有人选这个词条，你可以做第一个。';
        box.appendChild(p);
        return;
      }
      r.members.forEach(m => {
        const row = document.createElement('div');
        row.className = 'member-item';
        const name = document.createElement('span');
        name.className = 'member-name';
        name.textContent = m.name;
        const qq = document.createElement('span');
        qq.className = 'member-qq';
        qq.textContent = memberLabel(m.qq);
        const bn = document.createElement('button');
        bn.className = 'copy-btn';
        bn.type = 'button';
        bn.textContent = '复制名称';
        bn.onclick = () => copyText(m.name, '名称');
        const bq = document.createElement('button');
        bq.className = 'copy-btn';
        bq.type = 'button';
        bq.textContent = '复制' + memberKind(m.qq);
        bq.onclick = () => copyText(window.musicMemberValue(m.qq), memberKind(m.qq));
        row.append(name, qq, bn, bq);
        box.appendChild(row);
      });
    } catch (err) {
      $('entryMembers').innerHTML = '<p class="muted tiny">加载失败：' + esc(err.message) + '</p>';
    }
  }
  function updateEntryToggle() {
    const btn = $('entryToggleBtn');
    if (!btn) return;
    if (previewMode) { btn.hidden = true; return; }
    btn.hidden = false;
    if (!modalEntryId) return;
    const on = selection.has(modalEntryId);
    btn.textContent = on ? '移出我的选择' : '选这个词条';
  }
  function closeEntryModal() {
    $('entryModal').hidden = true;
    modalEntryId = null;
  }

  // ---------- 分享卡片 ----------
  function drawShareCard() {
    const canvas = $('shareCanvas');
    const DPR = 2;
    const W = 720;
    const items0 = [...selection].map(id => state.entries.find(e => e.id === id)).filter(Boolean);
    const hasMatch = !!(matches && matches.matches && matches.matches.length);
    const mains0 = items0.filter(e => entryKind(e) === 'main');
    const subs0 = items0.filter(e => entryKind(e) !== 'main');
    const mainsPart = mains0.length ? (46 + mains0.length * 66 + 22) : 0;
    const subsPart = subs0.length ? (38 + subs0.length * 44) : 0;
    const H = Math.max(820, 356 + mainsPart + subsPart + (hasMatch ? 300 : 160));
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    const dark = document.documentElement.dataset.theme === 'dark';
    // 背景
    const g = ctx.createLinearGradient(0, 0, W, H);
    if (dark) { g.addColorStop(0, '#241f2b'); g.addColorStop(1, '#17141c'); }
    else { g.addColorStop(0, '#fff7fb'); g.addColorStop(0.6, '#ffeef5'); g.addColorStop(1, '#eef1ff'); }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 装饰
    ctx.fillStyle = dark ? 'rgba(240,122,168,.18)' : 'rgba(255,143,171,.18)';
    ctx.beginPath(); ctx.arc(W - 60, 60, 180, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark ? 'rgba(129,140,248,.14)' : 'rgba(129,140,248,.14)';
    ctx.beginPath(); ctx.arc(60, H - 70, 150, 0, Math.PI * 2); ctx.fill();

    const ink = dark ? '#f2eef7' : '#3d2233';
    const muted = dark ? '#b9b0c6' : '#8a6d7c';
    ctx.fillStyle = muted;
    ctx.font = '600 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('日本音乐成分表', 48, 92);
    ctx.fillStyle = ink;
    ctx.font = '800 52px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('我的成分', 48, 168);

    const name = (member && member.name) || (identity && identity.name) || '';
    ctx.fillStyle = ink;
    ctx.font = '700 34px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(name || '匿名群友', 48, 236);
    ctx.fillStyle = muted;
    ctx.font = '500 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(memberLabel((member && member.qq) || (identity && identity.qq) || '') + ' · 共选 ' + selection.size + ' 个词条', 48, 278);

    // 词条列表：领域单独一段（大字），细分一段（小字）
    let y = 356;
    const sectionHead = (label, count) => {
      ctx.fillStyle = muted;
      ctx.font = '700 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(label + ' ' + count, 48, y);
      y += 46;
    };
    const fit = (text, maxW, font) => {
      ctx.font = font;
      if (ctx.measureText(text).width <= maxW) return text;
      let t = text;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    };
    if (!items0.length) {
      ctx.fillStyle = muted;
      ctx.font = '500 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('还没选词条，先去站点选几个吧 :)', 48, y);
      y += 40;
    }
    if (mains0.length) {
      sectionHead('领域', mains0.length);
      mains0.forEach((e) => {
        ctx.fillStyle = colorFor(e.id);
        ctx.beginPath(); ctx.arc(74, y - 13, 13, 0, Math.PI * 2); ctx.fill();
        const sub = (e.count || 0) + ' 人选';
        ctx.fillStyle = muted;
        ctx.font = '500 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        const subW = ctx.measureText(sub).width;
        const maxNameW = W - 48 - 100 - subW - 20;
        const text = fit(e.text, maxNameW, '700 38px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif');
        ctx.fillStyle = ink;
        ctx.fillText(text, 100, y);
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = muted;
        ctx.font = '500 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(sub, 100 + tw + 16, y - 2);
        y += 66;
      });
      y += 18;
    }
    if (subs0.length) {
      sectionHead('细分', subs0.length);
      subs0.forEach((e) => {
        ctx.fillStyle = colorFor(e.id);
        ctx.beginPath(); ctx.arc(70, y - 9, 8, 0, Math.PI * 2); ctx.fill();
        const sub = levelLabel(selLevel(e.id)) + ' · ' + (e.count || 0) + ' 人选';
        ctx.fillStyle = muted;
        ctx.font = '500 17px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        const subW = ctx.measureText(sub).width;
        const maxNameW = W - 48 - 92 - subW - 14;
        const text = fit(e.text, maxNameW, '600 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif');
        ctx.fillStyle = ink;
        ctx.fillText(text, 92, y);
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = muted;
        ctx.font = '500 17px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(sub, 92 + tw + 12, y - 1);
        y += 44;
      });
    }

    // 最像的人
    if (matches && matches.matches && matches.matches.length) {
      const top = matches.matches[0];
      const boxY = y + 40;
      ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.72)';
      roundRect(ctx, 48, boxY - 34, W - 96, 120, 22);
      ctx.fill();
      ctx.fillStyle = muted;
      ctx.font = '500 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('和我最像的群友', 72, boxY);
      ctx.fillStyle = ink;
      ctx.font = '700 30px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(top.name + '（' + memberLabel(top.qq) + '）', 72, boxY + 44);
      ctx.fillStyle = dark ? '#ff9fc4' : '#c2407a';
      ctx.font = '700 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      const topPct = (typeof top.matchPercent === 'number') ? top.matchPercent : (top.similarity || 0);
      ctx.fillText('匹配度 ' + topPct + '% · ' + top.overlap + ' 个共同词条', 72, boxY + 78);
    }

    // 底部
    ctx.fillStyle = muted;
    ctx.font = '500 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('来「日本音乐成分表」选你的口味 →', 48, H - 96);
    ctx.fillStyle = ink;
    ctx.font = '600 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(location.origin, 48, H - 56);
    ctx.fillStyle = muted;
    ctx.font = '500 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('求同好：谁和我口味像？来对一下！', 48, H - 24);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function ensurePinyin() {
    if (window.PY_FULL) return Promise.resolve();
    if (ensurePinyin._p) return ensurePinyin._p;
    ensurePinyin._p = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'pinyin.js';
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
    return ensurePinyin._p;
  }

  let trendCache = null;
  const TREND_COLORS = ['#e8557f', '#5b6cff', '#4ecdc4', '#ff9f43', '#a55eea', '#26de81'];

  function fmtTrendTime(t) {
    const ms = (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(t);
    const p = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function drawTrend() {
    const card = $('trendCard');
    const svg = $('trendSvgMain');
    if (!card || !svg) return;
    const points = (trendCache && trendCache.points) || [];
    const texts = (trendCache && trendCache.texts) || {};
    if (points.length < 2) { card.hidden = true; return; }
    card.hidden = false;
    $('trendHint').textContent = points.length + ' 个快照 · 每 30 分钟（' + fmtTrendTime(points[0].t) + ' → ' + fmtTrendTime(points[points.length - 1].t) + '）· 折线为每段新增人数';
    svg.innerHTML = '';
    const narrow = typeof window !== 'undefined' && window.innerWidth < 560;
    const W = 900, H = narrow ? 420 : 320, PL = 40, PR = 14, PT = 14, PB = 34;
    const iw = W - PL - PR, ih = H - PT - PB;
    const ids = new Set();
    points.forEach(p => Object.keys(p.counts || {}).forEach(id => ids.add(id)));
    const finalCounts = {};
    ids.forEach(id => { finalCounts[id] = points[points.length - 1].counts[id] || 0; });
    // 增量：每一段用相邻快照差值（只统计增加，减少记为 0）
    const series = {};
    ids.forEach(id => {
      const arr = [0];
      for (let i = 1; i < points.length; i++) {
        const d = (points[i].counts[id] || 0) - (points[i - 1].counts[id] || 0);
        arr.push(Math.max(0, d));
      }
      series[id] = arr;
    });
    const gain = id => series[id].reduce((a, b) => a + b, 0);
    const kindOf = id => {
      const e = state.entries.find(x => x.id === id);
      return e ? entryKind(e) : 'sub';
    };
    const withText = Array.from(ids).filter(id => texts[id]);
    const mainTop = withText.filter(id => kindOf(id) === 'main').sort((a, b) => gain(b) - gain(a)).slice(0, 2);
    const subTop = withText.filter(id => kindOf(id) !== 'main').sort((a, b) => gain(b) - gain(a)).slice(0, 3);
    const top = mainTop.concat(subTop);
    withText.sort((a, b) => gain(b) - gain(a)).forEach(id => { if (top.length < 5 && top.indexOf(id) < 0) top.push(id); });
    let maxV = 1;
    top.forEach(id => series[id].forEach(v => { maxV = Math.max(maxV, v); }));
    const t0 = points[0].t || 0;
    const tN = points[points.length - 1].t || (t0 + 1);
    const x = (i) => PL + iw * Math.max(0, Math.min(1, (points[i].t - t0) / Math.max(1, tN - t0)));
    const y = (v) => PT + ih - (ih * v) / maxV;
    for (let g = 0; g <= 3; g++) {
      const v = (maxV * g) / 3, yy = y(v);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', PL); line.setAttribute('x2', W - PR);
      line.setAttribute('y1', yy); line.setAttribute('y2', yy);
      line.setAttribute('stroke', 'rgba(128,128,128,.22)');
      line.setAttribute('stroke-dasharray', '3 4');
      svg.appendChild(line);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', PL - 6); t.setAttribute('y', yy + 4);
      t.setAttribute('text-anchor', 'end'); t.setAttribute('font-size', '11');
      t.setAttribute('fill', 'currentColor'); t.setAttribute('opacity', '.55');
      t.textContent = Math.round(v);
      svg.appendChild(t);
    }
    top.forEach((id, k) => {
      const color = TREND_COLORS[k % TREND_COLORS.length];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', points.map((p, i) => x(i) + ',' + y(series[id][i] || 0)).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '2.2');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x(points.length - 1));
      dot.setAttribute('cy', y(series[id][series[id].length - 1] || 0));
      dot.setAttribute('r', '3');
      dot.setAttribute('fill', color);
      svg.appendChild(dot);
    });
    const axis = (txt, anchor, ax) => {
      const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t2.setAttribute('x', ax); t2.setAttribute('y', H - 12);
      t2.setAttribute('text-anchor', anchor);
      t2.setAttribute('font-size', '11');
      t2.setAttribute('fill', 'currentColor');
      t2.setAttribute('opacity', '.55');
      t2.textContent = txt;
      svg.appendChild(t2);
    };
    axis(fmtTrendTime(points[0].t), 'start', PL);
    axis(fmtTrendTime(points[points.length - 1].t), 'end', W - PR);

    const legend = $('trendLegendMain');
    legend.innerHTML = '';
    top.forEach((id, k) => {
      const sp = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = TREND_COLORS[k % TREND_COLORS.length];
      const tx = document.createElement('span');
      tx.textContent = texts[id] + '（新增 ' + gain(id) + ' 人）';
      sp.append(i, tx);
      legend.appendChild(sp);
    });
    const gainList = $('trendGainList');
    const gainCard = $('trendGainCard');
    if (gainList && gainCard) {
      const rows = top.map(id => ({ id, gain: gain(id), now: finalCounts[id] || 0 }))
        .filter(r => r.gain > 0)
        .sort((a, b) => b.gain - a.gain);
      gainList.innerHTML = '';
      gainCard.hidden = !rows.length;
      rows.forEach(r => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = texts[r.id] + ' · 现在 ' + r.now + ' 人';
        const d = document.createElement('b');
        d.textContent = '+' + r.gain + ' 人';
        li.append(name, d);
        gainList.appendChild(li);
      });
      if (!rows.length) {
        const li = document.createElement('li');
        li.textContent = '这段时间各词条人数没有变化';
        gainList.appendChild(li);
      }
    }
  }

  function renderTrendExtras() {
    const t = trendCache || {};
    const sum = $('dynSummary');
    if (sum) {
      const chips = [];
      const re = state.recentEntries24h || 0, rm = state.recentMembers24h || 0;
      chips.push(['近 24h', '+' + re + ' 词条 · +' + rm + ' 群友']);
      const n7 = t.new7d || {};
      chips.push(['近 7 天', '+' + (n7.entries || 0) + ' 词条 · +' + (n7.members || 0) + ' 群友']);
      const tt = t.totals || {};
      chips.push(['总共', (tt.entries || state.entries.length) + ' 词条 · ' + (tt.members || '-') + ' 群友']);
      sum.innerHTML = '';
      chips.forEach(([k, v]) => {
        const sp = document.createElement('span');
        sp.className = 'dyn-chip';
        const kk = document.createElement('i');
        kk.textContent = k;
        const vv = document.createElement('b');
        vv.textContent = v;
        sp.append(kk, vv);
        sum.appendChild(sp);
      });
    }

    const fmt = (ts) => {
      const ms = (typeof ts === 'number' && ts < 1e12) ? ts * 1000 : ts;
      const d = new Date(ms);
      if (isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    const ago = (ts) => {
      const ms = (typeof ts === 'number' && ts < 1e12) ? ts * 1000 : ts;
      const diff = Date.now() - ms;
      if (!isFinite(diff) || diff < 0) return fmt(ts);
      const m = diff / 60000;
      if (m < 60) return Math.max(1, Math.round(m)) + ' 分钟前';
      const h = m / 60;
      if (h < 24) return Math.round(h) + ' 小时前';
      return Math.round(h / 24) + ' 天前';
    };

    const rel = $('recentEntriesList'), rec = $('recentEntriesCard');
    if (rel && rec) {
      const list = t.recentEntries || [];
      rec.hidden = !list.length;
      rel.innerHTML = '';
      list.forEach(e => {
        const li = document.createElement('li');
        const main = document.createElement('div');
        main.className = 'dyn-main';
        const nm = document.createElement('span');
        nm.className = 'dyn-name';
        nm.textContent = e.text;
        const tag = document.createElement('span');
        tag.className = 'dyn-tag';
        tag.textContent = (e.kind === 'main' ? '领域 · ' : '细分 · ') + (e.category || '其他');
        main.append(nm, tag);
        const meta = document.createElement('div');
        meta.className = 'dyn-meta';
        meta.textContent = '现在 ' + (e.count || 0) + ' 人 · ' + ago(e.createdAt);
        li.append(main, meta);
        rel.appendChild(li);
      });
    }

    const rml = $('recentMembersList'), rmc = $('recentMembersCard');
    if (rml && rmc) {
      const list = t.recentMembers || [];
      rmc.hidden = !list.length;
      rml.innerHTML = '';
      list.forEach(m => {
        const li = document.createElement('li');
        const main = document.createElement('div');
        main.className = 'dyn-main';
        const nm = document.createElement('span');
        nm.className = 'dyn-name';
        nm.textContent = m.name || '（未命名）';
        main.appendChild(nm);
        const meta = document.createElement('div');
        meta.className = 'dyn-meta';
        meta.textContent = memberLabel(m.qq) + ' · ' + ago(m.createdAt);
        li.append(main, meta);
        rml.appendChild(li);
      });
    }
    renderDynShouts();
  }

  function renderDynShouts() {
    const list = $('dynShoutList'), card = $('dynShoutCard');
    if (!list || !card) return;
    const items = (typeof shouts !== 'undefined' && shouts ? shouts : []).slice(0, 5);
    card.hidden = !items.length;
    if (!items.length) return;
    list.innerHTML = '';
    items.forEach(s => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'dyn-main';
      const tx = document.createElement('span');
      tx.className = 'dyn-name';
      tx.textContent = s.text;
      main.appendChild(tx);
      const meta = document.createElement('div');
      meta.className = 'dyn-meta';
      meta.textContent = (s.name || '') + ' · ' + fmtTrendTime(s.createdAt);
      li.append(main, meta);
      li.addEventListener('click', () => { if (typeof openShoutModal === 'function') openShoutModal(s); });
      li.style.cursor = 'pointer';
      list.appendChild(li);
    });
  }

  async function loadTrend(force) {
    if (trendCache && !force) { drawTrend(); return; }
    try {
      trendCache = await apiGet('/music/api/trend');
      drawTrend();
      renderTrendExtras();
      const th = $('trendHint');
      if (th) {
        const snap = th.textContent.replace(' · 折线为每段新增人数', '');
        th.textContent = `近 24h +${state.recentEntries24h || 0} 词条 · +${state.recentMembers24h || 0} 群友 · ` + snap;
      }
    } catch (e) {
      const card = $('trendCard');
      if (card) card.hidden = true;
    }
  }

  const SINGLE_TEASES = [
    '这几位目前还没被任何小团体收编——不是不合群，是别人的品味还没追上。',
    '没有人跟他们相似度 ≥ 40%。可能是品味太超前，也可能只是词条选得太少（笑）。',
    '恭喜以下群友荣获「独立音乐人」称号：在群里，暂时没人能接住你们的审美。',
    '别人都在抱团了，这几位还在群里流浪。要不主动点，去撩一下同好？',
    '系统努力了，但实在没找到能跟他们凑一块的人。品味太独，也是一种本事。',
  ];

  const BIG_MIN = 10;
  const BIG_TEASES = [
    '本群头部势力，成员数量已对其他小团体形成碾压（开玩笑的，别当真）。',
    '大团体的人表示：我们不叫抱团，叫「品味高度统一」。',
    '据说大团体已经把小团体的歌单都嘲笑了一遍（不是，没有）。',
    '人数超过 10，正式获得「霸凌小团体」的资格（纯玩梗）。',
    '现在加入还来得及，大团体还缺一个端茶倒水的。',
  ];
  const SMALL_TEASES = [
    '{big} 的人刚路过这里，你们最好小声点讨论。',
    '人数上暂时打不过 {big}，但品味这种事不好说（真的不好说）。',
    '{big} 已经占了本群半壁江山，小团体瑟瑟发抖。',
    '没事，{big} 当初也是从两个人开始的。',
    '小心，{big} 正在物色下一个被收编的小团体。',
  ];

  async function renderClusters() {
    const card = $('clustersCard');
    if (!card) return;
    try {
      const r = await apiGet('/music/api/clusters');
      const list = (r && r.clusters) || [];
      const singles = (r && r.singleMembers) || [];
      if (!list.length && !singles.length) { card.hidden = true; return; }
      card.hidden = false;
      const box = $('clustersList');
      box.innerHTML = '';
      const bigIdx = list.map((c, i) => ((c.size || 0) > BIG_MIN ? i : -1)).filter(i => i >= 0);
      const bigTotal = bigIdx.length;
      const bigName = () => '大团体 ' + (1 + Math.floor(Math.random() * bigTotal));
      $('clustersHint').textContent = '按相似度 ≥ ' + (r.minLink || 40) + '% 自动抱团，共 ' + r.membersWithSelection + ' 位群友参与了选择' +
        (singles.length ? '，' + singles.length + ' 位暂时落单' : '') +
        (bigIdx.length ? '（' + bigIdx.length + ' 个大团体正在称霸）' : '') + '：';
      let bigNo = 0;
      let smallNo = 0;
      list.forEach((c) => {
        const big = (c.size || 0) > BIG_MIN;
        const seq = big ? (++bigNo) : (++smallNo);
        const div = document.createElement('div');
        div.className = 'cluster' + (big ? ' big' : '');
        const head = document.createElement('div');
        head.className = 'cluster-head';
        head.textContent = (big ? '🚩 大团体 ' : '小团体 ') + seq + ' · ' + c.size + ' 人';
        if (big) {
          const badge = document.createElement('span');
          badge.className = 'big-badge';
          badge.textContent = '人数压制';
          head.appendChild(badge);
        }
        const mem = document.createElement('div');
        mem.className = 'cluster-members';
        mem.textContent = c.members.map(m => m.name).join('、');
        const tags = document.createElement('div');
        tags.className = 'cluster-tags';
        c.tags.forEach(t => {
          const s = document.createElement('span');
          s.textContent = t.text + ' ' + t.count;
          tags.appendChild(s);
        });
        const tease = document.createElement('p');
        tease.className = 'cluster-tease';
        if (big) {
          tease.textContent = BIG_TEASES[Math.floor(Math.random() * BIG_TEASES.length)];
        } else {
          const tpl = SMALL_TEASES[Math.floor(Math.random() * SMALL_TEASES.length)];
          tease.textContent = bigIdx.length ? tpl.replace('{big}', bigName()) : tpl.replace('{big}', '别的小团体');
        }
        div.append(head, tease, mem, tags);
        box.appendChild(div);
      });
      if (singles.length) {
        const div = document.createElement('div');
        div.className = 'cluster singles';
        const head = document.createElement('div');
        head.className = 'cluster-head';
        head.textContent = '🥲 落单小团体 · ' + singles.length + ' 人';
        const badge = document.createElement('span');
        badge.className = 'single-badge';
        badge.textContent = '独行侠';
        head.appendChild(badge);
        const tease = document.createElement('p');
        tease.className = 'single-tease';
        tease.textContent = SINGLE_TEASES[Math.floor(Math.random() * SINGLE_TEASES.length)];
        const mem = document.createElement('div');
        mem.className = 'cluster-members';
        mem.textContent = singles.map(m => m.name).join('、');
        const tags = document.createElement('div');
        tags.className = 'cluster-tags';
        const tagCount = {};
        singles.forEach(m => (m.picks || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
        Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([t, c]) => {
          const s = document.createElement('span');
          s.textContent = t + ' ' + c;
          tags.appendChild(s);
        });
        if (!tags.childNodes.length) {
          const s = document.createElement('span');
          s.textContent = '暂无共同点';
          tags.appendChild(s);
        }
        div.append(head, tease, mem, tags);
        box.appendChild(div);
      }
    } catch (e) {
      card.hidden = true;
    }
  }

  function openShare() {
    if (previewMode) { toast('只读预览中：登录后才能分享'); return; }
    if (!selection.size) { toast('先选几个词条再分享'); return; }
    drawShareCard();
    $('shareModal').hidden = false;
  }
  function closeShare() { $('shareModal').hidden = true; }

  // ---------- 喊话板 ----------
  let shouts = [];
  let shoutNextAllowedAt = 0;
  let shoutTickerIdx = 0;
  let shoutHistory = [];
  let shoutHistoryTotal = 0;
  let shoutHistoryOffset = 0;
  let shoutHistoryLoading = false;
  const SHOUT_HISTORY_PAGE = 10;

  function shoutTimeText(ts) {
    const d = new Date((Number(ts) || 0) * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function shoutAgo(ts) {
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts || 0));
    if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return Math.floor(diff / 86400) + ' 天前';
  }

  function openShoutModal(s) {
    if (!s) return;
    $('shoutModalText').textContent = s.text;
    $('shoutModalFrom').textContent = `来自：${s.name} · ${memberLabel(s.qq)} · ${shoutTimeText(s.createdAt)}`;
    $('shoutModal').hidden = false;
    $('shoutCopyQQ').textContent = '复制' + memberKind(s.qq);
    $('shoutCopyQQ').onclick = () => copyText(window.musicMemberValue(s.qq), memberKind(s.qq));
    $('shoutCopyText').onclick = () => copyText(s.text, '喊话内容');
  }
  function closeShoutModal() { $('shoutModal').hidden = true; }

  function updateMobBar() {
    const bar = $('mobBar');
    if (!bar) return;
    const visible = !previewMode && !!identity && dirty && !$('appView').hidden;
    bar.hidden = !visible;
    document.documentElement.classList.toggle('has-unsaved', visible);
  }

  function stickyOffset() {
    const bar = $('shoutTickerCard');
    const on = !!(bar && !bar.hidden);
    return on ? bar.offsetHeight - 1 : 0;
  }

  function syncShoutHeight() {
    const card = $('shoutTickerCard');
    const root = document.documentElement;
    const on = card && !card.hidden;
    root.classList.toggle('has-shout', !!on);
    root.style.setProperty('--shout-h', on ? card.offsetHeight + 'px' : '0px');
    root.style.setProperty('--sticky-h', stickyOffset() + 'px');
  }

  function renderShoutMarquee() {
    const card = $('shoutTickerCard');
    if (!card) return;
    if (!shouts.length || !identity) { card.hidden = true; syncShoutHeight(); return; }
    card.hidden = false;
    const track = $('shoutMarqueeTrack');
    if (!track) return;
    track.innerHTML = '';
    const addItem = (s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shout-marquee-item';
      b.textContent = s.text;
      const from = document.createElement('span');
      from.className = 'shout-marquee-from';
      from.textContent = '— ' + s.name;
      b.appendChild(from);
      b.addEventListener('click', () => openShoutModal(s));
      track.appendChild(b);
    };
    shouts.forEach(addItem);
    shouts.forEach((s2) => {
      addItem(s2);
      const dup = track.lastElementChild;
      if (dup) { dup.setAttribute('aria-hidden', 'true'); dup.tabIndex = -1; }
    });
    const chars = shouts.reduce((n, s) => n + String(s.text || '').length + 10, 0);
    track.style.animationDuration = Math.min(80, Math.max(22, chars * 0.22)) + 's';
    syncShoutHeight();
  }

  function renderShoutBoard() {
    const card = $('shoutCard');
    if (!card) return;
    if (!identity) { card.hidden = true; return; }
    card.hidden = false;
    $('shoutHint').textContent = shouts.length ? `共 ${shouts.length} 条` : '';
    const list = $('shoutList');
    list.innerHTML = '';
    const empty = $('shoutEmpty');
    const pager = $('shoutPager');
    pager.innerHTML = '';
    if (!shouts.length) {
      empty.hidden = false;
      $('shoutRotateHint').hidden = true;
      return;
    }
    empty.hidden = true;
    $('shoutRotateHint').hidden = false;
    shouts.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'shout-item';
      const txt = document.createElement('button');
      txt.type = 'button';
      txt.className = 'shout-text';
      txt.textContent = s.text;
      txt.addEventListener('click', () => openShoutModal(s));
      const meta = document.createElement('span');
      meta.className = 'shout-meta';
      meta.textContent = (s.mine ? '我 · ' : '') + s.name + ' · ' + shoutAgo(s.createdAt);
      li.append(txt, meta);
      list.appendChild(li);
    });
  }

  function renderShoutHistoryCount() {
    const el = $('shoutHistoryCount');
    if (!el) return;
    el.textContent = shoutHistoryTotal ? `共 ${shoutHistoryTotal} 条` : '';
  }

  function renderShoutHistory() {
    const list = $('shoutHistoryList');
    if (!list) return;
    list.innerHTML = '';
    const empty = $('shoutHistoryEmpty');
    if (empty) empty.hidden = shoutHistory.length > 0;
    shoutHistory.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'shout-history-item';
      const txt = document.createElement('button');
      txt.type = 'button';
      txt.className = 'shout-history-text';
      txt.textContent = s.text;
      txt.addEventListener('click', () => openShoutModal(s));
      const meta = document.createElement('span');
      meta.className = 'shout-history-meta';
      meta.textContent = `${s.name} · ${memberLabel(s.qq)} · ${shoutTimeText(s.createdAt)}`;
      li.append(txt, meta);
      list.appendChild(li);
    });
    const more = $('shoutHistoryMore');
    if (more) more.hidden = shoutHistory.length >= shoutHistoryTotal || !shoutHistoryTotal;
  }

  async function loadShoutHistory(reset) {
    if (!identity || shoutHistoryLoading) return;
    if (reset) {
      shoutHistory = [];
      shoutHistoryOffset = 0;
    }
    shoutHistoryLoading = true;
    try {
      const r = await apiGet(`/api/shouts/history?offset=${shoutHistoryOffset}&limit=${SHOUT_HISTORY_PAGE}`);
      const items = r.items || [];
      shoutHistoryTotal = Number(r.total) || 0;
      shoutHistory = shoutHistory.concat(items);
      shoutHistoryOffset += items.length;
    } catch (e) {
      // 失败时保留已有内容
    }
    shoutHistoryLoading = false;
    renderShoutHistoryCount();
    renderShoutHistory();
  }

  function toggleShoutHistory() {
    const wrap = $('shoutHistoryWrap');
    const btn = $('shoutHistoryBtn');
    if (!wrap || !btn) return;
    wrap.hidden = !wrap.hidden;
    btn.setAttribute('aria-expanded', String(!wrap.hidden));
    if (!wrap.hidden && !shoutHistory.length) loadShoutHistory(true);
  }


  function updateShoutCompose() {
    const left = shoutNextAllowedAt - Math.floor(Date.now() / 1000);
    const btn = $('shoutSubmit');
    const cd = $('shoutCooldown');
    if (!btn) return;
    if (left > 0) {
      btn.disabled = true;
      if (cd) cd.textContent = '24 小时内已喊过 · 下次可喊：' + shoutTimeText(shoutNextAllowedAt);
    } else {
      btn.disabled = false;
      if (cd) cd.textContent = '';
    }
  }

  function renderShouts() {
    if (!identity) {
      if ($('shoutTickerCard')) $('shoutTickerCard').hidden = true;
      if ($('shoutCard')) $('shoutCard').hidden = true;
      if ($('dynShoutCard')) $('dynShoutCard').hidden = true;
      syncShoutHeight();
      return;
    }
    renderShoutMarquee();
    renderShoutBoard();
    updateShoutCompose();
    renderDynShouts();
  }

  async function loadShouts() {
    if (!identity) return;
    try {
      const r = await apiGet('/music/api/shouts?qq=' + encodeURIComponent(identity.qq));
      shouts = r.shouts || [];
      shoutNextAllowedAt = r.nextAllowedAt || 0;
      shoutHistoryTotal = Number(r.historyTotal) || 0;
      if ($('shoutHistoryWrap') && !$('shoutHistoryWrap').hidden) loadShoutHistory(true);
      else renderShoutHistoryCount();
    } catch (e) { shouts = []; }
    renderShouts();
  }

  async function submitShout() {
    if (!identity) return;
    const input = $('shoutInput');
    const text = (input.value || '').trim();
    const err = $('shoutError');
    if (!text) { err.textContent = '先写点什么吧'; return; }
    err.textContent = '';
    $('shoutSubmit').disabled = true;
    try {
      const r = await apiPost('/music/api/shout', { qq: identity.qq, text });
      shouts = r.shouts || [];
      shoutNextAllowedAt = r.nextAllowedAt || 0;
      shoutHistoryTotal = Number(r.historyTotal) || 0;
      if ($('shoutHistoryWrap') && !$('shoutHistoryWrap').hidden) loadShoutHistory(true);
      else renderShoutHistoryCount();
      input.value = '';
      $('shoutCount').textContent = '0/140';
      $('shoutCompose').hidden = true;
      renderShouts();
      toast('喊话发出去了');
    } catch (e) {
      err.textContent = e.message;
      $('shoutSubmit').disabled = false;
    }
  }

  function downloadShare() {
    const canvas = $('shareCanvas');
    const a = document.createElement('a');
    a.download = '我的日本音乐成分.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }
  async function nativeShare() {
    const canvas = $('shareCanvas');
    try {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const file = new File([blob], '我的日本音乐成分.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '我的日本音乐成分' });
      } else {
        downloadShare();
      }
    } catch (e) {
      downloadShare();
    }
  }

  // ---------- 主题 ----------
  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.add('theme-anim');
    root.dataset.theme = theme;
    const btn = $('themeBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    try { localStorage.setItem('jpm.theme', theme); } catch (e) {}
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove('theme-anim'), 340);
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    if (!$('shareModal').hidden) drawShareCard();
  }

  // ---------- actions ----------


  function pruneSelection() {
    if (!selection.size || !state || !state.entries) return;
    const ids = new Set(state.entries.map((e) => e.id));
    let changed = false;
    for (const id of [...selection]) if (!ids.has(id)) { selection.delete(id); changed = true; }
    if (changed) dirty = true;
  }

  function limitReason(kind) {
    const c = selectionCounts();
    if (kind === 'main' && c.main >= selectionLimits.main) return `领域最多选 ${selectionLimits.main} 个，先取消一个再选`;
    if (kind !== 'main' && c.sub >= selectionLimits.sub) return `细分最多选 ${selectionLimits.sub} 个，先取消一个再选`;
    return '';
  }

  function openLevelPicker(id) {
    if (previewMode) { toast('只读预览中：登录后才能选词条'); return; }
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    closeLevelPicker();
    const wrap = document.createElement('div');
    wrap.className = 'modal level-modal';
    wrap.id = 'levelPicker';
    wrap.innerHTML = `
      <div class="modal-card level-card">
        <div class="modal-head"><h3>你对「${esc(e.text)}」有多熟？</h3><button class="icon-btn" type="button" data-act="close">✕</button></div>
        <p class="muted tiny">熟悉程度会算进匹配，越熟权重越高。</p>
        <div class="level-options">
          <button type="button" data-lv="4"><b>本命</b><span>全专都听 / 会唱</span></button>
          <button type="button" data-lv="3"><b>常听</b><span>大部分歌都熟</span></button>
          <button type="button" data-lv="2"><b>听过一些</b><span>熟悉的歌有几首</span></button>
          <button type="button" data-lv="1"><b>只听过几首</b><span>听过名字或一两首</span></button>
        </div>
        ${selection.has(id) ? '<button type="button" class="link small level-remove" data-act="remove">从已选中移除</button>' : ''}
      </div>`;
    wrap.addEventListener('click', (ev) => {
      if (ev.target === wrap || ev.target.closest('[data-act="close"]')) { closeLevelPicker(); return; }
      if (ev.target.closest('[data-act="remove"]')) {
        selection.delete(id); dirty = true;
        closeLevelPicker(); renderBoard(); renderSelection(); renderRank();
        toast('已移除');
        return;
      }
      const btn = ev.target.closest('[data-lv]');
      if (!btn) return;
      applyLevel(id, Number(btn.dataset.lv));
      closeLevelPicker();
    });
    document.body.appendChild(wrap);
  }

  function applyLevel(id, lv) {
    if (!selection.has(id)) {
      const e = state.entries.find((x) => x.id === id);
      const why = limitReason(entryKind(e));
      if (why) { toast(why); return; }
      selection.add(id);
      if (!selOrder) selOrder = [...selection];
      if (selOrder.indexOf(id) < 0) selOrder.push(id);
    }
    selLevels[id] = lv;
    dirty = true;
    // 只更新这一行的四档高亮，不重排、不重建列表
    const row = document.querySelector('#selChips .sel-row[data-id="' + id + '"]');
    if (row) {
      row.querySelectorAll('.sel-seg-btn').forEach((b, i) => {
        const on = [4, 3, 2, 1][i] === lv;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    } else {
      renderSelection();
    }
    renderBoard();
    renderRank();
    updateEntryToggle();
    updateSaveState();
    updateMobBar();
    toast('已记下：' + levelLabel(lv));
  }

  function closeLevelPicker() {
    const el = document.getElementById('levelPicker');
    if (el) el.remove();
  }

  function toggleEntry(id) {
    if (previewMode) { toast('只读预览中：登录后才能选词条'); return; }
    if (selection.has(id)) {
      const cur = state.entries.find((x) => x.id === id);
      if (cur && entryKind(cur) !== 'main') { openLevelPicker(id); return; }
      selection.delete(id);
    } else {
      const e = state.entries.find((x) => x.id === id);
      const kind = entryKind(e);
      const c = selectionCounts();
      const why = limitReason(kind);
      if (why) {
        toast(why);
        const box = document.getElementById('selCount');
        if (box) { box.classList.add('limit-flash'); setTimeout(() => box.classList.remove('limit-flash'), 600); }
        return;
      }
      if (entryKind(e) !== 'main') {
        selection.add(id);
        selLevels[id] = 3;
        dirty = true;
        renderBoard(); renderSelection(); renderRank();
        openLevelPicker(id);
        return;
      }
      selection.add(id);
      selLevels[id] = 0;
    }
    dirty = true;
    renderBoard();
    renderSelection();
    renderRank();
    updateEntryToggle();
  }

  let savingSelection = false;
  function updateSaveState() {
    const defs = { saveBtn: '保存并匹配', mobSave: '保存并匹配' };
    Object.keys(defs).forEach((id) => {
      const b = $(id);
      if (!b) return;
      if (!b.dataset.label) b.dataset.label = defs[id];
      const saved = !dirty;
      b.classList.toggle('is-saved', saved && selection.size > 0);
      b.disabled = savingSelection || selection.size === 0;
      b.textContent = savingSelection ? '保存中…' : (saved && selection.size > 0) ? '查看同好 →' : b.dataset.label;
    });
  }

  async function saveSelection() {
    if (previewMode) { toast('只读预览中：登录后才能保存'); return; }
    if (!identity || savingSelection) return;
    if (!dirty && selection.size) { window.__showPage('matches', {top:true}); return; }
    const c = selectionCounts();
    if (c.main > selectionLimits.main || c.sub > selectionLimits.sub) {
      toast(`选择超出上限（领域 ${c.main}/${selectionLimits.main} · 细分 ${c.sub}/${selectionLimits.sub}），先取消几个再保存`);
      renderSelection();
      return;
    }
    savingSelection = true;
    updateSaveState();
    try {
      const selPayload = [...selection].map((id) => ({ id, level: selLevel(id) }));
      const r = await apiPost('/music/api/selection', { qq: identity.qq, selection: selPayload });
      member = r.member;
      state.entries = r.entries;
      dirty = false;
      selOrder = null; // 保存后按最新熟悉度重排
      matchesBySort.rare = null; matchesBySort.familiar = null;
      await loadMatches({ force: true });
      renderAll();
      renderClusters();
      toast('已保存，下面是匹配结果');
      if (window.__showPage) window.__showPage('matches', { anim: true, top: true });
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      savingSelection = false;
      renderSelection();
      if (window.__updateMobBar) window.__updateMobBar();
    }
  }

  async function createEntry(root) {
    if (previewMode) { toast('只读预览中：登录后才能创建词条'); return; }
    if (!identity) return;
    root = root || document.querySelector('.create-card');
    if (!root) return;
    const input = root.querySelector('.create-input');
    const catSel = root.querySelector('.create-cat');
    const kindSel = root.querySelector('.create-kind');
    const btn = root.querySelector('.create-btn');
    const text = input ? input.value.trim() : '';
    if (!text) { toast('先写个词条名'); return; }
    const category = (catSel && catSel.value) || '其他';
    const kind = (kindSel && kindSel.value) || 'sub';
    const key = normKey(text);
    const dup = state.entries.find(e => normKey(e.text) === key);
    if (dup) {
      toast(`已经有「${dup.text}」这个词条了，不能重复创建，直接在列表里选它`);
      if (input) input.focus();
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const r = await apiPost('/music/api/entry', { qq: identity.qq, text, category, kind });
      member = r.member;
      if (r.entries) state.entries = r.entries; else state = await apiGet('/music/api/state');
      if (input) input.value = '';
      const eid = r.entry.id;
      toast('词条创建成功');
      const why = limitReason(entryKind(r.entry));
      if (!why && selection.size < MAX_SEL) {
        selection.add(eid); selLevels[eid] = entryKind(r.entry) === 'main' ? 0 : 3; dirty = true;
      } else if (why) {
        toast(why + '（新词条没自动选上）');
      }
      renderAll();
    } catch (err) {
      toast(err.message || '创建失败');
    } finally {
      renderCreateHint();
    }
  }

  function applyMatchSort() {
    const row = $('matchSortRow');
    if (!row) return;
    row.querySelectorAll('.sort-btn').forEach((b) => {
      const on = b.dataset.sort === matchSort;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function wireMatchSort() {
    try {
      if (localStorage.getItem('jpm.matchSort') === 'familiar') matchSort = 'familiar';
    } catch (e) {}
    applyMatchSort();
    const row = $('matchSortRow');
    if (!row) return;
    row.querySelectorAll('.sort-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const next = b.dataset.sort === 'familiar' ? 'familiar' : 'rare';
        if (next === matchSort) return;
        matchSort = next;
        try { localStorage.setItem('jpm.matchSort', matchSort); } catch (e) {}
        applyMatchSort();
        loadMatches();
      });
    });
  }

  // 两种排序各缓存一份：切换时先本地重绘（不闪），后台再补另一份
  const matchesBySort = { rare: null, familiar: null };
  let matchesPrefetching = false;

  async function prefetchMatches(sort) {
    if (!identity || matchesBySort[sort]) return;
    if (matchesPrefetching) return;
    matchesPrefetching = true;
    try {
      const data = await apiGet('/music/api/matches?qq=' + encodeURIComponent(identity.qq) + '&sort=' + sort);
      matchesBySort[sort] = data;
    } catch (e) { /* ignore */ } finally {
      matchesPrefetching = false;
    }
  }

  async function loadMatches(opts = {}) {
    if (!identity) return;
    const want = matchSort;
    if (opts.force) { matchesBySort.rare = null; matchesBySort.familiar = null; }
    if (matchesBySort[want]) {
      matches = matchesBySort[want];
      renderMatches({ instant: true });
      prefetchMatches(want === 'rare' ? 'familiar' : 'rare');
      return;
    }
    try {
      matches = await apiGet('/music/api/matches?qq=' + encodeURIComponent(identity.qq) + '&sort=' + want);
    } catch (e) {
      matches = null;
    }
    matchesBySort[want] = matches;
    renderMatches({ instant: true });
    prefetchMatches(want === 'rare' ? 'familiar' : 'rare');
  }

  // ---------- views ----------
  async function enterPreview() {
    previewMode = true;
    try { state = await apiGet('/music/api/state'); } catch (e) { /* ignore */ }
    showApp();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function exitPreview() {
    previewMode = false;
    showJoin();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function showJoin() {
    previewMode = false;
    $('joinView').hidden = false;
    $('appView').hidden = true;
    const pv = $('previewBar'); if (pv) pv.hidden = true;
    document.querySelectorAll('.create-card').forEach((el) => { el.hidden = false; });
    { const el = $('selectionCard'); if (el) el.hidden = false; }
    const sb = $('shareBtn'), sw = $('switchBtn'); if (sb) sb.hidden = false; if (sw) sw.hidden = false;
    if (window.__updateMobBar) window.__updateMobBar();
    $('qqInput').value = '';
    $('nameInput').value = '';
    if ($('pinInput')) $('pinInput').value = '';
    $('joinError').textContent = '';
  }
  function showApp() {
    $('joinView').hidden = true;
    $('appView').hidden = false;
    const pv = $('previewBar'); if (pv) pv.hidden = !previewMode;
    document.querySelectorAll('.create-card').forEach((el) => { el.hidden = previewMode; });
    ['selectionCard', 'noteCard', 'shoutTickerCard', 'shoutCard'].forEach((id) => { const el = $(id); if (el) el.hidden = previewMode; });
    const cmpCard = $('compareCard'); if (cmpCard) cmpCard.hidden = previewMode;
    const sb = $('shareBtn'), sw = $('switchBtn'); if (sb) sb.hidden = previewMode; if (sw) sw.hidden = previewMode;
    $('myName').textContent = previewMode ? '游客预览' : member.name;
    $('myQq').textContent = previewMode ? '只读' : memberLabel(member.qq);
    renderAll();
    if (window.__showPage) window.__showPage(location.hash.slice(1) || 'board', { force: true, anim: false, hash: false });
    syncShoutHeight();
    renderNote();
    loadShouts();
    if (window.__updateMobBar) window.__updateMobBar();
    try {
      const cards = [...document.querySelectorAll('#appView > .card')];
      cards.forEach((c, i) => {
        c.style.setProperty('--d', Math.min(i, 8) * 45 + 'ms');
        c.classList.add('enter');
      });
      setTimeout(() => cards.forEach((c) => c.classList.remove('enter')), 1100);
    } catch (e) {}
  }
  function confirmJoinPrompt(qq, name) {
    return new Promise((resolve) => {
      const old = document.getElementById('joinConfirm');
      if (old) old.remove();
      const wrap = document.createElement('div');
      wrap.className = 'modal level-modal';
      wrap.id = 'joinConfirm';
      wrap.innerHTML = `
        <div class="modal-card level-card confirm-card">
          <div class="modal-head"><h3>登录前再确认一下</h3><button class="icon-btn" type="button" data-act="cancel">✕</button></div>
          <p class="muted tiny">将用下面这些信息登记并保存到本站：</p>
          <p class="tiny"><b>QQ</b> ${esc(qq)}　·　<b>昵称</b> ${esc(name)}</p>
          <div class="privacy-note">
            <b>隐私提示</b>
            <p>登录需要获取并保存你的 QQ 号和昵称，仅用于站内「和群友匹配爱好」。</p>
            <p class="warn">如果你介意提供 QQ 号，请点「取消」，不要登录 / 注册。</p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="ghost-link" data-act="cancel">取消</button>
            <button type="button" class="primary" data-act="ok">我已知晓，确认登录</button>
          </div>
        </div>`;
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap || ev.target.closest('[data-act="cancel"]')) { done(false); return; }
        if (ev.target.closest('[data-act="ok"]')) done(true);
      });
      document.body.appendChild(wrap);
    });
  }

  async function onJoin(e) {
    e.preventDefault();
    const qq = $('qqInput').value.trim();
    const name = '旧站会员';
    const pin = ($('pinInput') ? $('pinInput').value : '').trim();
    $('joinError').textContent = '';
    if (!/^\d{4,12}$/.test(qq)) { $('joinError').textContent = 'QQ 号要 4-12 位数字'; return; }
    if (!/^\d{4,6}$/.test(pin)) { $('joinError').textContent = '口令要 4-6 位数字'; return; }
    if (!name) { $('joinError').textContent = '名字不能为空'; return; }
    const agreed = true;
    if (!agreed) return;
    $('joinBtn').disabled = true;
    try {
      const r = await apiPost('/music/api/join', { qq, name, pin, consent: true });
      previewMode = false;
      identity = { qq, name: r.member.name };
      localStorage.setItem('jpm.identity', JSON.stringify(identity));
      member = r.member;
      state = { entries: r.entries, memberCount: r.memberCount, categories: r.categories || CATS, recentMembers24h: r.recentMembers24h, recentEntries24h: r.recentEntries24h };
      if (r.selectionLimits) selectionLimits = { main: r.selectionLimits.main, sub: r.selectionLimits.sub };
      setSelectionFromMember(member);
      pruneSelection();
      matches = null;
      showApp();
      toast('已登录，原有成分已保留'); window.dispatchEvent(new Event('music-login'));
    } catch (err) {
      $('joinError').textContent = err.message || '登记失败';
    } finally {
      $('joinBtn').disabled = false;
    }
  }

  // ---------- boot ----------
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      ['main', 'sub'].forEach((k) => { if (boardView[k] === 'bubble') renderKindBoard(k); });
    }, 180);
  });

  // ===== 和群友比成分 =====
  function cmpChip(p, shared) {
    const b = document.createElement('span');
    b.className = 'cmp-chip' + (p.kind === 'main' ? ' cmp-main' : '');
    b.appendChild(document.createTextNode(p.text));
    if (p.kind !== 'main') {
      const l = document.createElement('i');
      l.className = 'cmp-lv';
      if (shared) {
        l.textContent = '你' + (p.myLevelLabel || '常听') + ' / TA ' + (p.theirLevelLabel || '常听');
      } else {
        l.textContent = p.levelLabel || '常听';
      }
      b.appendChild(l);
    }
    return b;
  }

  async function compareWithQQ() {
    if (previewMode) { toast('只读预览中：登录后才能比对'); return; }
    const input = $('cmpQQ');
    const qq = (input.value || '').trim();
    if (!/^(?:\d{4,12}|m_[a-f0-9]{24})$/.test(qq)) { toast('请输入 QQ 号或完整的成分 ID'); input.focus(); return; }
    if (!identity) return;
    if (qq === String(identity.qq)) { toast('这是你自己，换一个人的 QQ 号或成分 ID 吧'); return; }
    const btn = $('cmpBtn');
    btn.disabled = true; btn.textContent = '比对中…';
    try {
      const d = await apiGet('/music/api/compare?me=' + encodeURIComponent(identity.qq) + '&qq=' + encodeURIComponent(qq));
      renderCompare(d);
    } catch (e) {
      toast(e.message || '比对失败');
    } finally {
      btn.disabled = false; btn.textContent = '比一比';
    }
  }

  function renderCompare(d) {
    const box = $('cmpResult');
    box.innerHTML = '';
    box.hidden = false;
    const head = document.createElement('div');
    head.className = 'cmp-head';
    const who = document.createElement('div');
    who.className = 'cmp-who';
    who.innerHTML = '<b>' + esc(d.me.name) + '</b> <span class="muted tiny">' + esc(memberLabel(d.me.qq)) + '</span>'
      + ' <em>vs</em> <b>' + esc(d.other.name) + '</b> <span class="muted tiny">' + esc(memberLabel(d.other.qq)) + '</span>';
    const badge = document.createElement('div');
    badge.className = 'cmp-score';
    badge.innerHTML = '<b>0%</b><span>' + esc(d.stats.label || '') + '</span>';
    const shownPct = (typeof d.matchPercent === 'number') ? d.matchPercent : (d.score || 0);
    countUp(badge.querySelector('b'), shownPct);
    head.append(who, badge);
    box.appendChild(head);

    const st = d.stats || {};
    const stat = document.createElement('p');
    stat.className = 'muted tiny';
    let line = '严格重合 ' + (d.score || 0) + '% · 共同 ' + (st.sharedCount || 0) + ' 个（领域 ' + (st.sharedDomain || 0) + ' / 细分 ' + (st.sharedSub || 0) + '）'
      + ' · 你 ' + (st.mineCount || 0) + ' 个 / TA ' + (st.theirsCount || 0) + ' 个';
    if (st.bothTop) line += ' · 同为「本命」' + st.bothTop + ' 个';
    if (st.mineCovered) line += ' · 你选的他都选了';
    if (st.theirsCovered) line += ' · TA 选的你都选了';
    stat.textContent = line;
    box.appendChild(stat);
    const on = d.otherNote || (d.other && d.other.note) || '';
    if (on) {
      const nq = document.createElement('div');
      nq.className = 'note-quote cmp-note';
      nq.textContent = 'TA 的留言：' + on;
      box.appendChild(nq);
    }

    const sec = (title, list, empty, shared, collapsible) => {
      list = sortByLevel(list);
      const s = document.createElement('div');
      s.className = 'cmp-sec';
      const h = document.createElement('div');
      h.className = 'cmp-sec-title';
      h.textContent = title + (list.length ? ' · ' + list.length : '');
      const wrap = document.createElement('div');
      wrap.className = 'cmp-chips';
      if (!list.length) {
        const em = document.createElement('span');
        em.className = 'muted tiny';
        em.textContent = empty;
        wrap.appendChild(em);
      } else {
        wrap.classList.add('kind-rows');
        kindGrouped(wrap, list, (p) => cmpChip(p, shared));
        if (collapsible) {
          wrap.hidden = true;
          const t = document.createElement('button');
          t.type = 'button';
          t.className = 'mini-toggle';
          t.textContent = '展开';
          t.setAttribute('aria-expanded', 'false');
          t.addEventListener('click', () => {
            const open = wrap.hidden;
            wrap.hidden = !open;
            t.textContent = open ? '收起' : '展开';
            t.setAttribute('aria-expanded', String(open));
          });
          h.appendChild(t);
        }
      }
      s.append(h, wrap);
      return s;
    };
    box.appendChild(sec('共同喜欢', d.shared || [], '还没有共同喜欢的词条', true));
    const cols = document.createElement('div');
    cols.className = 'cmp-cols';
    cols.append(
      sec('只有你选了', d.onlyMine || [], '没有', false, true),
      sec('只有 ' + d.other.name + ' 选了', d.onlyTheirs || [], '没有', false, true)
    );
    box.appendChild(cols);
  }

  function wireNote() {
    const input = $('noteInput');
    const btn = $('noteSave');
    if (input) {
      input.addEventListener('input', () => {
        const cnt = $('noteCount');
        if (cnt) cnt.textContent = input.value.length + ' / ' + NOTE_MAX;
      });
    }
    if (btn) btn.addEventListener('click', saveNote);
    const edit = $('noteEdit');
    if (edit) edit.addEventListener('click', () => setNoteEditing(true));
    const cancel = $('noteCancel');
    if (cancel) cancel.addEventListener('click', () => setNoteEditing(false));
  }

  function wireUiExtras() {
    const ms = $('mobSave');
    if (ms) ms.addEventListener('click', () => saveSelection());
    const goBoard = $('selGoBoard');
    if (goBoard) goBoard.addEventListener('click', () => { if (window.__showPage) window.__showPage('board', { anim: true }); });
    document.querySelectorAll('.view-switch').forEach((sw) => {
      sw.addEventListener('click', (e) => {
        const b = e.target.closest('.vs-btn');
        if (!b) return;
        applyBoardView(sw.dataset.kind, b.dataset.view);
      });
    });
    // 五个主入口与组内分页面共用路由，保留原有 hash 链接。
    const tabs = [...document.querySelectorAll('#tabBar .tab')];
    const pages = [...document.querySelectorAll('#appView .page')];
    const pageOrder = pages.map((p) => p.dataset.page);
    let currentPage = null;
    const pageScroll = {};
    function pageFromHash() {
      const k = (location.hash || '').replace('#', '');
      return pageOrder.includes(k) ? k : null;
    }
    const groupOf = {board:'board', rest:'board', matches:'matches', event:'event', room:'event', shout:'event', trend:'trend', mine:'mine'};
    const pageNames = {board:'热门排行',rest:'全部词条',matches:'同好',event:'按活动分房',room:'分房试算',shout:'找搭子',trend:'动态',mine:'我的成分'};
    function showPage(key, opts) {
      opts = opts || {};
      if (!pageOrder.includes(key)) key = pageOrder[0];
      if (currentPage === key && !opts.force) {
        if (!opts.noScrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      document.title = pageNames[key] + ' · 日音成分站';
      $('discoverNav').hidden = groupOf[key] !== 'board';
      $('gatherNav').hidden = groupOf[key] !== 'event';
      document.querySelectorAll('.section-nav [data-go]').forEach(t => {
        const on = t.dataset.go === key;
        t.classList.toggle('active', on);
        if (on) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current');
      });
      const oldKey = currentPage;
      if (currentPage) pageScroll[currentPage] = window.scrollY;
      currentPage = key;
      const oldIdx = pageOrder.indexOf(oldKey), newIdx = pageOrder.indexOf(key);
      const dirCls = oldKey ? (newIdx > oldIdx ? 'from-right' : (newIdx < oldIdx ? 'from-left' : '')) : '';
      window.__currentPageName = key;
      pages.forEach((p) => {
        const on = p.dataset.page === key;
        p.hidden = !on;
        p.classList.toggle('active', on);
        if (on && opts.anim !== false) {
          p.classList.remove('page-in', 'from-left', 'from-right');
          void p.offsetWidth;
          if (dirCls) p.classList.add(dirCls);
          p.classList.add('page-in');
        }
      });
      tabs.forEach((t) => {
        const on = t.dataset.page === groupOf[key];
        t.classList.toggle('active', on);
        if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
      });
      if (!pageReady[key]) {
        pageReady[key] = true;
        if (key === 'rest') { renderRest(); renderRestMain(); }
        else if (key === 'matches') { renderClusters(); loadMatches(); }
        else if (key === 'trend') { loadTrend(); }
      }
      try { localStorage.setItem('jpm.page', key); } catch (e) {}
      if (opts.hash !== false && location.hash !== '#' + key) history.pushState(null, '', '#' + key);
      document.dispatchEvent(new CustomEvent('music:pagechange', {detail:{page:key}}));
      window.scrollTo({ top: opts.top ? 0 : (pageScroll[key] || 0), behavior: 'auto' });
      const activePage = pages.find((p) => p.dataset.page === key);
      if (activePage && opts.anim !== false) {
        const cards = [...activePage.querySelectorAll('.card')].slice(0, 8);
        cards.forEach((c, i) => {
          c.classList.remove('enter');
          c.style.setProperty('--d', (i * 40) + 'ms');
          void c.offsetWidth;
          c.classList.add('enter');
        });
        setTimeout(() => cards.forEach((c) => { c.classList.remove('enter'); c.style.removeProperty('--d'); }), 900);
      }
      if (window.__updateMobBar) window.__updateMobBar();
    }
    window.__showPage = showPage;
    window.__updateMobBar = updateMobBar;
    tabs.forEach((t) => t.addEventListener('click', () => showPage(t.dataset.page, { anim: true })));
    document.querySelectorAll('[data-go]').forEach(t => t.addEventListener('click', () => showPage(t.dataset.go, {anim:true, top:true})));
    const syncRoute = () => showPage(pageFromHash() || 'board', {anim:false, hash:false, noScrollTop:true});
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    $('discoverSearch').addEventListener('click', () => { showPage('rest', {top:true}); $('searchInput').focus(); });
    $('discoverCreate').addEventListener('click', () => {
      showPage('rest', {top:true});
      const fold = $('createCard').querySelector('details');
      fold.open = true;
      fold.scrollIntoView({block:'center', behavior:'smooth'});
      fold.querySelector('input').focus({preventScroll:true});
    });
    showPage(pageFromHash() || 'board', {anim:false, top:true, hash:false});

    const tt = $('toTop');
    if (tt) {
      tt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      const onScroll = () => { tt.hidden = window.scrollY < 700; };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  async function boot() {
    wireUiExtras();
    wireNote();
    wireMatchSort();
    // 主题：默认跟随系统，用户切换后记住
    let theme = 'light';
    try {
      theme = localStorage.getItem('jpm.theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) {}
    applyTheme(theme);
    $('themeBtn').addEventListener('click', toggleTheme);
    setWallEnabled(true);

    $('joinForm').addEventListener('submit', onJoin);
    const pvb = $('previewBtn'); if (pvb) pvb.addEventListener('click', enterPreview);
    const pvl = $('previewLogin'); if (pvl) pvl.addEventListener('click', exitPreview);

    const restFoldEl = $('restFold');
    if (restFoldEl) {
      const sum = restFoldEl.querySelector('summary');
      if (sum) sum.addEventListener('click', (e) => { e.preventDefault(); restFoldEl.open = true; });
      restFoldEl.open = true;
    }
    document.querySelectorAll('.create-card').forEach((root) => {
      const btn = root.querySelector('.create-btn');
      const kind = root.querySelector('.create-kind');
      const cat = root.querySelector('.create-cat');
      const inp = root.querySelector('.create-input');
      if (btn) btn.addEventListener('click', () => createEntry(root));
      if (kind) kind.addEventListener('change', renderCreateHint);
      if (cat) cat.addEventListener('change', renderCreateHint);
      if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') createEntry(root); });
    });
    const selToggle = $('selToggle');
    const applySelCollapsed = () => {
      const collapsed = localStorage.getItem('jpm.selCollapsed') === '1';
      const body = $('selBody');
      if (body) body.hidden = collapsed;
      if (selToggle) selToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    if (selToggle) {
      selToggle.addEventListener('click', () => {
        const collapsed = localStorage.getItem('jpm.selCollapsed') === '1';
        localStorage.setItem('jpm.selCollapsed', collapsed ? '0' : '1');
        applySelCollapsed();
      });
    }
    applySelCollapsed();
    $('saveBtn').addEventListener('click', saveSelection);
    $('copySelBtn').addEventListener('click', copySelection);
    $('shareBtn').addEventListener('click', openShare);
    if ($('cmpBtn')) $('cmpBtn').addEventListener('click', compareWithQQ);
    if ($('cmpQQ')) $('cmpQQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') compareWithQQ(); });
    $('shareClose').addEventListener('click', closeShare);
    $('shareDownload').addEventListener('click', downloadShare);
    $('shareNative').addEventListener('click', nativeShare);
    if (navigator.canShare) $('shareNative').hidden = false;
    $('entryModalClose').addEventListener('click', closeEntryModal);
    $('entryModal').addEventListener('click', (e) => { if (e.target === $('entryModal')) closeEntryModal(); });
    $('memberModalClose').addEventListener('click', closeMemberModal);
    $('memberModal').addEventListener('click', (e) => { if (e.target === $('memberModal')) closeMemberModal(); });
    $('shareModal').addEventListener('click', (e) => { if (e.target === $('shareModal')) closeShare(); });

    // 喊话板
    if ($('shoutModalClose')) $('shoutModalClose').addEventListener('click', closeShoutModal);
    if ($('shoutModal')) $('shoutModal').addEventListener('click', (e) => { if (e.target === $('shoutModal')) closeShoutModal(); });
    if ($('shoutComposeBtn')) {
      $('shoutComposeBtn').addEventListener('click', () => {
        const box = $('shoutCompose');
        box.hidden = !box.hidden;
        if (!box.hidden) { $('shoutError').textContent = ''; $('shoutInput').focus(); }
      });
    }
    if ($('shoutInput')) {
      $('shoutInput').addEventListener('input', () => {
        $('shoutCount').textContent = $('shoutInput').value.length + '/140';
      });
    }
    if ($('shoutSubmit')) $('shoutSubmit').addEventListener('click', submitShout);
    if ($('shoutHistoryBtn')) $('shoutHistoryBtn').addEventListener('click', toggleShoutHistory);
    if ($('shoutHistoryMore')) $('shoutHistoryMore').addEventListener('click', () => loadShoutHistory(false));
    window.addEventListener('resize', () => { if (identity) { renderShoutBoard(); syncShoutHeight(); } });
    $('entryToggleBtn').addEventListener('click', () => {
      if (!modalEntryId) return;
      toggleEntry(modalEntryId);
      updateEntryToggle();
    });
    const searchEl = $('searchInput');
    const searchClear = $('searchClear');
    const syncSearchClear = () => {
      if (!searchEl || !searchClear) return;
      searchClear.hidden = !searchEl.value;
    };
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        searchQ = searchEl.value.trim();
        if (/^[A-Za-z]{2,}$/.test(searchQ) && !window.PY_FULL) {
          ensurePinyin().then(() => { renderRest(); renderRestMain(); });
        }
        syncSearchClear();
        renderRest(); renderRestMain();
      });
      searchEl.addEventListener('focus', () => { ensurePinyin(); });
      searchEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchEl.value) { searchEl.value = ''; searchQ = ''; syncSearchClear(); renderRest(); renderRestMain(); e.preventDefault(); }
      });
    }
    if (searchClear && searchEl) {
      searchClear.addEventListener('click', () => {
        searchEl.value = ''; searchQ = ''; syncSearchClear(); renderRest(); renderRestMain(); searchEl.focus();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
      if (!searchEl) return;
      e.preventDefault();
      if (window.__showPage && window.__currentPageName !== 'rest') window.__showPage('rest', { anim: true });
      setTimeout(() => searchEl.focus(), 60);
    });
    ['bubbleSvgMain', 'bubbleSvgSub'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', (e) => {
        const g = e.target.closest ? e.target.closest('.bubble-g') : null;
        if (!g) return;
        openEntryModal(g.dataset.id);
      });
    });
    [['rankToggleMain', 'main'], ['rankToggleSub', 'sub']].forEach(([id, kind]) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', () => {
        const willExpand = !rankExpanded[kind];
        rankExpanded[kind] = willExpand;
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
        if (willExpand) {
          rankJustExpanded[kind] = true;
          renderRank();
        } else {
          collapseRank(kind);
        }
      });
    });

    // PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
          });
        });
      }).catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    }

    let pollBusy = false;
    setInterval(async () => {
      if (pollBusy) return;
      if (!identity || $('appView').hidden) return;
      pollBusy = true;
      try {
        const latest = await apiGetState();
        if (!latest) { pollBusy = false; return; }
        const list = latest.entries || [];
        const changed = JSON.stringify(list) !== JSON.stringify(state.entries || []);
        if (latest.memberCount !== state.memberCount) {
          state.memberCount = latest.memberCount;
          state.recentMembers24h = latest.recentMembers24h;
          state.recentEntries24h = latest.recentEntries24h;
          updateStats();
        }
              if (changed) {
          state.entries = list;
          animateBubbles = true;
          renderAll();
          if (matches) loadMatches({ force: true });
        }
      } catch (e) { /* ignore */ }
      pollBusy = false;
    }, 10000);

    try { state = await apiGet('/music/api/state'); } catch (e) { /* ignore */ }
    updateStats();

    localStorage.removeItem('jpm.identity');
    try {
      const r = await apiGet('/music/api/me');
      identity = { qq: r.member.qq, name: r.member.name };
      localStorage.setItem('jpm.identity', JSON.stringify(identity));
      member = r.member;
      state = { entries: r.entries, memberCount: r.memberCount, categories: r.categories || CATS };
      setSelectionFromMember(member); pruneSelection(); showApp(); return;
    } catch (e) { /* A new visitor uses the legacy login or QQ entry. */ }
    showJoin();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

/* ---------- v197 包房匹配度（独立模块） ---------- */
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$('roomPool')) return;
  const picked = new Map();
  let pool = null;
  let busy = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const memberLabel = window.musicMemberLabel;
  const POOL_TOP = 16;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  let rawList = null;
  let orderedByMe = false;
  let includeMe = false;
  try { includeMe = localStorage.getItem('jpm.roomIncludeMe') === '1'; } catch (e) {}

  function myQQ() {
    try {
      if (typeof identity !== 'undefined' && identity && identity.qq) return String(identity.qq);
      const saved = JSON.parse(localStorage.getItem('jpm.identity') || '{}');
      return saved && saved.qq ? String(saved.qq) : '';
    } catch (e) { return ''; }
  }

  function meName() {
    const me = myQQ();
    if (!me) return '';
    if (picked.has(me)) return picked.get(me);
    const m = (pool || rawList || []).find((x) => String(x.qq) === me);
    return m ? m.name : '我';
  }

  function setIncludeMe(on, opts) {
    includeMe = !!on;
    try { localStorage.setItem('jpm.roomIncludeMe', includeMe ? '1' : '0'); } catch (e) {}
    const box = $('roomIncludeMe');
    if (box) box.checked = includeMe;
    const me = myQQ();
    if (includeMe && me) {
      if (!picked.has(me)) picked.set(me, meName() || '我');
    } else if (!includeMe && me) {
      picked.delete(me);
    }
    if (!opts || !opts.silent) {
      renderPool();
      renderPicked();
    }
  }

  async function loadPool() {
    const me0 = myQQ();
    if (pool && (orderedByMe || !me0)) return;
    if (!rawList) {
      try {
        const res = await fetch('/music/api/members', { headers: { Accept: 'application/json' } });
        const data = window.musicRememberContacts(await res.json());
        rawList = (data.members || []).filter((m) => m.count > 0);
      } catch (e) {
        rawList = [];
      }
    }
    const list = rawList.slice();
    // 用「和我的匹配度」给推荐排序：最合拍的在前，其余随机
    const me = me0;
    const scores = new Map();
    if (me) {
      try {
        const r = await fetch('/music/api/matches?qq=' + encodeURIComponent(me) + '&sort=rare', { headers: { Accept: 'application/json' } });
        const d = window.musicRememberContacts(await r.json());
        (d.matches || []).forEach((m) => scores.set(String(m.qq), m.matchPercent || 0));
      } catch (e) {}
    }
    const scored = list
      .filter((m) => scores.has(String(m.qq)))
      .sort((a, b) => (scores.get(String(b.qq)) - scores.get(String(a.qq))) || String(a.name).localeCompare(String(b.name), 'zh'));
    const top = scored.slice(0, POOL_TOP);
    const topSet = new Set(top.map((m) => String(m.qq)));
    const rest = shuffle(list.filter((m) => !topSet.has(String(m.qq))));
    pool = top.concat(rest);
    orderedByMe = !!me;
    const scoresRef = scores;
    window.__roomScores = scoresRef;
    const meBox = $('roomIncludeMe');
    if (meBox) meBox.disabled = !me;
    if (includeMe && me) {
      if (pool.some((m) => String(m.qq) === me) && !picked.has(me)) picked.set(me, meName() || '我');
    }
    const hint = $('roomPoolHint');
    if (hint) {
      hint.textContent = me
        ? '推荐顺序：前 ' + top.length + ' 位按和你的匹配度从高到低，后面随机'
        : '推荐顺序：按名字排列（登录后可按和你的匹配度推荐）';
    }
    renderPool();
    renderPicked();
  }

  function renderPool() {
    const box = $('roomPool');
    if (!box) return;
    const q = ($('roomSearch').value || '').trim().toLowerCase();
    const items = (pool || []).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.qq.includes(q) || window.musicMemberValue(m.qq).includes(q)));
    box.innerHTML = '';
    items.slice(0, 80).forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'room-chip' + (picked.has(m.qq) ? ' on' : '');
      b.textContent = m.name;
      const sc = window.__roomScores && window.__roomScores.get(String(m.qq));
      b.title = memberLabel(m.qq) + ' · ' + m.count + ' 个词条' + (sc ? ' · 和你的匹配度 ' + sc + '%' : '');
      b.addEventListener('click', () => {
        if (picked.has(m.qq)) picked.delete(m.qq);
        else picked.set(m.qq, m.name);
        b.classList.toggle('on', picked.has(m.qq));
        renderPicked();
      });
      box.appendChild(b);
    });
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'muted tiny';
      p.textContent = q ? '没有匹配的群友' : '还没有群友登记';
      box.appendChild(p);
    }
  }

  function renderPicked() {
    const box = $('roomPicked');
    box.innerHTML = '';
    picked.forEach((name, qq) => {
      const chip = document.createElement('span');
      chip.className = 'room-picked-chip';
      const t = document.createElement('span');
      t.textContent = name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'room-x';
      x.setAttribute('aria-label', '移除 ' + name);
      x.textContent = '×';
      x.addEventListener('click', () => {
        picked.delete(qq);
        if (includeMe && myQQ() === String(qq)) {
          includeMe = false;
          try { localStorage.setItem('jpm.roomIncludeMe', '0'); } catch (e) {}
          const box = $('roomIncludeMe');
          if (box) box.checked = false;
        }
        renderPicked();
        renderPool();
      });
      chip.appendChild(t);
      chip.appendChild(x);
      box.appendChild(chip);
    });
    const n = picked.size;
    $('roomHint').textContent = n ? `已选 ${n} 人${n < 2 ? '（至少 2 人才能算包房）' : ''}` : '勾选要坐同一间包房的人';
    $('roomQuery').disabled = n < 2;
    $('roomSplit').disabled = n < 3;
  }

  function showError(msg) {
    const el = $('roomError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function chipRow(list, cls) {
    const row = document.createElement('div');
    row.className = 'room-tags ' + (cls || '');
    list.forEach((it) => {
      const s = document.createElement('span');
      s.className = 'room-tag' + (it.kind === 'main' ? ' main' : '');
      s.textContent = it.text + (it.n >= 2 && it.n < (window.__roomN || 0) ? ` ${it.n}人` : '');
      row.appendChild(s);
    });
    return row;
  }

  function renderPreview(d) {
    const box = $('roomResult');
    box.hidden = false;
    box.innerHTML = '';
    const scoreRow = document.createElement('div');
    scoreRow.className = 'room-score-row';
    scoreRow.innerHTML = `
      <div class="room-score"><b>${d.avg}</b><span>平均契合度</span></div>
      <div class="room-score weak"><b>${d.min}</b><span>最弱一对</span></div>`;
    box.appendChild(scoreRow);

    if (d.worst) {
      const p = document.createElement('p');
      p.className = 'room-note';
      p.textContent = `最不合拍：${d.worst.aName} × ${d.worst.bName}（${d.worst.score} 分 · ${d.worst.label}）`;
      box.appendChild(p);
    }
    if (d.loner && d.members.length > 2) {
      const p = document.createElement('p');
      p.className = 'room-note';
      p.textContent = `${d.loner.name} 和大家平均 ${d.loner.avg} 分，最需要被照顾一下`;
      box.appendChild(p);
    }
    if (d.common && d.common.length) {
      const h = document.createElement('h3');
      h.className = 'room-sub';
      h.textContent = '本房共同歌手（点歌候选）';
      box.appendChild(h);
      box.appendChild(chipRow(d.common));
    }
    const h2 = document.createElement('h3');
    h2.className = 'room-sub';
    h2.textContent = '两两配对';
    box.appendChild(h2);
    const ol = document.createElement('ol');
    ol.className = 'room-pairs';
    (d.pairs || []).forEach((p) => {
      const li = document.createElement('li');
      const strong = p.score >= 55 ? ' strong' : '';
      li.innerHTML = `<span class="room-pair-name">${escapeHtml(p.aName)} × ${escapeHtml(p.bName)}</span>
        <span class="room-pair-score${strong}">${p.score}</span>
        <span class="room-pair-label">${escapeHtml(p.label)} · 共同 ${p.shared}</span>`;
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  let roomState = null;
  let selectedMem = null;

  function memberName(qq) {
    if (picked.has(qq)) return picked.get(qq);
    const m = (pool || []).find((x) => String(x.qq) === String(qq));
    return m ? m.name : qq;
  }

  function roomOf(qq) {
    if (!roomState) return -1;
    return roomState.rooms.findIndex((r) => r.includes(qq));
  }

  async function refreshSplit() {
    if (!roomState) return;
    let stats = [];
    try {
      const d = await postJSON('/music/api/room/recalc', { rooms: roomState.rooms });
      stats = d.rooms || [];
    } catch (e) {
      showError(e.message);
    }
    renderRooms(stats);
  }

  function moveMember(qq, target) {
    if (!roomState) return;
    const cur = roomOf(qq);
    if (target === cur) {
      selectedMem = null;
      refreshSplit();
      return;
    }
    roomState.rooms.forEach((r) => {
      for (let i = r.length - 1; i >= 0; i -= 1) if (r[i] === qq) r.splice(i, 1);
    });
    roomState.unassigned = roomState.unassigned.filter((x) => x !== qq);
    if (target === 'unassigned') {
      if (!roomState.unassigned.includes(qq)) roomState.unassigned.push(qq);
    } else if (typeof target === 'number' && roomState.rooms[target]) {
      roomState.rooms[target].push(qq);
    }
    selectedMem = null;
    refreshSplit();
  }

  function renderRooms(stats) {
    const box = $('roomResult');
    if (!box || !roomState) return;
    box.hidden = false;
    box.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'room-note';
    const total = roomState.rooms.reduce((n, r) => n + r.length, 0);
    head.textContent = `共 ${roomState.rooms.length} 间 · ${total} 人 · 点一下成员，再点目标包房即可调人`;
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'room-grid';
    roomState.rooms.forEach((r, i) => {
      const st = stats[i] || {};
      const card = document.createElement('div');
      card.className = 'room-room' + (selectedMem ? ' picking' : '');
      const headEl = document.createElement('div');
      headEl.className = 'room-room-head';
      const title = document.createElement('b');
      title.textContent = `包房 ${i + 1}`;
      const score = document.createElement('span');
      score.className = 'room-room-score';
      score.textContent = r.length ? `平均 ${st.avg == null ? '-' : st.avg} · 最低 ${st.min == null ? '-' : st.min}` : '空房间';
      headEl.appendChild(title);
      headEl.appendChild(score);
      card.appendChild(headEl);

      const list = document.createElement('div');
      list.className = 'room-room-members';
      if (!r.length) {
        const e = document.createElement('span');
        e.className = 'room-empty';
        e.textContent = '点这里放人';
        list.appendChild(e);
      }
      r.forEach((qq) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'room-mem' + (selectedMem === qq ? ' on' : '');
        b.dataset.qq = qq;
        b.textContent = memberName(qq);
        b.title = '点一下选中，再点别的包房就移过去';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selectedMem = selectedMem === qq ? null : qq;
          renderRooms(stats);
        });
        list.appendChild(b);
      });
      card.appendChild(list);
      if (st.worst && r.length > 1) {
        const w = document.createElement('p');
        w.className = 'muted tiny';
        w.textContent = `最弱：${st.worst.aName} × ${st.worst.bName}（${st.worst.score}）`;
        card.appendChild(w);
      }
      card.addEventListener('click', () => {
        if (selectedMem) moveMember(selectedMem, i);
      });
      grid.appendChild(card);
    });
    box.appendChild(grid);

    const rest = document.createElement('div');
    rest.className = 'room-unassigned' + (selectedMem ? ' picking' : '');
    const rh = document.createElement('div');
    rh.className = 'room-room-head';
    const rb = document.createElement('b');
    rb.textContent = '未分配';
    const rc = document.createElement('span');
    rc.className = 'room-room-score';
    rc.textContent = roomState.unassigned.length ? roomState.unassigned.length + ' 人' : '没有';
    rh.appendChild(rb);
    rh.appendChild(rc);
    rest.appendChild(rh);
    const rl = document.createElement('div');
    rl.className = 'room-room-members';
    roomState.unassigned.forEach((qq) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'room-mem' + (selectedMem === qq ? ' on' : '');
      b.dataset.qq = qq;
      b.textContent = memberName(qq);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedMem = selectedMem === qq ? null : qq;
        renderRooms(stats);
      });
      rl.appendChild(b);
    });
    rest.appendChild(rl);
    rest.addEventListener('click', () => {
      if (selectedMem) moveMember(selectedMem, 'unassigned');
    });
    box.appendChild(rest);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn-ghost room-add';
    add.textContent = '+ 再加一间包房';
    add.addEventListener('click', () => {
      roomState.rooms.push([]);
      refreshSplit();
    });
    box.appendChild(add);
  }

  async function splitRoom() {  const box = $('roomResult');
    box.hidden = false;
    box.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'room-note';
    head.textContent = `分成 ${d.roomCount} 间，每间最多 ${d.capacity} 人`;
    box.appendChild(head);
    (d.rooms || []).forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'room-room';
      const names = r.members.map((m) => escapeHtml(m.name)).join('、');
      card.innerHTML = `
        <div class="room-room-head">
          <b>包房 ${i + 1}</b>
          <span class="room-room-score">平均 ${r.avg} · 最低 ${r.min}</span>
        </div>
        <p class="room-room-names">${names}</p>`;
      if (r.common && r.common.length) card.appendChild(chipRow(r.common, 'small'));
      if (r.worst) {
        const w = document.createElement('p');
        w.className = 'muted tiny';
        w.textContent = `最弱：${r.worst.aName} × ${r.worst.bName}（${r.worst.score}）`;
        card.appendChild(w);
      }
      box.appendChild(card);
    });
  }

  async function postJSON(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = window.musicRememberContacts(await res.json().catch(() => ({})));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  async function queryRoom() {
    if (busy || picked.size < 2) return;
    busy = true;
    showError('');
    try {
      const d = await postJSON('/music/api/room/preview', { qqs: [...picked.keys()] });
      window.__roomN = picked.size;
      renderPreview(d);
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
    }
  }

  let roomMode = 'rooms';
  function setRoomMode(mode) {
    roomMode = mode === 'capacity' ? 'capacity' : 'rooms';
    const box = $('roomMode');
    if (box) {
      [...box.querySelectorAll('.room-mode-btn')].forEach((b) => {
        const on = b.dataset.mode === roomMode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    if ($('roomCount')) $('roomCount').hidden = roomMode !== 'rooms';
    if ($('roomCap')) $('roomCap').hidden = roomMode !== 'capacity';
    showError('');
  }

  async function splitRoom() {
    if (busy || picked.size < 3) return;
    const isRoomCount = roomMode === 'rooms';
    const value = String(isRoomCount ? $('roomCount').value : $('roomCap').value).trim();
    if (!value) { showError(isRoomCount ? '先填要分几间房' : '先填每间房几个人'); return; }
    busy = true;
    showError('');
    try {
      const sameGender = !!($('roomSameGender') && $('roomSameGender').checked);
      const d = await postJSON('/music/api/room/split', Object.assign({ qqs: [...picked.keys()], same_gender: sameGender }, isRoomCount ? { rooms: value } : { capacity: value }));
      window.__roomN = picked.size;
      const assigned = new Set();
      roomState = {
        rooms: (d.rooms || []).map((r) => r.members.map((m) => String(m.qq))),
        unassigned: [...picked.keys()].filter((q) => {
          const inRoom = (d.rooms || []).some((r) => r.members.some((m) => String(m.qq) === String(q)));
          return !inRoom;
        }),
      };
      selectedMem = null;
      await refreshSplit();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
    }
  }

  $('roomSearch').addEventListener('input', renderPool);
  $('roomClear').addEventListener('click', () => {
    picked.clear();
    renderPool();
    renderPicked();
    $('roomResult').hidden = true;
    showError('');
  });
  if ($('roomIncludeMe')) {
    const meNow = myQQ();
    $('roomIncludeMe').checked = includeMe && !!meNow;
    $('roomIncludeMe').disabled = !meNow;
    $('roomIncludeMe').addEventListener('change', (e) => setIncludeMe(e.target.checked));
  }
  $('roomQuery').addEventListener('click', queryRoom);
  $('roomSplit').addEventListener('click', splitRoom);
  if ($('roomMode')) {
    $('roomMode').addEventListener('click', (e) => {
      const b = e.target.closest('.room-mode-btn');
      if (b) setRoomMode(b.dataset.mode);
    });
  }
  document.addEventListener('music:pagechange', (ev) => {
    if (ev.detail.page === 'room') loadPool();
  });
  renderPicked();
})();

/* ===== 按活动分房（活动与名单只读自看板） ===== */
(() => {
  const $ = (id) => document.getElementById(id);
  let events = [];
  let currentId = '';
  let eventMode = 'rooms';
  let eventRoomsState = [];
  let eventPick = null;
  let eventBusy = false;
  let eventLoading = false;
  let matchedCount = 0;
  let loadRevision = 0;
  let choicesRevision = 0;
  let sourcesLoaded = false;
  function syncEventActions() {
    $('eventSplit').disabled = eventBusy || eventLoading || matchedCount < 2;
    $('eventShare').disabled = eventBusy || eventLoading || !eventRoomsState.length;
  }
  function clearEventDetail() {
    matchedCount = 0;
    eventRoomsState = [];
    eventPick = null;
    $('eventDetailCard').hidden = true;
    $('eventContext').hidden = true;
    $('eventResults').hidden = true;
    $('eventRooms').innerHTML = '';
    $('eventShareHint').textContent = '';
    $('eventBoardLink').href = '/';
    syncEventActions();
  }

  function eventParams() {
    const cap = $('eventValue') ? parseInt($('eventValue').value || '0', 10) : 0;
    let sizes = null;
    if ($('eventSizes') && $('eventSizes').value.trim()) {
      sizes = $('eventSizes').value.split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((x) => x >= 1);
    }
    return { mode: eventMode, value: cap, sizes, same: !!($('eventSameGender') && $('eventSameGender').checked) };
  }
  function saveEventParams() {
    try { localStorage.setItem('jpm.eventParams', JSON.stringify(eventParams())); } catch (e) {}
  }
  function restoreEventParams() {
    try {
      const p = JSON.parse(localStorage.getItem('jpm.eventParams') || 'null');
      if (!p) return;
      setEventMode(p.mode || 'rooms', true);
      if ($('eventValue') && p.value) $('eventValue').value = p.value;
      if ($('eventSizes') && p.sizes && p.sizes.length) $('eventSizes').value = p.sizes.join(',');
      if ($('eventSameGender')) $('eventSameGender').checked = !!p.same;
    } catch (e) {}
  }

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtRange(ev) {
    const f = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };
    const a = f(ev.starts_at), b = f(ev.ends_at);
    return a ? (b ? a + ' → ' + b : a) : '时间待定';
  }

  function badgeOf(ev) {
    if (ev.lifecycle === 'cancelled' || ev.status === 'cancelled') return ['已取消', 'off'];
    if (ev.registration_open) return ['报名中', ''];
    if (ev.lifecycle === 'ended' || ev.status === 'finished' || ev.phase === 'ended') return ['已结束', 'off'];
    return ['已截止', 'closed'];
  }

  async function jget(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = window.musicRememberContacts(await res.json().catch(() => ({})));
    if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
    return data;
  }

  async function jpost(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = window.musicRememberContacts(await res.json().catch(() => ({})));
    if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
    return data;
  }

  async function loadEventChoices() {
    const revision = ++choicesRevision;
    const preferred = currentId || new URLSearchParams(location.search).get('event') || '';
    ++loadRevision;
    eventLoading = true;
    $('eventSelect').disabled = true;
    $('eventRefresh').disabled = true;
    $('eventError').hidden = true;
    $('eventEmpty').hidden = true;
    $('eventSourceHint').textContent = '正在读取看板活动与报名名单…';
    clearEventDetail();
    try {
      const data = await jget('/music/api/qgroup/events?limit=100');
      if (revision !== choicesRevision) return;
      events = data.events || [];
      const selected = events.find(ev => String(ev.id) === preferred)
        || events.find(ev => ev.lifecycle === 'ongoing')
        || events.find(ev => ev.lifecycle === 'scheduled' && ev.status !== 'cancelled')
        || events[0];
      $('eventSelect').innerHTML = events.length ? events.map(ev => '<option value="' + escapeHtml(ev.id) + '">'
        + escapeHtml(ev.title || '未命名活动') + '</option>').join('')
        : '<option value="">暂无看板活动</option>';
      $('eventSelect').disabled = !events.length;
      $('eventEmpty').hidden = !!events.length;
      if (selected) {
        $('eventSelect').value = selected.id;
        await openEvent(String(selected.id));
      } else {
        currentId = '';
        $('eventSourceHint').textContent = '活动与报名统一在群聚看板管理。';
      }
    } catch (e) {
      if (revision !== choicesRevision) return;
      events = [];
      currentId = '';
      $('eventSelect').innerHTML = '<option value="">暂时无法读取活动</option>';
      $('eventSourceHint').textContent = '请重试更新名单，或回看板查看活动。';
      $('eventError').textContent = e.message || '看板活动加载失败';
      $('eventError').hidden = false;
    } finally {
      if (revision === choicesRevision) {
        eventLoading = false;
        $('eventRefresh').disabled = false;
        syncEventActions();
      }
    }
  }

  async function openEvent(id) {
    const revision = ++loadRevision;
    currentId = id;
    eventLoading = true;
    $('eventError').hidden = true;
    $('eventSourceHint').textContent = '正在读取看板报名名单…';
    clearEventDetail();
    try {
      const payload = await jget('/music/api/qgroup/event?id=' + encodeURIComponent(id));
      if (revision !== loadRevision) return;
      restoreEventParams();
      renderDetail(payload);
      $('eventContext').hidden = false;
      $('eventDetailCard').hidden = false;
      $('eventBoardLink').href = '/?event=' + encodeURIComponent(id);
      $('eventSourceHint').textContent = '已读取看板名单 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}) + ' · 报名有变化时可更新名单。';
    } catch (e) {
      if (revision !== loadRevision) return;
      $('eventSourceHint').textContent = '名单未能更新，请重试。';
      $('eventError').textContent = e.message || '看板报名名单加载失败';
      $('eventError').hidden = false;
    } finally {
      if (revision === loadRevision) {
        eventLoading = false;
        syncEventActions();
      }
    }
  }

  function renderDetail(p) {
    const ev = p.event || {};
    const b = badgeOf(ev);
    if ($('eventTitle')) $('eventTitle').textContent = ev.title || '活动';
    if ($('eventMeta')) $('eventMeta').textContent = [fmtRange(ev), ev.location || ''].filter(Boolean).join(' · ');
    const counts = ev.counts || {};
    const badges = ['<span class="event-badge ' + b[1] + '">' + b[0] + '</span>'];
    badges.push('<span class="event-badge off">正式 ' + (counts.confirmed || 0) + '</span>');
    if (counts.waiting) badges.push('<span class="event-badge off">候补 ' + counts.waiting + '</span>');
    if (p.rooms_source) badges.push('<span class="event-badge off">看板' + (p.rooms_source === 'actual' ? '实际分房' : '预分房') + '</span>');
    if ((p.matched_qqs || []).length) badges.push('<span class="event-badge">可匹配 ' + p.matched_qqs.length + '</span>');
    if ($('eventBadges')) $('eventBadges').innerHTML = badges.join('');

    const parts = p.participants || [];
    if ($('eventPartCount')) $('eventPartCount').textContent = '共 ' + parts.length + ' 人';
    if ($('eventParticipants')) {
      $('eventParticipants').innerHTML = parts.map((x) => {
        const st = x.status === 'confirmed' ? '正式' : (x.status === 'waiting' ? '候补' : '待确认');
        const conf = x.confirmation_state === 'accepted' ? '已确认' : (x.confirmation_state === 'declined' ? '已拒绝' : '待确认');
        if (x.matched) {
          return '<li class="event-part"><span>' + escapeHtml(x.name || '') + '<span class="tag">' + escapeHtml(x.member_name) + ' · ' + x.count + ' 个词条</span></span><span>' + st + ' · ' + conf + '</span></li>';
        }
        return '<li class="event-part unmatched"><span>' + escapeHtml(x.name || '') + '<span class="tag" style="background:rgba(150,130,160,.16);color:#6b6478">暂无可匹配成分</span></span><span>' + st + '</span></li>';
      }).join('') || '<li class="muted tiny">暂无报名</li>';
    }

    window.__eventNames = {};
    parts.forEach((x) => { if (x.matched && x.qq) window.__eventNames[x.qq] = x.member_name || x.name || x.qq; });
    matchedCount = (p.matched_qqs || []).length;
    if ($('eventSplitHint')) {
      $('eventSplitHint').textContent = matchedCount > 1
        ? '已读取 ' + matchedCount + ' 位群友的成分，可生成分房建议。' + (parts.length > matchedCount ? '另有 ' + (parts.length - matchedCount) + ' 位暂无可匹配成分，不参与自动分房。' : '')
        : '可匹配的群友不足 2 人。请确认报名者已建立成分，并关联同一个看板账号。';
    }
    if ((p.rooms || []).length) {
      eventRoomsState = p.rooms;
      $('eventRoomsTitle').textContent = '看板现有分房';
      renderRooms(p.rooms);
    } else if ($('eventRooms')) $('eventRooms').innerHTML = '';

  }

  function renderRooms(rooms) {
    const box = $('eventRooms');
    if (!box) return;
    eventRoomsState = rooms || [];
    $('eventResults').hidden = !eventRoomsState.length;
    syncEventActions();
    if (!rooms.length) { box.innerHTML = '<p class="muted tiny">还没有分房结果。</p>'; return; }
    box.innerHTML = rooms.map((r, i) => {
      const members = (r.members || []).map((m) => {
        const on = eventPick && String(eventPick) === String(m.qq);
        return '<button type="button" class="event-badge off event-mem' + (on ? ' on' : '') + '" data-qq="' + escapeHtml(m.qq) + '">'
          + escapeHtml(m.name || m.qq)
          + (m.avg == null ? '' : ' <b style="font-weight:800">' + m.avg + '</b>')
          + '</button>';
      }).join('');
      const common = (r.common || []).map((c) => escapeHtml(c.text)).join('、');
      return '<div class="event-room' + (eventPick ? ' picking' : '') + '" data-room="' + i + '"><h4>' + escapeHtml(r.name || ('包房 ' + (i + 1))) + ' <span class="muted tiny">' + (r.members || []).length + ' 人</span></h4>'
        + '<div class="event-badges" style="margin:0 0 6px">' + members + '</div>'
        + '<div class="room-scoreline event-room-meta">平均 ' + (r.avg == null ? '—' : r.avg)
        + ' · 最高 ' + (r.memberMax == null ? '—' : r.memberMax)
        + ' · 最低 ' + (r.memberMin == null ? '—' : r.memberMin) + '</div>'
        + (common ? '<div class="room-scoreline">共同：' + common + '</div>' : '')
        + '</div>';
    }).join('');
  }

  function eventRoomsPayload() {
    return eventRoomsState.map((r) => (r.members || []).map((m) => m.qq));
  }

  async function eventRecalc() {
    if (!eventRoomsState.length || eventBusy || eventLoading) return;
    const revision = loadRevision;
    eventBusy = true;
    syncEventActions();
    try {
      const res = await jpost('/music/api/qgroup/rooms', { rooms: eventRoomsPayload() });
      if (revision !== loadRevision) return;
      eventRoomsState = res.rooms || [];
      $('eventRoomsTitle').textContent = '调整后的分房建议';
      renderRooms(eventRoomsState);
    } catch (e) {
      if (revision === loadRevision) $('eventSplitHint').textContent = e.message || '重算失败';
    } finally {
      eventBusy = false;
      syncEventActions();
    }
  }

  function eventShareImage() {
    const cv = $('eventShareCanvas');
    if (!cv || !eventRoomsState.length) { if ($('eventShareHint')) $('eventShareHint').textContent = '先分房再分享'; return; }
    const w = 1080;
    const pad = 56;
    const roomH = 300;
    const H = 210 + roomH * eventRoomsState.length + 70;
    cv.width = w; cv.height = H;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, w, H);
    g.addColorStop(0, '#ffeef6'); g.addColorStop(.55, '#f2edff'); g.addColorStop(1, '#e9f3ff');
    c.fillStyle = g; c.fillRect(0, 0, w, H);
    const title = ($('eventTitle') && $('eventTitle').textContent) || '包房分配';
    c.fillStyle = '#3a2740';
    c.font = '800 46px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText(title.slice(0, 18), pad, 92);
    c.font = '600 24px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillStyle = '#7a6478';
    const total = eventRoomsState.reduce((n, r) => n + (r.members || []).length, 0);
    c.fillText('共 ' + eventRoomsState.length + ' 间 · ' + total + ' 人 · 按成分匹配度分配', pad, 138);

    eventRoomsState.forEach((r, i) => {
      const y = 180 + i * roomH;
      c.fillStyle = 'rgba(255,255,255,.82)';
      const rr = 26;
      c.beginPath();
      c.moveTo(pad + rr, y); c.arcTo(pad + 940, y, pad + 940, y + roomH - 26, rr);
      c.arcTo(pad + 940, y + roomH - 26, pad, y + roomH - 26, rr);
      c.arcTo(pad, y + roomH - 26, pad, y, rr); c.arcTo(pad, y, pad + 940, y, rr);
      c.closePath(); c.fill();
      c.fillStyle = '#c9366f';
      c.font = '800 30px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText('包房 ' + (i + 1), pad + 28, y + 52);
      c.fillStyle = '#6b5b77';
      c.font = '600 22px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillText((r.members || []).length + ' 人', pad + 150, y + 52);
      c.textAlign = 'right';
      c.fillStyle = '#8a5a7a';
      c.fillText('平均 ' + (r.avg == null ? '—' : r.avg) + '　最高 ' + (r.memberMax == null ? '—' : r.memberMax) + '　最低 ' + (r.memberMin == null ? '—' : r.memberMin), pad + 940 - 28, y + 52);
      c.textAlign = 'left';
      (r.members || []).forEach((m, j) => {
        const col = j % 2, row = Math.floor(j / 2);
        const x = pad + 34 + col * 450;
        const yy = y + 100 + row * 52;
        c.fillStyle = '#4a3a52';
        c.font = '700 26px "PingFang SC","Microsoft YaHei",sans-serif';
        const nm = String(m.name || m.qq || '').slice(0, 10);
        c.fillText(nm, x, yy);
        if (m.avg != null) {
          c.fillStyle = '#c9366f';
          c.fillText(String(m.avg), x + 300, yy);
        }
      });
    });
    c.fillStyle = 'rgba(58,39,64,.55)';
    c.font = '600 20px "PingFang SC","Microsoft YaHei",sans-serif';
    c.fillText('日音成分匹配器 · 按成分相近程度自动分房', pad, H - 34);
    try {
      const url = cv.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = '包房分配.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if ($('eventShareHint')) $('eventShareHint').textContent = '已生成图片，可在下载里查看/转发。';
    } catch (e) {
      if ($('eventShareHint')) $('eventShareHint').textContent = '生成图片失败：' + (e.message || e);
    }
  }

  async function eventMove(qq, target) {
    if (!qq || eventBusy || eventLoading) return;
    const rooms = eventRoomsPayload();
    let from = -1, to = -1;
    rooms.forEach((arr, i) => { if (arr.includes(qq)) from = i; });
    if (target === 'new') {
      rooms.push([qq]);
    } else {
      to = Number(target);
      if (to === from) return;
      rooms[to] = (rooms[to] || []).concat([qq]);
    }
    if (from >= 0) rooms[from] = rooms[from].filter((x) => x !== qq);
    const cleaned = rooms.filter((arr) => arr.length);
    eventPick = null;
    eventRoomsState = cleaned.map((arr) => ({ members: arr.map((q) => ({ qq: q, name: (window.__eventNames || {})[q] || q })) }));
    renderRooms(eventRoomsState);
    await eventRecalc();
  }

  async function doSplit() {
    if (!currentId || eventBusy || eventLoading || matchedCount < 2) return;
    const hint = $('eventSplitHint');
    const p = eventParams();
    if (p.mode === 'sizes') {
      if (!p.sizes || p.sizes.length < 2) { if (hint) hint.textContent = '先填每间人数，用逗号分隔（例如 8,8,6）'; return; }
    } else if (!p.value || p.value < 1) {
      if (hint) hint.textContent = p.mode === 'capacity' ? '先填每房几个人' : '先填要分几间房';
      return;
    }
    const selectedId = currentId, revision = loadRevision;
    try {
      eventBusy = true;
      syncEventActions();
      if (hint) hint.textContent = '分房中…';
      const body = { event_id: currentId, same_gender: p.same };
      if (p.mode === 'sizes') body.sizes = p.sizes;
      else { body.mode = p.mode; body.value = p.value; }
      const res = await jpost('/music/api/qgroup/split', body);
      if (selectedId !== currentId || revision !== loadRevision) return;
      eventRoomsState = res.rooms || [];
      $('eventRoomsTitle').textContent = '按成分生成的分房建议';
      eventPick = null;
      renderRooms(eventRoomsState);
      saveEventParams();
      if (hint) {
        const how = p.mode === 'sizes' ? '自定义人数 ' + p.sizes.join('/') : (p.mode === 'capacity' ? '每房 ' + p.value + ' 人' : p.value + ' 间房');
        hint.textContent = '已按' + how + '生成分房建议。';
      }
    } catch (e) {
      if (selectedId === currentId && revision === loadRevision && hint) hint.textContent = e.message || '分房失败';
    } finally {
      eventBusy = false;
      syncEventActions();
    }
  }

  function setEventMode(mode, silent) {
    eventMode = mode === 'capacity' ? 'capacity' : (mode === 'sizes' ? 'sizes' : 'rooms');
    document.querySelectorAll('#eventMode .room-mode-btn').forEach((btn) => {
      const on = btn.dataset.mode === eventMode;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if ($('eventValue')) {
      $('eventValue').hidden = eventMode === 'sizes';
      $('eventValue').closest('.event-size-field').hidden = eventMode === 'sizes';
      $('eventValueLabel').textContent = eventMode === 'capacity' ? '每房几人' : '分几间房';
      $('eventValue').setAttribute('aria-label', $('eventValueLabel').textContent);
      $('eventSizesField').hidden = eventMode !== 'sizes';
      if (!silent) $('eventValue').value = eventMode === 'capacity' ? '4' : '2';
    }
    if ($('eventSizes')) $('eventSizes').hidden = eventMode !== 'sizes';
  }

  $('eventRefresh').addEventListener('click', loadEventChoices);
  $('eventSelect').addEventListener('change', () => openEvent($('eventSelect').value));
  document.addEventListener('music:pagechange', e => {
    if (e.detail.page === 'event' && !sourcesLoaded) { sourcesLoaded = true; loadEventChoices(); }
  });
  if ($('eventSplit')) $('eventSplit').addEventListener('click', () => doSplit());
  if ($('eventMode')) $('eventMode').addEventListener('click', (e) => { const btn = e.target.closest('.room-mode-btn'); if (btn) setEventMode(btn.dataset.mode); });
  if ($('eventRooms')) {
    $('eventRooms').addEventListener('click', (e) => {
      if (eventBusy || eventLoading) return;
      const mem = e.target.closest('.event-mem');
      if (mem) {
        eventPick = (eventPick && String(eventPick) === String(mem.dataset.qq)) ? null : mem.dataset.qq;
        renderRooms(eventRoomsState);
        return;
      }
      const room = e.target.closest('.event-room');
      if (room && eventPick) {
        eventMove(eventPick, room.dataset.room);
      }
    });
  }
  if ($('eventShare')) $('eventShare').addEventListener('click', eventShareImage);

})();

/* 性别设置（可选，注册时不填；仅本人可改） */
(() => {
  const gEl = (id) => document.getElementById(id);

  async function gget(path) {
    const r = await fetch(path, { headers: { 'Accept': 'application/json' } });
    const j = window.musicRememberContacts(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  async function gpost(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = window.musicRememberContacts(await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  function gToast(msg) { if (window.__toast) window.__toast(msg); }

  function gMe() {
    try {
      const id = (typeof identity !== 'undefined' && identity) || JSON.parse(localStorage.getItem('jpm.identity') || 'null');
      return (id && id.qq) || '';
    } catch (e) { return ''; }
  }

  function genderText(g) {
    if (!g) return '';
    if (g === 'female') return '女';
    if (g === 'male') return '男';
    return g;
  }

  function paintGender(m) {
    const gender = (m && m.gender) || '';
    const custom = gender && gender !== 'female' && gender !== 'male';
    const pick = gender === 'female' || gender === 'male' ? gender : (custom ? 'custom' : '');
    document.querySelectorAll('input[name="genderPick"]').forEach((r) => { r.checked = (r.value || '') === pick; });
    if (gEl('genderCustom')) {
      gEl('genderCustom').value = custom ? gender : '';
      gEl('genderCustom').hidden = pick !== 'custom';
    }
    if (gEl('genderPublic')) {
      gEl('genderPublic').checked = !!(m && m.genderPublic);
      gEl('genderPublic').disabled = !gender;
    }
    if (gEl('genderHint')) {
      gEl('genderHint').textContent = gender
        ? '当前：' + genderText(gender) + (m && m.genderPublic ? '（已公开）' : '（仅自己可见）')
        : '还没有设置，可以不填';
    }
  }

  async function loadGender() {
    const card = gEl('genderCard');
    if (!card) return;
    const me = gMe();
    if (!me) { card.hidden = true; return; }
    card.hidden = false;
    try {
      const d = await gget('/music/api/me?qq=' + encodeURIComponent(me));
      paintGender((d && d.member) || {});
    } catch (e) { /* 静默 */ }
  }

  async function saveGender() {
    const me = gMe();
    if (!me) return;
    let pick = '';
    document.querySelectorAll('input[name="genderPick"]').forEach((r) => { if (r.checked) pick = r.value; });
    const customText = (gEl('genderCustom') && gEl('genderCustom').value || '').trim().slice(0, 12);
    if (pick === 'custom' && !customText) { gToast('先写一个自定义性别名称', 'err'); return; }
    const gender = pick === 'custom' ? customText : pick;
    const pub = !!(gEl('genderPublic') && gEl('genderPublic').checked) && !!gender;
    try {
      await gpost('/music/api/gender', { qq: me, gender: pick === 'custom' ? 'custom' : gender, genderCustom: customText, genderPublic: pub });
      gToast(gender ? '性别设置已保存' : '已设为保密', 'ok');
      paintGender({ gender, genderPublic: pub });
      if (pub) toast('已公开：匹配卡会显示性别，分房可按同性别优先', 'ok');
      if (window.__genderChanged) window.__genderChanged();
    } catch (e) {
      gToast(e.message || '保存失败', 'err');
    }
  }

  if (gEl('genderSave')) gEl('genderSave').addEventListener('click', saveGender);
  document.querySelectorAll('input[name="genderPick"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (gEl('genderPublic')) gEl('genderPublic').disabled = !r.value;
    });
  });
  if (gEl('genderPublic')) {
    gEl('genderPublic').addEventListener('change', (e) => {
      if (e.target.checked) toast('记得点「保存性别设置」', 'ok');
    });
  }
  document.addEventListener('music:pagechange', (e) => {
    if (e.detail.page === 'mine') loadGender();
  });
  setTimeout(loadGender, 2600);
  window.__loadGender = loadGender;
})();
