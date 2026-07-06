// dashboard.js — full-page view over everything the extension has captured.
// Reads tse_posts / tse_feed_posts / tse_profile_posts straight from
// chrome.storage.local and live-updates while a grab is running.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (k, subs) => TSEI18n.t(k, subs);

  let all = [];     // unified posts, each tagged with _source
  let view = [];    // filtered + sorted

  const state = {
    source: 'all',           // all | saved | feed | profile (single: it's a scope)
    // facet filters are multi-select: OR within a facet, AND across facets;
    // an empty set means "no filter"
    feeds: new Set(),        // feed names
    handles: new Set(),      // profile handles ('@x')
    sections: new Set(),     // 'threads' | 'replies'
    authors: new Set(),      // author handles ('@x')
    media: 'all',    // all | media | text
    minReplies: 0,
    dateFrom: '',    // YYYY-MM-DD, on takenAt
    dateTo: '',
    q: '',
    sort: 'capture',
  };

  const SRC = {
    saved: { labelKey: 'nav_saved', order: 0 },
    feed: { labelKey: 'nav_feeds', order: 1 },
    profile: { labelKey: 'nav_profiles', order: 2 },
  };

  // ---- data ----

  async function loadPosts() {
    const got = await chrome.storage.local.get(['tse_posts', 'tse_feed_posts', 'tse_profile_posts']);
    const tag = (obj, src) =>
      Object.values(obj || {}).map((p) => Object.assign({}, p, { _source: src }));
    all = tag(got.tse_posts, 'saved')
      .concat(tag(got.tse_feed_posts, 'feed'))
      .concat(tag(got.tse_profile_posts, 'profile'));
  }

  async function loadLive() {
    const got = await chrome.storage.local.get(['tse_state', 'tse_feed_state', 'tse_profile_state']);
    const s = got.tse_state || {};
    const f = got.tse_feed_state || {};
    const p = got.tse_profile_state || {};
    const busy = !!s.grabbing || !!f.running || !!p.running;
    $('liveDot').classList.toggle('live', busy);
    $('liveText').textContent = f.running
      ? t('live_feeds', { p: (f.queue || []).length ? (f.index || 0) + 1 + '/' + f.queue.length : '…' })
      : p.running
        ? t('live_profile', { h: p.target || '?', stage: t(p.stage === 'replies' ? 'stage_replies' : 'stage_threads') })
        : s.grabbing
          ? t('live_saved')
          : t('live_idle');
  }

  // ---- filtering + sorting ----

  const orderOf = (p) => (p.savedOrder != null ? p.savedOrder
    : p.feedOrder != null ? p.feedOrder : p.profileOrder);

  function captureCmp(a, b) {
    const s = SRC[a._source].order - SRC[b._source].order;
    if (s) return s;
    const ah = a.profileHandle || '', bh = b.profileHandle || '';
    if (ah !== bh) return ah < bh ? -1 : 1;
    const grp = ((a.feedIndex != null ? a.feedIndex : a.sectionIndex) || 0)
      - ((b.feedIndex != null ? b.feedIndex : b.sectionIndex) || 0);
    if (grp) return grp;
    const ao = orderOf(a), bo = orderOf(b);
    if (ao != null && bo != null) return ao - bo;
    if (ao != null) return -1;
    if (bo != null) return 1;
    return String(b.takenAt || '').localeCompare(String(a.takenAt || ''));
  }

  function inScope(p) { // source + facet filters, not search/media/author
    if (state.source !== 'all' && p._source !== state.source) return false;
    if (state.feeds.size && !state.feeds.has(p.feed)) return false;
    if (state.handles.size && !state.handles.has(p.profileHandle)) return false;
    if (state.sections.size && !state.sections.has(p.section)) return false;
    return true;
  }

  let unknownReplyHidden = 0; // filtered out for lacking replyCount (pre-0.8.6 captures)

  function applyFilters() {
    const q = state.q.trim().toLowerCase();
    unknownReplyHidden = 0;
    view = all.filter((p) => {
      if (!inScope(p)) return false;
      if (state.authors.size && !(p.author && state.authors.has(p.author.handle))) return false;
      const hasMedia = p.media && p.media.length;
      if (state.media === 'media' && !hasMedia) return false;
      if (state.media === 'text' && hasMedia) return false;
      if (state.dateFrom || state.dateTo) {
        const d = (p.takenAt || '').slice(0, 10); // ISO dates compare as strings
        if (!d) return false;
        if (state.dateFrom && d < state.dateFrom) return false;
        if (state.dateTo && d > state.dateTo) return false;
      }
      if (q) {
        const hay = [
          p.text || '',
          (p.author && p.author.handle) || '',
          (p.author && p.author.name) || '',
          p.feed || '',
          p.profileHandle || '',
          (p.replyTo && p.replyTo.text) || '',
        ].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // last, so the "hidden for missing data" tally only counts posts that
      // passed every other filter
      if (state.minReplies) {
        if (p.replyCount == null) { unknownReplyHidden++; return false; }
        if (p.replyCount < state.minReplies) return false;
      }
      return true;
    });
    if (state.sort === 'capture') view.sort(captureCmp);
    else if (state.sort === 'new') view.sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')));
    else if (state.sort === 'old') view.sort((a, b) => String(a.takenAt || '').localeCompare(String(b.takenAt || '')));
    else if (state.sort === 'likes') view.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
    else if (state.sort === 'replies') view.sort((a, b) => (b.replyCount || 0) - (a.replyCount || 0));
  }

  // ---- sidebar facets ----

  function chip(label, count, active, onClick, title) {
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' active' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = label;
    if (title || label) nm.title = title || label;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = count != null ? String(count) : '';
    b.append(nm, n);
    b.addEventListener('click', onClick);
    return b;
  }

  function tally(posts, keyFn) {
    const m = new Map();
    for (const p of posts) {
      const k = keyFn(p);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderSidebar() {
    // source nav
    const nav = $('sourceNav');
    nav.textContent = '';
    const counts = { saved: 0, feed: 0, profile: 0 };
    for (const p of all) counts[p._source]++;
    const rows = [['all', t('nav_all'), all.length]]
      .concat(Object.keys(SRC).map((k) => [k, t(SRC[k].labelKey), counts[k]]));
    for (const [key, label, n] of rows) {
      nav.appendChild(chip(label, n, state.source === key, () => {
        state.source = key;
        // facets tied to another source no longer apply
        state.feeds.clear(); state.handles.clear(); state.sections.clear();
        update();
      }));
    }

    // feed facet
    const feedPosts = all.filter((p) => p._source === 'feed');
    const showFeeds = feedPosts.length && (state.source === 'all' || state.source === 'feed');
    $('feedFacet').hidden = !showFeeds;
    if (showFeeds) {
      const box = $('feedChips');
      box.textContent = '';
      for (const [name, n] of tally(feedPosts, (p) => p.feed)) {
        box.appendChild(chip(name, n, state.feeds.has(name), () => {
          if (state.feeds.has(name)) state.feeds.delete(name); else state.feeds.add(name);
          update();
        }));
      }
      $('feedFacetClear').hidden = !state.feeds.size;
      $('feedFacetClear').onclick = () => { state.feeds.clear(); update(); };
    }

    // profile facet
    const profPosts = all.filter((p) => p._source === 'profile');
    const showProf = profPosts.length && (state.source === 'all' || state.source === 'profile');
    $('profFacet').hidden = !showProf;
    if (showProf) {
      const box = $('profChips');
      box.textContent = '';
      for (const [h, n] of tally(profPosts, (p) => p.profileHandle)) {
        box.appendChild(chip(h, n, state.handles.has(h), () => {
          if (state.handles.has(h)) state.handles.delete(h); else state.handles.add(h);
          update();
        }));
      }
      const inHandle = state.handles.size
        ? profPosts.filter((p) => state.handles.has(p.profileHandle)) : profPosts;
      const sbox = $('sectionChips');
      sbox.textContent = '';
      for (const sec of ['threads', 'replies']) {
        const n = inHandle.filter((p) => p.section === sec).length;
        if (!n) continue;
        sbox.appendChild(chip(t(sec === 'replies' ? 'chip_replies' : 'chip_threads'), n, state.sections.has(sec), () => {
          if (state.sections.has(sec)) state.sections.delete(sec); else state.sections.add(sec);
          update();
        }));
      }
      $('profFacetClear').hidden = !state.handles.size && !state.sections.size;
      $('profFacetClear').onclick = () => { state.handles.clear(); state.sections.clear(); update(); };
    }

    // top authors (within the current scope, ignoring the author filter itself)
    const scoped = all.filter(inScope);
    const authors = tally(scoped, (p) => p.author && p.author.handle).slice(0, 12);
    const showAuthors = authors.length > 1 || state.authors.size;
    $('authorFacet').hidden = !showAuthors;
    if (showAuthors) {
      const box = $('authorChips');
      box.textContent = '';
      for (const sel of state.authors) {
        if (!authors.some(([h]) => h === sel)) {
          authors.unshift([sel, scoped.filter((p) => p.author && p.author.handle === sel).length]);
        }
      }
      for (const [h, n] of authors) {
        box.appendChild(chip(h, n, state.authors.has(h), () => {
          if (state.authors.has(h)) state.authors.delete(h); else state.authors.add(h);
          update();
        }));
      }
      $('authorFacetClear').hidden = !state.authors.size;
      $('authorFacetClear').onclick = () => { state.authors.clear(); update(); };
    }
  }

  // ---- cards ----

  const fmtN = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k'
    : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

  function isVideo(url) {
    try { return /\.mp4($|\?)/.test(new URL(url).pathname + '?'); } catch (_) { return /\.mp4/.test(url); }
  }

  function mediaEl(url, postUrl) {
    if (isVideo(url)) {
      // the signed video URLs won't play outside Threads' own player —
      // show a placeholder that jumps to the post instead
      const ph = document.createElement('div');
      ph.className = 'mediaVideo';
      ph.title = t('title_video_tile');
      const play = document.createElement('span');
      play.className = 'play';
      play.textContent = '▶';
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = t('video_tile');
      ph.append(play, lbl);
      if (postUrl) ph.addEventListener('click', () => window.open(postUrl, '_blank'));
      return ph;
    }
    const el = document.createElement('img');
    el.src = url;
    el.loading = 'lazy';
    el.decoding = 'async'; // never decode on the scroll-critical path
    el.addEventListener('click', () => window.open(url, '_blank'));
    el.addEventListener('error', () => {
      const dead = document.createElement('div');
      dead.className = 'mediaDead';
      dead.textContent = t('media_expired');
      el.replaceWith(dead);
    }, { once: true });
    return el;
  }

  function mediaGrid(urls, postUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'mediaWrap' + (urls.length === 1 ? ' single' : '');
    const shown = urls.slice(0, 4);
    shown.forEach((u, i) => {
      const el = mediaEl(u, postUrl);
      if (i === 3 && urls.length > 4) {
        const more = document.createElement('div');
        more.className = 'mediaMore';
        more.dataset.more = '+' + (urls.length - 4);
        more.appendChild(el);
        wrap.appendChild(more);
      } else {
        wrap.appendChild(el);
      }
    });
    return wrap;
  }

  // "more" links are added in one batched read-then-write pass per frame: a
  // per-card rAF that reads scrollHeight and then mutates the DOM forces a
  // fresh layout per card, which was the main source of scroll jank.
  let clampQueue = [];
  let clampScheduled = false;
  function queueClampCheck(txtEl) { // NB: not "t" — that's the i18n helper
    clampQueue.push(txtEl);
    if (clampScheduled) return;
    clampScheduled = true;
    requestAnimationFrame(() => {
      clampScheduled = false;
      const q = clampQueue;
      clampQueue = [];
      const ready = [];
      for (const el of q) {
        if (!el.isConnected) continue;
        const host = el.closest('.card');
        if (host && host.__cvSkipped) {
          // no layout inside a skipped card — re-check when it renders
          (host.__clampPending || (host.__clampPending = [])).push(el);
          continue;
        }
        ready.push(el);
      }
      const cut = ready.filter((el) => el.scrollHeight > el.clientHeight + 2); // reads
      for (const el of cut) { // writes
        const more = document.createElement('span');
        more.className = 'more';
        more.textContent = t('more');
        more.addEventListener('click', () => {
          const open = el.classList.toggle('clamp');
          more.textContent = t(open ? 'more' : 'less');
          scheduleMeasure(true); // card height changed — keep the virtual layout honest
        });
        el.after(more);
      }
    });
  }

  function textBlock(text) {
    const frag = document.createDocumentFragment();
    const t = document.createElement('div');
    t.className = 'txt clamp';
    t.textContent = text;
    frag.appendChild(t);
    queueClampCheck(t);
    return frag;
  }

  function badgeFor(p) {
    const b = document.createElement('span');
    b.className = 'badge ' + p._source;
    b.textContent = p._source === 'feed' ? (p.feed || 'feed')
      : p._source === 'profile' ? t(p.section === 'replies' ? 'badge_reply' : 'badge_thread')
        : t('badge_saved');
    b.title = p._source === 'profile' ? `${p.profileHandle || ''} · ${p.section}` : b.textContent;
    return b;
  }

  function card(p) {
    const c = document.createElement('article');
    c.className = 'card';
    // content-visibility: auto — while skipped, offsetHeight is only the
    // intrinsic-size placeholder, so flag the state and measure the row once
    // the card has actually rendered.
    c.__cvSkipped = true;
    c.addEventListener('contentvisibilityautostatechange', (e) => {
      c.__cvSkipped = e.skipped;
      if (e.skipped) return;
      scheduleMeasure();
      if (c.__clampPending) {
        const pending = c.__clampPending;
        c.__clampPending = null;
        pending.forEach(queueClampCheck);
      }
    });

    const hd = document.createElement('div');
    hd.className = 'hd';
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = (p.author && p.author.handle) || '@unknown';
    handle.title = t('title_filter_author');
    handle.addEventListener('click', () => {
      const h = handle.textContent;
      if (state.authors.has(h)) state.authors.delete(h); else state.authors.add(h);
      update();
    });
    hd.appendChild(handle);
    if (p.author && p.author.name) {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.author.name;
      hd.appendChild(name);
    }
    hd.appendChild(badgeFor(p));
    c.appendChild(hd);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    if (p.takenAt) bits.push(p.takenAt.slice(0, 10));
    if (p.likeCount != null) bits.push('♥ ' + fmtN(p.likeCount));
    if (p.replyCount != null) bits.push('💬 ' + fmtN(p.replyCount));
    const ord = orderOf(p);
    if (ord != null) bits.push('#' + ord);
    meta.append(bits.join(' · '));
    if (p.url) {
      meta.append(' · ');
      const a = document.createElement('a');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = t('open_post');
      meta.appendChild(a);
    }
    c.appendChild(meta);

    if (p.replyTo) {
      const q = document.createElement('div');
      q.className = 'quote';
      const qhd = document.createElement('div');
      qhd.className = 'qhd';
      const who = document.createElement('b');
      who.textContent = (p.replyTo.author && p.replyTo.author.handle) || '@unknown';
      qhd.append(t('replying_to'), who);
      if (p.replyTo.takenAt) qhd.append(' · ' + p.replyTo.takenAt.slice(0, 10));
      if (p.replyTo.url) {
        qhd.append(' · ');
        const a = document.createElement('a');
        a.href = p.replyTo.url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = t('open_post');
        qhd.appendChild(a);
      }
      q.appendChild(qhd);
      if (p.replyTo.text) q.appendChild(textBlock(p.replyTo.text));
      if (p.replyTo.media && p.replyTo.media.length) q.appendChild(mediaGrid(p.replyTo.media, p.replyTo.url));
      c.appendChild(q);
    }

    if (p.text) c.appendChild(textBlock(p.text));
    if (p.media && p.media.length) c.appendChild(mediaGrid(p.media, p.url));
    return c;
  }

  // ---- virtualized rendering ----
  // Only the rows near the viewport exist in the DOM. The space above and
  // below the window is simulated with the grid's own vertical padding, so
  // the scrollbar behaves as if everything were rendered. Row heights start
  // as an estimate and are corrected as rows are measured; cards are kept in
  // an LRU cache so scrolling back reuses the already-built DOM.

  const grid = $('grid');
  const scroller = $('scroller');
  const EST = 340;        // assumed row height until measured
  const OVERSCAN = 900;   // px rendered beyond the viewport on each side
  const GAP = 14;         // must match #grid's CSS gap
  const PAD_TOP = 16;     // must match #grid's base padding
  const PAD_BOTTOM = 60;
  const CACHE_MAX = 500;  // detached cards kept for reuse

  let cols = 1;
  let rowHeights = [];    // measured grid row heights by row index
  let winStart = -1;      // rendered row window (inclusive)
  let winEnd = -1;
  const cardCache = new Map(); // post key -> card element, LRU order

  const keyOf = (p) =>
    p._source + '|' + (p.feed || p.profileHandle || '') + '|' + (p.section || '') + '|' + p.id;

  const rowH = (r) => rowHeights[r] || EST;
  const rowCount = () => Math.ceil(view.length / cols);

  function readCols() {
    const t = getComputedStyle(grid).gridTemplateColumns;
    cols = t && t !== 'none' ? t.split(' ').length : 1;
  }

  function cardFor(i) {
    const p = view[i];
    const k = keyOf(p);
    let el = cardCache.get(k);
    if (el) cardCache.delete(k); // re-insert below = LRU bump
    else el = card(p);
    cardCache.set(k, el);
    el.dataset.idx = i;
    return el;
  }

  function pruneCache() {
    for (const k of cardCache.keys()) {
      if (cardCache.size <= CACHE_MAX) break;
      if (!cardCache.get(k).isConnected) cardCache.delete(k);
    }
  }

  function updatePads() {
    const R = rowCount();
    let top = 0;
    for (let r = 0; r < winStart; r++) top += rowH(r) + GAP;
    let bottom = 0;
    for (let r = winEnd + 1; r < R; r++) bottom += rowH(r) + GAP;
    grid.style.paddingTop = PAD_TOP + top + 'px';
    grid.style.paddingBottom = PAD_BOTTOM + bottom + 'px';
  }

  function measure(force) {
    // grid row track height = tallest card in the row (align-items: start).
    // Rows keep their measured height, so most scroll steps read no layout at
    // all; `force` re-measures everything (e.g. after expanding a post's text).
    const maxes = new Map();
    for (const el of grid.children) {
      if (el.dataset.idx == null || el.__cvSkipped) continue;
      const r = Math.floor(el.dataset.idx / cols);
      if (!force && rowHeights[r]) continue;
      maxes.set(r, Math.max(maxes.get(r) || 0, el.offsetHeight));
    }
    let changed = false;
    for (const [r, h] of maxes) {
      if (h && rowHeights[r] !== h) { rowHeights[r] = h; changed = true; }
    }
    if (changed) updatePads();
  }

  let measureQueued = false;
  let measureForce = false;
  function scheduleMeasure(force) {
    measureForce = measureForce || !!force;
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      const f = measureForce;
      measureForce = false;
      measure(f);
    });
  }

  function fragFor(from, to) {
    const frag = document.createDocumentFragment();
    for (let i = from; i < Math.min(view.length, to); i++) frag.appendChild(cardFor(i));
    return frag;
  }

  function renderWindow(s, e) {
    // Diff against the current window: during scrolling it shifts by a row at
    // a time, so touching only the edges (instead of rebuilding all ~30
    // cards) is what keeps frames under budget.
    const overlaps = winStart !== -1 && s <= winEnd && e >= winStart && grid.firstChild;
    if (!overlaps) {
      grid.textContent = '';
      grid.appendChild(fragFor(s * cols, (e + 1) * cols));
    } else {
      while (grid.firstChild && +grid.firstChild.dataset.idx < s * cols) {
        grid.removeChild(grid.firstChild);
      }
      while (grid.lastChild && +grid.lastChild.dataset.idx >= (e + 1) * cols) {
        grid.removeChild(grid.lastChild);
      }
      if (s < winStart) grid.insertBefore(fragFor(s * cols, winStart * cols), grid.firstChild);
      if (e > winEnd) grid.appendChild(fragFor(Math.max(s, winEnd + 1) * cols, (e + 1) * cols));
    }
    winStart = s;
    winEnd = e;
    pruneCache();
    updatePads();
    scheduleMeasure();
  }

  function layout() {
    if (!view.length) return;
    const R = rowCount();
    // grid top in scroller coordinates (its rect ignores our virtual padding)
    const gridTop = grid.getBoundingClientRect().top
      + scroller.scrollTop - scroller.getBoundingClientRect().top + PAD_TOP;
    const y0 = scroller.scrollTop - OVERSCAN - gridTop;
    const y1 = scroller.scrollTop + scroller.clientHeight + OVERSCAN - gridTop;
    let acc = 0, s = -1, e = R - 1;
    for (let r = 0; r < R; r++) {
      const bottom = acc + rowH(r);
      if (s === -1 && bottom > y0) s = r;
      if (acc > y1) { e = r - 1; break; }
      acc = bottom + GAP;
    }
    if (s === -1) s = R - 1;
    if (e < s) e = s;
    if (s !== winStart || e !== winEnd) renderWindow(s, e);
  }

  let scrollQueued = false;
  scroller.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; layout(); });
  }, { passive: true });

  let lastWidth = 0;
  let resizeQueued = false;
  new ResizeObserver((entries) => {
    const w = entries[entries.length - 1].contentRect.width;
    if (w === lastWidth) return; // our own padding changes also fire the RO
    lastWidth = w;
    if (resizeQueued) return;
    resizeQueued = true;
    // defer: mutating layout inside the RO callback re-triggers it in the
    // same frame ("ResizeObserver loop completed with undelivered notifications")
    requestAnimationFrame(() => {
      resizeQueued = false;
      readCols();
      rowHeights = []; // card heights depend on column width
      winStart = winEnd = -1;
      layout();
    });
  }).observe(grid);

  function renderAll() {
    winStart = winEnd = -1;
    rowHeights = []; // filters/sort moved posts to different rows
    readCols();
    grid.textContent = '';
    grid.style.paddingTop = PAD_TOP + 'px';
    grid.style.paddingBottom = PAD_BOTTOM + 'px';
    if (!view.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = all.length ? t('empty_no_match') : t('empty_no_capture');
      grid.appendChild(e);
    } else {
      layout();
    }
    const parts = [t('shown_posts', { n: view.length.toLocaleString() })];
    if (view.length !== all.length) parts.push(t('shown_of', { n: all.length.toLocaleString() }));
    if (unknownReplyHidden) {
      parts.push(t('shown_hidden_replies', { n: unknownReplyHidden.toLocaleString() }));
    }
    $('shown').textContent = parts.join(' ');
    const has = view.length > 0;
    $('expJson').disabled = $('expCsv').disabled = $('expMd').disabled = !has;
  }

  // Filter changes jump back to the top; live data reloads keep the position.
  function update(keepScroll) {
    applyFilters();
    renderSidebar();
    if (!keepScroll) scroller.scrollTop = 0;
    renderAll();
  }

  // ---- exports (reuse lib/export.js on the filtered view) ----

  function download(text, mime, ext) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download(
      { url, filename: `threads-dashboard-${stamp}.${ext}`, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 60000)
    );
  }

  // CSV/MD columns depend on the shape: single-source views get that source's
  // richer layout, mixed views fall back to the generic (saved) one.
  const exportKind = () =>
    state.source === 'feed' ? 'feed' : state.source === 'profile' ? 'profile' : undefined;

  $('expJson').addEventListener('click', () => download(TSEExport.toJSON(view), 'application/json', 'json'));
  $('expCsv').addEventListener('click', () => download(TSEExport.toCSV(view, exportKind()), 'text/csv', 'csv'));
  $('expMd').addEventListener('click', () => download(TSEExport.toMarkdown(view, exportKind()), 'text/markdown', 'md'));

  // ---- import: restore posts from earlier JSON exports ----

  $('impBtn').addEventListener('click', () => $('impFile').click());
  $('impFile').addEventListener('change', async () => {
    const files = [...$('impFile').files];
    $('impFile').value = '';
    if (!files.length) return;
    let posts = [];
    let badFiles = 0;
    for (const f of files) {
      try {
        const j = JSON.parse(await f.text());
        if (Array.isArray(j)) {
          posts = posts.concat(j);
        } else if (j && typeof j === 'object') {
          // tolerate raw storage dumps: {tse_posts: {id: post, …}, …}
          for (const v of Object.values(j)) {
            if (Array.isArray(v)) posts = posts.concat(v);
            else if (v && typeof v === 'object') posts = posts.concat(Object.values(v));
          }
        }
      } catch (_) { badFiles++; }
    }
    posts = posts.filter((p) => p && typeof p === 'object' && p.id);
    if (!posts.length) {
      $('impNote').textContent = badFiles ? t('imp_unreadable') : t('imp_none');
      return;
    }
    $('impNote').textContent = t('imp_importing', { n: posts.length.toLocaleString() });
    let added = 0, skipped = 0;
    for (let i = 0; i < posts.length; i += 1000) {
      const r = await chrome.runtime.sendMessage({
        type: 'IMPORT_POSTS', posts: posts.slice(i, i + 1000),
      }).catch(() => null);
      if (r && r.ok) { added += r.added; skipped += r.skipped; }
    }
    $('impNote').textContent =
      t('imp_done', { n: added.toLocaleString() }) +
      (skipped ? t('imp_dupes', { n: skipped.toLocaleString() }) : '') +
      (badFiles ? t('imp_badfiles', { n: badFiles }) : '');
    await loadPosts();
    update(true);
  });

  // ---- controls ----

  let qTimer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = $('q').value; update(); }, 150);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('q')) {
      e.preventDefault();
      $('q').focus();
      $('q').select();
    }
  });
  $('mediaSel').addEventListener('change', () => { state.media = $('mediaSel').value; update(); });
  $('replySel').addEventListener('change', () => { state.minReplies = parseInt($('replySel').value, 10) || 0; update(); });
  function onDateChange() {
    state.dateFrom = $('dateFrom').value;
    state.dateTo = $('dateTo').value;
    $('dateClear').hidden = !state.dateFrom && !state.dateTo;
    update();
  }
  $('dateFrom').addEventListener('change', onDateChange);
  $('dateTo').addEventListener('change', onDateChange);
  $('dateClear').addEventListener('click', () => {
    $('dateFrom').value = '';
    $('dateTo').value = '';
    onDateChange();
  });
  $('sortSel').addEventListener('change', () => { state.sort = $('sortSel').value; update(); });
  $('layGrid').addEventListener('click', () => setLayout('grid'));
  $('layList').addEventListener('click', () => setLayout('list'));
  $('layCompact').addEventListener('click', () => setLayout('compact'));
  function setLayout(l) {
    grid.classList.toggle('list', l === 'list');
    grid.classList.toggle('compact', l === 'compact');
    $('layGrid').classList.toggle('active', l === 'grid');
    $('layList').classList.toggle('active', l === 'list');
    $('layCompact').classList.toggle('active', l === 'compact');
    try { localStorage.setItem('tse_dash_layout', l); } catch (_) {}
    update(); // column count changed — rebuild the virtual layout
  }

  // ---- live updates while a grab runs ----

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tse_state || changes.tse_feed_state || changes.tse_profile_state) loadLive();
    if (changes.tse_posts || changes.tse_feed_posts || changes.tse_profile_posts) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        await loadPosts();
        update(true);
      }, 800);
    }
  });

  // ---- language ----

  $('langSel').addEventListener('change', () => {
    TSEI18n.setLang($('langSel').value).then(() => location.reload());
  });

  // ---- init ----

  (async () => {
    await TSEI18n.init();
    TSEI18n.apply();
    try {
      const got = await chrome.storage.local.get('tse_lang');
      $('langSel').value = got.tse_lang || 'auto';
    } catch (_) {}
    try { setLayout(localStorage.getItem('tse_dash_layout') || 'grid'); } catch (_) {}
    await Promise.all([loadPosts(), loadLive()]);
    update();
  })();
})();
