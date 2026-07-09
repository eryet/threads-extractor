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
    metric: 'replyCount',  // engagement filter: replyCount | likeCount | repostCount | shareCount
    minMetric: 0,
    dateFrom: '',    // YYYY-MM-DD, on takenAt
    dateTo: '',
    q: '',
    sort: 'capture',
  };

  const SRC = {
    saved: { labelKey: 'nav_saved', order: 0 },
    liked: { labelKey: 'nav_liked', order: 1 },
    feed: { labelKey: 'nav_feeds', order: 2 },
    profile: { labelKey: 'nav_profiles', order: 3 },
  };

  // ---- data ----

  async function loadPosts() {
    const got = await chrome.storage.local.get(['tse_posts', 'tse_liked_posts', 'tse_feed_posts', 'tse_profile_posts']);
    // _key = the post's storage key, so "delete shown" can address it exactly
    const tag = (obj, src) =>
      Object.entries(obj || {}).map(([k, p]) => Object.assign({}, p, { _source: src, _key: k }));
    all = tag(got.tse_posts, 'saved')
      .concat(tag(got.tse_liked_posts, 'liked'))
      .concat(tag(got.tse_feed_posts, 'feed'))
      .concat(tag(got.tse_profile_posts, 'profile'));

    // drop filter selections whose data is gone (deleted / cleared), so the
    // view doesn't strand the user on an empty result
    const feedsNow = new Set(), handlesNow = new Set(), authorsNow = new Set();
    for (const p of all) {
      if (p.feed) feedsNow.add(p.feed);
      if (p.profileHandle) handlesNow.add(p.profileHandle);
      if (p.author && p.author.handle) authorsNow.add(p.author.handle);
    }
    for (const f of [...state.feeds]) if (!feedsNow.has(f)) state.feeds.delete(f);
    for (const h of [...state.handles]) if (!handlesNow.has(h)) state.handles.delete(h);
    for (const a of [...state.authors]) if (!authorsNow.has(a)) state.authors.delete(a);
    if (state.source !== 'all' && !all.some((p) => p._source === state.source)) state.source = 'all';
  }

  async function loadLive() {
    const got = await chrome.storage.local.get(['tse_state', 'tse_liked_state', 'tse_feed_state', 'tse_profile_state']);
    const s = got.tse_state || {};
    const lk = got.tse_liked_state || {};
    const f = got.tse_feed_state || {};
    const p = got.tse_profile_state || {};
    const busy = !!s.grabbing || !!lk.grabbing || !!f.running || !!p.running;
    $('liveDot').classList.toggle('live', busy);
    $('liveText').textContent = f.running
      ? t('live_feeds', { p: (f.queue || []).length ? (f.index || 0) + 1 + '/' + f.queue.length : '…' })
      : p.running
        ? t('live_profile', { h: p.target || '?', stage: t(p.stage === 'replies' ? 'stage_replies' : 'stage_threads') })
        : lk.grabbing
          ? t('live_liked')
          : s.grabbing
            ? t('live_saved')
            : t('live_idle');
  }

  async function loadStorage() {
    let bytes = 0;
    try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) { return; }
    const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
    const pct = Math.min(1, bytes / quota);
    const full = pct >= 0.97;
    const warn = !full && pct >= 0.8;
    const sec = $('storeSec');
    sec.hidden = false;
    sec.classList.toggle('warn', warn);
    sec.classList.toggle('full', full);
    $('storeFill').style.width = Math.max(1, Math.round(pct * 100)) + '%';
    $('storeTxt').textContent = t('storage_used', {
      used: (bytes / 1048576).toFixed(1),
      quota: Math.round(quota / 1048576),
    });
    const hint = $('storeHint');
    hint.hidden = !(warn || full);
    if (warn || full) hint.textContent = t(full ? 'storage_full' : 'storage_low');
  }

  // ---- filtering + sorting ----

  const orderOf = (p) => (p.savedOrder != null ? p.savedOrder
    : p.likedOrder != null ? p.likedOrder
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

  let unknownMetricHidden = 0; // filtered out for lacking the metric (older captures)

  function applyFilters() {
    const q = state.q.trim().toLowerCase();
    unknownMetricHidden = 0;
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
      if (state.minMetric) {
        const v = p[state.metric];
        if (v == null) { unknownMetricHidden++; return false; }
        if (v < state.minMetric) return false;
      }
      return true;
    });
    if (state.sort === 'capture') view.sort(captureCmp);
    else if (state.sort === 'capture_desc') view.sort((a, b) => captureCmp(b, a));
    else if (state.sort === 'new') view.sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')));
    else if (state.sort === 'old') view.sort((a, b) => String(a.takenAt || '').localeCompare(String(b.takenAt || '')));
    else {
      const m = /^(likes|replies|reposts|shares)(_asc)?$/.exec(state.sort);
      if (m) {
        const key = { likes: 'likeCount', replies: 'replyCount', reposts: 'repostCount', shares: 'shareCount' }[m[1]];
        const dir = m[2] ? 1 : -1;
        view.sort((a, b) => dir * ((a[key] || 0) - (b[key] || 0)));
      }
    }
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
    const counts = { saved: 0, liked: 0, feed: 0, profile: 0 };
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
      $('feedFacetClear').onclick = (e) => { e.preventDefault(); state.feeds.clear(); update(); };
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
      $('profFacetClear').onclick = (e) => { e.preventDefault(); state.handles.clear(); state.sections.clear(); update(); };
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
      $('authorFacetClear').onclick = (e) => { e.preventDefault(); state.authors.clear(); update(); };
    }
  }

  // ---- cards ----

  const fmtN = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k'
    : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

  function isVideo(url) {
    try { return /\.mp4($|\?)/.test(new URL(url).pathname + '?'); } catch (_) { return /\.mp4/.test(url); }
  }

  // Lazy image loading, replacing native loading="lazy": Chrome's lazy
  // threshold is ~3000px, so with 900px of virtual-list overscan every
  // rendered card fetched at once and fast scrolls flooded the network and
  // decoder. Instead: fetch only within 600px of the viewport, at most
  // MAX_LOADS in flight, nearest-first via the observer.
  const MAX_LOADS = 6;
  let activeLoads = 0;
  const loadQueue = [];
  const imgIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      imgIO.unobserve(e.target);
      loadQueue.push(e.target);
    }
    pumpLoads();
  }, { root: document.getElementById('scroller'), rootMargin: '600px 0px' });

  function pumpLoads() {
    while (activeLoads < MAX_LOADS && loadQueue.length) {
      const el = loadQueue.shift();
      if (!el.isConnected) { imgIO.observe(el); continue; } // scrolled out of the window before loading — retry when it's back
      activeLoads++;
      const done = () => { activeLoads--; pumpLoads(); };
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', done, { once: true });
      el.src = el.dataset.src;
    }
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
    el.dataset.src = url;
    el.decoding = 'async'; // never decode on the scroll-critical path
    el.addEventListener('load', () => el.classList.add('ld'), { once: true });
    imgIO.observe(el);
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
        : p._source === 'liked' ? t('badge_liked')
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
    const more = document.createElement('button');
    more.className = 'cardMore';
    more.textContent = '⋯';
    more.title = t('title_post_actions');
    more.addEventListener('click', () => openCardMenu(p, more));
    hd.appendChild(more);
    c.appendChild(hd);

    // footer: date/order · spaced engagement stats · open link — built here,
    // appended after the content so it sits at the bottom of the card
    // Threads-style: badge + date/order sit right under the author line.
    // Compact hides .sub and shows the same info inline in the footer (.fm).
    const whenBits = [];
    if (p.takenAt) whenBits.push(p.takenAt.slice(0, 10));
    const ord = orderOf(p);
    if (ord != null) whenBits.push('#' + ord);
    const whenSpan = () => {
      const w = document.createElement('span');
      w.className = 'when';
      w.textContent = whenBits.join(' · ');
      return w;
    };
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.appendChild(badgeFor(p));
    if (whenBits.length) sub.appendChild(whenSpan());
    c.appendChild(sub);

    const foot = document.createElement('div');
    foot.className = 'foot';
    const fmBadge = badgeFor(p);
    fmBadge.classList.add('fm');
    foot.appendChild(fmBadge);
    if (whenBits.length) {
      const w = whenSpan();
      w.classList.add('fm');
      foot.appendChild(w);
    }
    const stat = (icon, v) => {
      const s = document.createElement('span');
      s.className = 'stat';
      s.textContent = icon + ' ' + fmtN(v);
      foot.appendChild(s);
    };
    if (p.likeCount != null) stat('❤️', p.likeCount);
    if (p.replyCount != null) stat('💬', p.replyCount);
    if (p.repostCount != null) stat('🔁', p.repostCount);
    if (p.shareCount != null) stat('📤', p.shareCount);
    if (p.url) {
      const a = document.createElement('a');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = t('open_post');
      foot.appendChild(a);
    }

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
    if (foot.childNodes.length) c.appendChild(foot);
    if (p.likers && p.likers.length) c.appendChild(engagersBlock(p, 'like'));
    if (p.reposters && p.reposters.length) c.appendChild(engagersBlock(p, 'repost'));
    return c;
  }

  // collapsible "liked/reposted by N" panel; each account links to its profile
  function engagersBlock(p, kind) {
    const K = ENGAGER[kind];
    const users = p[K.field];
    const box = document.createElement('details');
    box.className = 'likers';
    const sum = document.createElement('summary');
    const label = document.createElement('span');
    // Threads lists only accounts onboarded to Threads, so the named accounts
    // are often fewer than the count — show "N of M" and flag it as partial
    const count = p[K.countField];
    const total = (count != null && count > users.length) ? count : null;
    const incomplete = !!total || p[K.partialField];
    label.textContent = (total
      ? t(K.summaryOf, { n: users.length, total })
      : t(K.summary, { n: users.length }))
      + (incomplete ? ' · ' + t('likers_partial') : '');
    if (incomplete) sum.title = t('likers_partial_hint');
    sum.appendChild(label);
    const copy = document.createElement('button');
    copy.className = 'likerCopy';
    copy.textContent = t('likers_copy');
    copy.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await navigator.clipboard.writeText(users.map((u) => u.handle).join('\n')); } catch (_) {}
      copy.textContent = t('menu_copied_text');
      setTimeout(() => { copy.textContent = t('likers_copy'); }, 900);
    });
    sum.appendChild(copy);
    box.appendChild(sum);
    const list = document.createElement('div');
    list.className = 'likerList';
    for (const u of users) {
      const a = document.createElement('a');
      a.className = 'liker';
      a.href = 'https://www.threads.com/' + u.handle;
      a.target = '_blank';
      a.rel = 'noreferrer';
      const h = document.createElement('b');
      h.textContent = u.handle;
      a.appendChild(h);
      if (u.name && u.name !== u.handle) {
        const nm = document.createElement('span');
        nm.textContent = u.name;
        a.appendChild(nm);
      }
      list.appendChild(a);
    }
    box.appendChild(list);
    // expanding/collapsing changes card height — keep the virtual layout honest
    box.addEventListener('toggle', () => scheduleMeasure(true));
    return box;
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
    if (changed) {
      updatePads();
      // rows shorter than EST (compact view) leave the window under-filled;
      // re-layout extends it until the viewport + overscan is covered
      layout();
    }
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
      if (all.length && hasActiveFilters()) {
        const btn = document.createElement('button');
        btn.className = 'emptyReset';
        btn.textContent = t('btn_reset_filters');
        btn.addEventListener('click', resetFilters);
        e.appendChild(document.createElement('br'));
        e.appendChild(btn);
      }
      grid.appendChild(e);
    } else {
      layout();
    }
    const parts = [t('shown_posts', { n: view.length.toLocaleString() })];
    if (view.length !== all.length) parts.push(t('shown_of', { n: all.length.toLocaleString() }));
    if (unknownMetricHidden) {
      parts.push(t('shown_hidden_metric', { n: unknownMetricHidden.toLocaleString() }));
    }
    $('shown').textContent = parts.join(' ');
    $('resetFilters').hidden = !hasActiveFilters();
    const has = view.length > 0;
    $('expJson').disabled = $('expCsv').disabled = $('expMd').disabled = !has;
    $('delShown').disabled = !has;
  }

  // ---- reset all filters ----

  function hasActiveFilters() {
    return state.source !== 'all' || state.feeds.size > 0 || state.handles.size > 0
      || state.sections.size > 0 || state.authors.size > 0 || state.media !== 'all'
      || state.minMetric > 0 || !!state.dateFrom || !!state.dateTo || !!state.q.trim();
  }

  function resetFilters() {
    state.source = 'all';
    state.feeds.clear(); state.handles.clear(); state.sections.clear(); state.authors.clear();
    state.media = 'all'; state.minMetric = 0; state.q = '';
    $('q').value = ''; $('mediaSel').value = 'all'; $('minSel').value = '0';
    // last: clearing the date range commits and fires onChange -> update()
    $('dateClear').click();
  }
  $('resetFilters').addEventListener('click', resetFilters);

  // Filter changes jump back to the top; live data reloads keep the position.
  function update(keepScroll) {
    closeCardMenu();
    applyFilters();
    renderSidebar();
    if (!keepScroll) scroller.scrollTop = 0;
    renderAll();
  }

  // ---- per-card action menu (one shared popup, anchored to the ⋯ button) ----

  // one post as standalone Markdown, same shape as lib/export.js toMarkdown
  function postMarkdown(p) {
    const handle = (p.author && p.author.handle) || '@unknown';
    const name = (p.author && p.author.name) ? ` (${p.author.name})` : '';
    const meta = [];
    if (p.takenAt) meta.push(p.takenAt.slice(0, 10));
    if (p.url) meta.push(`[open post](${p.url})`);
    const out = [`**${handle}${name}**${meta.length ? ' · ' + meta.join(' · ') : ''}`, ''];
    if (p.replyTo) {
      const rt = p.replyTo;
      const rtHandle = (rt.author && rt.author.handle) || '@unknown';
      const head = [`**replying to ${rt.url ? `[${rtHandle}](${rt.url})` : rtHandle}**`];
      if (rt.takenAt) head.push(rt.takenAt.slice(0, 10));
      out.push('> ' + head.join(' · '));
      for (const line of String(rt.text || '').split('\n')) out.push('> ' + line);
      out.push('');
    }
    if (p.text) out.push(p.text, '');
    if (p.media && p.media.length) {
      for (const m of p.media) out.push(`- media: <${m}>`);
      out.push('');
    }
    return out.join('\n').trim() + '\n';
  }

  // ---- transient toast (bottom-center); sticky stays until replaced ----
  let toastTimer = null;
  function toast(message, isError, sticky) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4200 : 2600);
  }

  // ---- fetch who liked / reposted a post, on demand, and attach to the record ----
  // one config per engagement kind keeps the menu, grab, and panel in sync
  const ENGAGER = {
    like: {
      tabType: 'like', field: 'likers', countField: 'likeCount', partialField: 'likersPartial',
      menu: 'menu_who_liked', refresh: 'menu_refresh_likers', icon: '❤',
      grabbing: 'likers_grabbing', done: 'likers_done', none: 'likers_none', failed: 'likers_failed',
      summary: 'likers_summary', summaryOf: 'likers_summary_of',
    },
    repost: {
      tabType: 'repost', field: 'reposters', countField: 'repostCount', partialField: 'repostersPartial',
      menu: 'menu_who_reposted', refresh: 'menu_refresh_reposters', icon: '🔁',
      grabbing: 'reposters_grabbing', done: 'reposters_done', none: 'reposters_none', failed: 'reposters_failed',
      summary: 'reposters_summary', summaryOf: 'reposters_summary_of',
    },
  };

  const grabbingEngagers = new Set(); // "kind|source|key" currently in flight
  async function grabEngagers(p, kind) {
    const K = ENGAGER[kind];
    const gid = kind + '|' + p._source + '|' + p._key;
    if (grabbingEngagers.has(gid)) return;
    grabbingEngagers.add(gid);
    toast(t(K.grabbing), false, true); // sticky: large lists take a while to page through
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({
        type: 'GET_LIKERS', postId: p.id, source: p._source, key: p._key, tabType: K.tabType,
      });
    } catch (_) { /* r stays null */ }
    grabbingEngagers.delete(gid);
    if (!r || !r.ok) { toast((r && r.error) || t(K.failed), true); return; }
    toast(r.count ? t(K.done, { n: r.count }) : t(K.none));
    // the card's cached DOM was built without this list, and adding it doesn't
    // change the cache key — evict it so the panel actually renders
    cardCache.delete(keyOf(p));
    await loadPosts();
    update(true);
  }

  let menuEl = null;
  function closeCardMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }
  function openCardMenu(p, anchor) {
    const reopen = !menuEl || menuEl.__anchor !== anchor;
    closeCardMenu();
    if (!reopen) return; // same ⋯ clicked while open = toggle off
    menuEl = document.createElement('div');
    menuEl.className = 'cardMenu';
    menuEl.__anchor = anchor;

    // fixed-width icon column so the labels line up
    function menuBtn(icon, label) {
      const b = document.createElement('button');
      const i = document.createElement('span');
      i.className = 'mi';
      i.textContent = icon;
      const l = document.createElement('span');
      l.textContent = label;
      b.append(i, l);
      return b;
    }

    const open = menuBtn('↗', t('menu_open_post'));
    if (p.url) {
      open.addEventListener('click', () => {
        window.open(p.url, '_blank', 'noreferrer');
        closeCardMenu();
      });
    } else {
      open.disabled = true;
    }
    menuEl.appendChild(open);

    const copy = menuBtn('🔗', t('menu_copy_link'));
    if (p.url) {
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(p.url); } catch (_) {}
        copy.firstChild.textContent = '✓';
        copy.lastChild.textContent = t('menu_copied');
        setTimeout(closeCardMenu, 650);
      });
    } else {
      copy.disabled = true;
    }
    menuEl.appendChild(copy);

    const copiedFx = (btn) => {
      btn.firstChild.textContent = '✓';
      btn.lastChild.textContent = t('menu_copied_text');
      setTimeout(closeCardMenu, 650);
    };

    const copyTxt = menuBtn('📋', t('menu_copy_text'));
    if (p.text) {
      copyTxt.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(p.text); } catch (_) {}
        copiedFx(copyTxt);
      });
    } else {
      copyTxt.disabled = true;
    }
    menuEl.appendChild(copyTxt);

    const copyMd = menuBtn('📝', t('menu_copy_md'));
    copyMd.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(postMarkdown(p)); } catch (_) {}
      copiedFx(copyMd);
    });
    menuEl.appendChild(copyMd);

    for (const kind of ['like', 'repost']) {
      const K = ENGAGER[kind];
      const has = !!p[K.field];
      const btn = menuBtn(K.icon, t(has ? K.refresh : K.menu));
      btn.addEventListener('click', () => { closeCardMenu(); grabEngagers(p, kind); });
      menuEl.appendChild(btn);
    }

    const del = menuBtn('🗑', t('menu_delete_post'));
    del.className = 'menuDanger';
    del.addEventListener('click', async () => {
      closeCardMenu();
      const who = (p.author && p.author.handle) || '@unknown';
      if (!(await confirmDialog(t('confirm_del_post', { who })))) return;
      try {
        await chrome.runtime.sendMessage({ type: 'DELETE_POSTS', keys: { [p._source]: [p._key] } });
      } catch (_) {}
      cardCache.delete(keyOf(p));
      await loadPosts();
      update(true);
    });
    menuEl.appendChild(del);

    document.body.appendChild(menuEl);
    // below the button, right edges aligned; flip above if it would clip
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    menuEl.style.top = (r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  }
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !menuEl.__anchor.contains(e.target)) closeCardMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCardMenu();
  });
  scroller.addEventListener('scroll', closeCardMenu, { passive: true });

  // ---- centered delete-confirm modal (shared by card menu + delete-view) ----

  function confirmDialog(msg) {
    return new Promise((resolve) => {
      const dlg = $('confirmDlg');
      $('confirmMsg').textContent = msg;
      const done = (v) => {
        dlg.close();
        $('confirmOk').onclick = $('confirmCancel').onclick = dlg.oncancel = dlg.onclick = null;
        resolve(v);
      };
      $('confirmOk').onclick = () => done(true);
      $('confirmCancel').onclick = () => done(false);
      dlg.oncancel = (e) => { e.preventDefault(); done(false); }; // Esc
      dlg.onclick = (e) => { if (e.target === dlg) done(false); }; // backdrop
      dlg.showModal();
    });
  }

  // ---- delete the current view ----

  $('delShown').addEventListener('click', async () => {
    if (!view.length) return;
    if (!(await confirmDialog(t('confirm_delete', { n: view.length.toLocaleString() })))) return;
    const keys = { saved: [], liked: [], feed: [], profile: [] };
    for (const p of view) keys[p._source].push(p._key);
    $('delShown').disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_POSTS', keys });
    } catch (_) {}
    await loadPosts();
    update(true);
  });

  // ---- exports (reuse lib/export.js on the filtered view) ----

  // when the filters pin a single feed / profile / author (or a source),
  // put it in the filename so exports stay tellable-apart in Downloads
  function exportSuffix() {
    const one = (s) => (s.size === 1 ? [...s][0] : null);
    let part = one(state.feeds) || one(state.handles) || one(state.authors)
      || (state.source !== 'all' ? state.source : null);
    if (!part) return '';
    part = String(part).replace(/^@/, '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return part ? '-' + part : '';
  }

  function download(text, mime, ext) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download(
      { url, filename: `threads-dashboard${exportSuffix()}-${stamp}.${ext}`, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 60000)
    );
  }

  // CSV/MD columns depend on the shape: single-source views get that source's
  // richer layout, mixed views fall back to the generic (saved) one.
  const exportKind = () =>
    state.source === 'feed' ? 'feed'
      : state.source === 'profile' ? 'profile'
        : state.source === 'liked' ? 'liked' : undefined;

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
  $('metricSel').addEventListener('change', () => { state.metric = $('metricSel').value; update(); });
  $('minSel').addEventListener('change', () => { state.minMetric = parseInt($('minSel').value, 10) || 0; update(); });
  // date-range picker wired in init, after TSEI18n resolves the language
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

  // ---- collapsible sidebar sections ----

  let collapsedSecs = {};
  try { collapsedSecs = JSON.parse(localStorage.getItem('tse_dash_secs') || '{}'); } catch (_) {}
  document.querySelectorAll('details.sideSec').forEach((d) => {
    if (collapsedSecs[d.dataset.sec]) d.open = false;
    d.addEventListener('toggle', () => {
      collapsedSecs[d.dataset.sec] = !d.open;
      try { localStorage.setItem('tse_dash_secs', JSON.stringify(collapsedSecs)); } catch (_) {}
    });
  });

  // ---- live updates while a grab runs ----

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tse_state || changes.tse_liked_state || changes.tse_feed_state || changes.tse_profile_state) loadLive();
    if (changes.tse_posts || changes.tse_liked_posts || changes.tse_feed_posts || changes.tse_profile_posts) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        await loadPosts();
        update(true);
        loadStorage();
      }, 800);
    }
  });

  // ---- init ----

  (async () => {
    await TSEI18n.init();
    TSEI18n.apply();
    TSEDateRange.init({
      button: $('dateBtn'),
      label: $('dateLbl'),
      clearBtn: $('dateClear'),
      pop: $('datePop'),
      t,
      locale: TSEI18n.lang === 'zh_TW' ? 'zh-TW' : 'en',
      onChange(from, to) {
        state.dateFrom = from;
        state.dateTo = to;
        update();
      },
    });
    try { setLayout(localStorage.getItem('tse_dash_layout') || 'grid'); } catch (_) {}
    await Promise.all([loadPosts(), loadLive(), loadStorage()]);
    update();
  })();
})();
