// content.js — isolated world. Relays captured batches from inject.js to the
// service worker and drives auto-scroll pagination on the /saved page or on a
// feed page (For you / Following / Ghost posts / custom feeds).
(() => {
  'use strict';

  const SAVED_RE = /^\/saved\/?$/;
  const LIKED_RE = /^\/liked\/?$/;
  // single-column feed pages that window-scroll (the "/" board layout does not)
  const FEED_RE = /^\/(for_you|following|ghost_posts|custom_feed\/[^/]+)\/?$/;
  // a profile root or its replies tab (NOT /@user/post/… permalinks)
  const PROFILE_RE = /^\/@[^/]+(?:\/replies)?\/?$/;
  // board home: pinned feeds side by side, each in its own scroll container
  const BOARD_RE = /^\/$/;
  const MAX_COLUMNS = 4;  // hard cap on simultaneously driven columns

  // ---- scroll driver state ----
  let scrolling = false;
  let mode = null;        // 'saved' | 'feed' | 'profile' | 'columns' while scrolling
  let idleCycles = 0;     // cycles with no new batch AND no height growth
  let lastHeight = 0;
  let sawEnd = false;     // a captured page_info said has_next_page === false
  let timer = null;
  // Columns are tracked by INDEX and re-resolved every tick: a freshly added
  // column renders a skeleton first and Threads replaces its scroller element
  // when the content hydrates, so cached nodes go stale. Column order is
  // stable during a run (new columns append at the end).
  let cols = null;        // columns mode: [{idx, url, idle, lastH, done}]
  let columnUris = null;  // board column registry from inject.js (DOM order)
  let desiredFeeds = [];  // columns mode: [{name, url}] the run wants
  let addedCols = [];     // columns this run added itself: [{url, idx}]

  const IDLE_LIMIT = 8;   // ~8 quiet cycles (≈10s) => assume exhausted
  const STEP_MS_MIN = 900;
  const STEP_MS_MAX = 1500;

  function pageKind() {
    if (SAVED_RE.test(location.pathname)) return 'saved';
    if (LIKED_RE.test(location.pathname)) return 'liked';
    if (FEED_RE.test(location.pathname)) return 'feed';
    if (PROFILE_RE.test(location.pathname)) return 'profile';
    if (BOARD_RE.test(location.pathname)) return 'board';
    return null;
  }

  // own username = the profile link in the nav sidebar (the only bare /@x link there)
  function ownUsername() {
    const nav = document.querySelector('[role="navigation"]');
    if (!nav) return null;
    for (const a of nav.querySelectorAll('a[href^="/@"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/@([^/]+)\/?$/);
      if (m) return m[1];
    }
    return null;
  }

  function currentFeedName() {
    const p = location.pathname;
    if (p.startsWith('/custom_feed/')) {
      // tab title is "<feed name> • Threads"
      const t = document.title.replace(/\s*•.*$/, '').trim();
      return t || 'Custom feed';
    }
    if (p.startsWith('/for_you')) return 'For you';
    if (p.startsWith('/following')) return 'Following';
    if (p.startsWith('/ghost_posts')) return 'Ghost posts';
    return null;
  }

  // After a reload of the extension this already-injected copy of the script
  // is orphaned: chrome.runtime is gone and every sendMessage throws. Route
  // all sends through here so the first failure quiets this copy for good.
  let orphaned = false;
  function send(msg) {
    if (!orphaned) {
      try {
        if (chrome.runtime && chrome.runtime.id) {
          return chrome.runtime.sendMessage(msg).catch(() => null);
        }
      } catch (_) { /* invalidated between the check and the call */ }
      orphaned = true;
      if (scrolling) stopScroll('extension reloaded');
      else hideBanner();
    }
    return Promise.resolve(null);
  }

  function sendState(state, reason) {
    send({ type: 'SCROLL_STATE', mode, state, reason });
  }

  // ---- on-page banner: signal that an autonomous grab owns this tab ----
  let banner = null;
  TSEI18n.init(); // resolve language early; the banner shows well after injection

  const BANNER_KEYS = { saved: 'banner_saved', liked: 'banner_liked', feed: 'banner_feed', profile: 'banner_profile', columns: 'banner_columns' };

  function showBanner(m) {
    const label = TSEI18n.t(BANNER_KEYS[m] || 'banner_generic');
    if (banner) {
      banner.lastChild.textContent = bannerText(label);
      return;
    }
    banner = document.createElement('div');
    banner.id = 'tse-banner';
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'top:14px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'pointer-events:none',
      'display:flex', 'align-items:center', 'gap:12px',
      'padding:12px 22px', 'border-radius:14px',
      'background:rgba(8,8,8,0.96)', 'border:1.5px solid #3ddc84',
      'box-shadow:0 6px 32px rgba(0,0,0,0.7), 0 0 0 4px rgba(61,220,132,0.12)',
      'color:#f3f3f3', 'font:14px/1.4 system-ui,sans-serif', 'white-space:nowrap',
      'max-width:92vw', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    const dot = document.createElement('span');
    dot.style.cssText = 'width:11px;height:11px;border-radius:50%;background:#3ddc84;flex:none;box-shadow:0 0 8px rgba(61,220,132,0.8);';
    dot.animate(
      [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }],
      { duration: 1200, iterations: Infinity, easing: 'ease-in-out' }
    );
    const strong = document.createElement('b');
    strong.textContent = TSEI18n.t('banner_running');
    strong.style.cssText = 'color:#3ddc84;font-weight:700;flex:none;';
    const text = document.createElement('span');
    text.textContent = bannerText(label);
    text.style.cssText = 'color:#cfcfcf;overflow:hidden;text-overflow:ellipsis;';
    banner.append(dot, strong, text);
    document.documentElement.appendChild(banner);
  }

  function bannerText(label) {
    return TSEI18n.t('banner_tail', { label });
  }

  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
  }

  // ---- engager fetch bridge (dashboard -> SW -> here -> inject.js -> back) ----
  let engSeq = 0;
  const pendingEngagers = new Map(); // reqId -> settle(result)

  // ---- relay batches + discovered feed/column lists from the MAIN-world script ----
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || orphaned || !d || d.__tse !== true) return;
    if (d.type === 'TSE_ENGAGERS') {
      const settle = pendingEngagers.get(d.reqId);
      if (settle) { pendingEngagers.delete(d.reqId); settle(d); }
      return;
    }
    if (d.type === 'TSE_FEEDS') {
      send({ type: 'FEEDS', feeds: d.feeds || [] });
      return;
    }
    if (d.type === 'TSE_COLUMNS') {
      columnUris = d.uris || null;
      return;
    }
    if (d.type !== 'TSE_BATCH') return;
    const msg = {
      type: 'BATCH',
      kind: d.kind || 'saved',
      connKey: d.connKey,
      posts: d.posts || [],
      pageInfo: d.pageInfo,
      origin: d.origin,
      feedUrl: d.feedUrl || null,
      path: location.pathname,
    };
    if (msg.kind === 'feed') msg.feedName = currentFeedName();
    send(msg).then((resp) => {
      // columns mode: the service worker reports which feeds hit their target
      if (mode === 'columns' && cols && resp && Array.isArray(resp.doneFeeds)) {
        for (const c of cols) if (resp.doneFeeds.includes(c.url)) c.done = true;
      }
    });
    if (!scrolling) return;
    if (mode === 'columns') {
      if (msg.kind !== 'feed' || !cols || !msg.feedUrl) return;
      const url = msg.feedUrl.replace(/\/+$/, '') + '/';
      for (const c of cols) {
        if (c.url !== url) continue;
        c.idle = 0;
        if (d.pageInfo && d.pageInfo.has_next_page === false) c.done = true;
      }
    } else if (msg.kind === mode) {
      idleCycles = 0;
      if (d.pageInfo && d.pageInfo.has_next_page === false) sawEnd = true;
    }
  });

  // ---- auto-scroll loop ----
  function stopScroll(reason) {
    scrolling = false;
    if (timer) clearTimeout(timer);
    timer = null;
    cols = null;
    hideBanner();
    if (addedCols.length) removeAddedColumns(); // async, best-effort board restore
    sendState('done', reason);
  }

  // ---- columns mode: open a column per selected feed, drive them in parallel ----
  // The board's add/remove-column flow responds to synthesized pointer events
  // (verified live 2026-07-06), so the run can pin the feeds it needs and
  // unpin them afterwards. UI strings ("Add a column", "Feeds", "More",
  // "Remove column") assume the English Threads UI.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fireEvents(el, types) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1,
    };
    for (const t of types) {
      const Ev = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(t, opts));
    }
  }
  const fireHover = (el) => fireEvents(el, ['pointerover', 'mouseover', 'pointermove', 'mousemove']);
  const fireClick = (el) => fireEvents(el, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);

  async function waitFor(fn, ms) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(200);
    }
  }

  const colScrollers = () => [...document.querySelectorAll('[data-column-scrollable]')];
  const menuItems = () =>
    [...document.querySelectorAll('[role="menu"] [role="button"], [role="menu"] button, [role="menuitem"]')];
  const buttonByText = (text) =>
    [...document.querySelectorAll('[role="button"], button')]
      .find((b) => (b.textContent || '').trim() === text);

  // find the submenu entry for a feed. Plain feeds render just the name, but
  // community feeds append stats ("Tech Threads122K members · …"), so also
  // accept an item containing a leaf element that is exactly the name.
  function feedMenuItem(name) {
    const items = menuItems();
    return items.find((b) => (b.textContent || '').trim() === name) ||
      items.find((b) => [...b.querySelectorAll('*')].some(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === name)) ||
      null;
  }

  function closeMenus() {
    if (document.querySelector('[role="menu"]')) fireClick(document.body);
  }

  // drive: "Add a column" -> Feeds -> <feed name>; resolves to the new
  // column's INDEX among [data-column-scrollable] scrollers, or -1
  async function addFeedColumn(name) {
    const addBtn = buttonByText('Add a column');
    if (!addBtn) return -1;
    fireClick(addBtn);
    if (!(await waitFor(() => document.querySelector('[role="menu"]'), 3000))) return -1;
    const feedsItem = await waitFor(
      () => menuItems().find((b) => /^Feeds/.test((b.textContent || '').trim())), 2000);
    if (!feedsItem) { closeMenus(); return -1; }
    fireHover(feedsItem);
    await sleep(250);
    fireClick(feedsItem);
    const item = await waitFor(() => feedMenuItem(name), 3000);
    if (!item) { closeMenus(); return -1; }
    item.scrollIntoView({ block: 'nearest' }); // the feed list scrolls past ~6 entries
    await sleep(150);
    const before = colScrollers().length;
    fireClick(item);
    const grown = await waitFor(() => colScrollers().length > before, 5000);
    closeMenus();
    return grown ? colScrollers().length - 1 : -1;
  }

  // remove a column this run added: its header "More" -> "Remove column"
  async function removeColumn(el) {
    if (!el || !document.contains(el)) return;
    const bodyRect = el.getBoundingClientRect();
    const more = [...document.querySelectorAll('[role="button"], button')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.y < bodyRect.y &&
        r.x >= bodyRect.x - 10 && r.x <= bodyRect.x + bodyRect.width &&
        (b.textContent || '').trim() === 'More';
    });
    if (!more) return;
    fireClick(more);
    const item = await waitFor(
      () => menuItems().find((b) => /Remove column/.test((b.textContent || '').trim())), 3000);
    if (!item) { closeMenus(); return; }
    fireClick(item);
    await sleep(1000);
  }

  let removingCols = null; // shared so a wave hand-off can await an in-flight removal
  function removeAddedColumns() {
    if (!removingCols) {
      removingCols = (async () => {
        const toRemove = addedCols;
        addedCols = [];
        // highest index first, so earlier removals don't shift later ones
        toRemove.sort((a, b) => b.idx - a.idx);
        for (const c of toRemove) await removeColumn(colScrollers()[c.idx]);
      })().finally(() => { removingCols = null; });
    }
    return removingCols;
  }

  async function startColumns() {
    // re-scan announces the column registry (TSE_COLUMNS); this replay's
    // batches are dropped by the service worker because no queue exists yet
    window.postMessage({ __tse: true, type: 'TSE_RESCAN' }, window.location.origin);
    await sleep(700);
    if (!scrolling || mode !== 'columns') return;

    const desired = desiredFeeds.slice(0, MAX_COLUMNS);
    // columns already pinned, by registry order (uris align with the DOM)
    const uris = (columnUris || []).map((u) => (typeof u === 'string' ? u.replace(/\/+$/, '') + '/' : null));
    const bound = [];
    for (const f of desired) {
      if (!scrolling || mode !== 'columns') return;
      let idx = uris.indexOf(f.url);
      if (idx === -1) {
        idx = await addFeedColumn(f.name); // not pinned — open it ourselves
        if (idx !== -1) addedCols.push({ url: f.url, idx });
      }
      if (idx !== -1) bound.push({ idx, url: f.url, idle: 0, lastH: 0, done: false });
    }
    cols = bound;
    if (!cols.length) return stopScroll('could not open any feed columns');
    send({
      type: 'COLUMNS_INFO',
      feeds: cols.map((c) => ({ url: c.url })),
    }).then((resp) => {
      if (resp === null) return stopScroll('extension unreachable');
      if (!scrolling || mode !== 'columns') return;
      // queue registered — NOW replay so each column's embedded first
      // batch (its top posts) is counted before any scrolling
      window.postMessage({ __tse: true, type: 'TSE_RESCAN' }, window.location.origin);
      // freshly added columns render a skeleton first — give them a moment
      timer = setTimeout(stepColumns, addedCols.length ? 2500 : 800);
    });
  }

  function stepColumns() {
    if (!scrolling || !cols) return;
    const scrollers = colScrollers(); // fresh every tick — elements get replaced
    const active = cols.filter((c) => !c.done);
    if (!active.length) return stopScroll('all columns finished');
    for (const c of active) {
      const el = scrollers[c.idx];
      if (!el) { // column briefly (or permanently) gone — idle it out
        if (++c.idle >= IDLE_LIMIT) c.done = true;
        continue;
      }
      const h = el.scrollHeight;
      if (h === c.lastH) c.idle++;
      else c.idle = 0;
      c.lastH = h;
      if (c.idle >= IDLE_LIMIT) { c.done = true; continue; }
      if (c.idle > 0 && c.idle % 3 === 0) {
        // same sentinel nudge as the single-feed driver, per column
        el.scrollTop = Math.max(0, h - el.clientHeight * 2.5);
      } else {
        el.scrollTop = h;
      }
    }
    sendState('running');
    timer = setTimeout(stepColumns, STEP_MS_MIN + Math.random() * (STEP_MS_MAX - STEP_MS_MIN));
  }

  function step() {
    if (!scrolling) return;
    if (sawEnd) return stopScroll('reached the end of the feed');

    const h = document.documentElement.scrollHeight;
    if (h === lastHeight) idleCycles++;
    else idleCycles = 0;
    lastHeight = h;

    if (idleCycles >= IDLE_LIMIT) return stopScroll('no new items — feed exhausted');

    if (idleCycles > 0 && idleCycles % 3 === 0) {
      // Parked at the bottom with nothing loading: pull back a couple of
      // viewports so the infinite-scroll sentinel re-enters the viewport and
      // gets a fresh IntersectionObserver transition on the next step.
      window.scrollTo(0, Math.max(0, h - window.innerHeight * 2.5));
    } else {
      window.scrollTo(0, h);
    }
    sendState('running');
    timer = setTimeout(step, STEP_MS_MIN + Math.random() * (STEP_MS_MAX - STEP_MS_MIN));
  }

  function startScroll(m, feeds) {
    if (scrolling && mode === m) return;
    if (scrolling) { // switching modes: kill the old loop first
      scrolling = false;
      if (timer) clearTimeout(timer);
      cols = null;
    }
    mode = m;
    if (m === 'columns') desiredFeeds = Array.isArray(feeds) ? feeds : [];
    const expected = m === 'columns' ? 'board' : m;
    if (pageKind() !== expected) {
      if (m === 'saved' || m === 'liked') {
        // Navigate there; after the reload this script re-runs and the
        // service worker restarts the grab via CONTENT_READY.
        location.assign(m === 'saved' ? '/saved' : '/liked');
      }
      // feed/columns mode: the service worker drives navigation itself — if
      // we're not on the right page yet, a navigation is already on its way.
      return;
    }
    scrolling = true;
    sawEnd = false;
    idleCycles = 0;
    lastHeight = 0;
    showBanner(m);
    if (m === 'columns') {
      sendState('running');
      startColumns();
      return;
    }
    window.scrollTo(0, 0); // start from the top so the first batch is on screen
    // Ask inject.js to replay everything it captured before the grab started
    // (server-embedded first batch, any manual pre-scrolling).
    window.postMessage({ __tse: true, type: 'TSE_RESCAN' }, window.location.origin);
    sendState('running');
    timer = setTimeout(step, 800);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SCROLL') {
      startScroll(msg.mode || 'saved', msg.feeds);
      sendResponse({ ok: true, pageKind: pageKind() });
    } else if (msg.type === 'NEXT_WAVE') {
      // batch waves: close this wave's columns, then open the next set of
      // feeds on the same board — no page navigation between waves
      (async () => {
        scrolling = false;
        if (timer) clearTimeout(timer);
        timer = null;
        cols = null;
        await removeAddedColumns(); // waits for an in-flight teardown too
        await sleep(600);           // let the board settle before re-binding
        startScroll('columns', msg.feeds);
      })();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_SCROLL') {
      scrolling = false;
      if (timer) clearTimeout(timer);
      cols = null;
      hideBanner();
      if (addedCols.length) removeAddedColumns(); // best-effort board restore
      sendState('stopped', msg.reason || 'stopped');
      sendResponse({ ok: true });
    } else if (msg.type === 'FETCH_ENGAGERS') {
      // dashboard asked (via SW) for who liked/reposted a post — hand it to
      // inject.js (MAIN world), which replays the authenticated graphql query
      const reqId = 'eng_' + (++engSeq);
      const engTimer = setTimeout(() => {
        const settle = pendingEngagers.get(reqId);
        if (settle) { pendingEngagers.delete(reqId); settle({ ok: false, error: 'ERR_TIMEOUT' }); } // code — dashboard translates
      }, 180000); // large lists page through many requests
      pendingEngagers.set(reqId, (res) => {
        clearTimeout(engTimer);
        sendResponse({ ok: !!res.ok, engagers: res.engagers || [], partial: !!res.partial, error: res.error || null });
      });
      window.postMessage({ __tse: true, type: 'TSE_GET_ENGAGERS', reqId, postId: msg.postId, tabType: msg.tabType || 'like' }, window.location.origin);
      return true; // async sendResponse
    } else if (msg.type === 'GET_USERNAME') {
      sendResponse({ username: ownUsername() });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, pageKind: pageKind(), scrolling, mode });
    }
    return false;
  });

  // ---- announce readiness; the service worker decides whether to (re)start
  // scrolling here (single-feed resume, or the next stop of a multi-feed run)
  send({
    type: 'CONTENT_READY',
    path: location.pathname,
    kind: pageKind(),
  });
})();
