// content.js — isolated world. Relays captured batches from inject.js to the
// service worker and drives auto-scroll pagination on the /saved page or on a
// feed page (For you / Following / Ghost posts / custom feeds).
(() => {
  'use strict';

  const SAVED_RE = /^\/saved\/?$/;
  const LIKED_RE = /^\/liked\/?$/;
  // single-column feed pages that window-scroll (the "/" board layout does not)
  const FEED_RE = /^\/(for_you|following|ghost_posts|custom_feed\/[^/]+)\/?$/;
  // search results page (?q=… names the query); window-scrolls like a feed
  const SEARCH_RE = /^\/search\/?$/;
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
  // A column spec is {kind:'feed', name, url} or {kind:'search', query, filter};
  // bound columns carry key = url (feed) / query (search) for attribution.
  let cols = null;        // columns mode: [{idx, kind, key, idle, lastH, done}]
  let columnUris = null;  // board column registry from inject.js (DOM order)
  let desiredCols = [];   // columns mode: specs the run wants
  let addedCols = [];     // columns this run added itself: [{idx}]

  const IDLE_LIMIT = 8;   // ~8 quiet cycles (≈10s) => assume exhausted
  const STEP_MS_MIN = 900;
  const STEP_MS_MAX = 1500;

  function pageKind() {
    if (SAVED_RE.test(location.pathname)) return 'saved';
    if (LIKED_RE.test(location.pathname)) return 'liked';
    if (FEED_RE.test(location.pathname)) return 'feed';
    if (SEARCH_RE.test(location.pathname)) return 'search';
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

  const BANNER_KEYS = { saved: 'banner_saved', liked: 'banner_liked', feed: 'banner_feed', profile: 'banner_profile', columns: 'banner_columns', search: 'banner_search' };

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
    if (d.type === 'TSE_ENGAGERS_PROGRESS') {
      // fire-and-forget to the extension; the dashboard page listens and
      // updates its fetch banner (the SW ignores it)
      send({ type: 'ENGAGERS_PROGRESS', postId: d.postId, tabType: d.tabType, count: d.count, max: d.max });
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
      users: d.users || null,
      pageInfo: d.pageInfo,
      origin: d.origin,
      feedUrl: d.feedUrl || null,
      searchQuery: d.searchQuery || null,
      path: location.pathname,
    };
    if (msg.kind === 'feed') msg.feedName = currentFeedName();
    send(msg).then((resp) => {
      // columns mode: the service worker reports which columns hit their target
      const done = resp && (resp.doneKeys || resp.doneFeeds);
      if (mode === 'columns' && cols && Array.isArray(done)) {
        for (const c of cols) if (done.includes(c.key)) c.done = true;
      }
    });
    if (!scrolling) return;
    if (mode === 'columns') {
      if (!cols) return;
      let kind = null, key = null;
      if (msg.kind === 'feed' && msg.feedUrl) { kind = 'feed'; key = msg.feedUrl.replace(/\/+$/, '') + '/'; }
      else if (msg.kind === 'search' && msg.searchQuery) { kind = 'search'; key = msg.searchQuery; }
      if (!key) return;
      for (const c of cols) {
        if (c.kind !== kind || c.key !== key) continue;
        c.idle = 0;
        if (d.pageInfo && d.pageInfo.has_next_page === false) c.done = true;
      }
    } else if (msg.kind === mode ||
               (mode === 'search' && msg.kind === 'search_users')) {
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

  // drive: "Add a column" -> Search -> type the query -> click the
  // "Search <query>" typeahead option (which pins a serp column), then
  // optionally switch it to its Recent tab (verified live 2026-07-17).
  // Resolves to the new column's INDEX among the scrollers, or -1. The pane's
  // index is pushed to addedCols as soon as it exists, so a failed bind still
  // gets a teardown attempt.
  async function addSearchColumn(query, filter) {
    const addBtn = buttonByText('Add a column');
    if (!addBtn) return -1;
    fireClick(addBtn);
    if (!(await waitFor(() => document.querySelector('[role="menu"]'), 3000))) return -1;
    const searchItem = await waitFor(
      () => menuItems().find((b) => (b.textContent || '').trim() === 'Search'), 2000);
    if (!searchItem) { closeMenus(); return -1; }
    const visInputs = () => [...document.querySelectorAll('input[placeholder="Search"]')]
      .filter((i) => i.offsetParent);
    const before = colScrollers().length;
    const inputsBefore = visInputs().length;
    fireClick(searchItem);
    const grown = await waitFor(() => colScrollers().length > before, 5000);
    closeMenus();
    if (!grown) return -1;
    const idx = colScrollers().length - 1;
    addedCols.push({ idx });
    // The new pane appends at the end, so it owns the LAST header search box —
    // but only once ITS box has mounted (before that, the last box belongs to
    // the previous column). Threads PRE-FILLS the box with the session's
    // previous search, so never look for an empty one — clear it, then type
    // (the typeahead only opens on a value change). Re-resolve the element
    // around waits: hydration replaces it.
    const lastInput = () => {
      const els = visInputs();
      return els.length > inputsBefore ? els[els.length - 1] : null;
    };
    let input = await waitFor(lastInput, 4000);
    if (!input) return -1;
    input.scrollIntoView({ inline: 'nearest' });
    // React-controlled input: go through the native setter + input event.
    // Clearing the prefill makes React re-render — sometimes REMOUNTING the
    // box, which detaches the element and resets the value — so type with
    // verification: re-resolve, set, and confirm the query actually stuck.
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    input.focus();
    setVal.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    let typed = null;
    for (let attempt = 0; attempt < 4 && !typed; attempt++) {
      const inp = lastInput();
      if (!inp) { await sleep(400); continue; }
      inp.focus();
      setVal.call(inp, query);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(450);
      const cur = lastInput();
      if (cur && cur.value === query) typed = cur;
    }
    if (!typed) return -1;
    // the "Search <query>" typeahead option converts the pane to a serp column
    const compact = ('Search' + query + 'Continue').replace(/\s+/g, '');
    const findRow = () =>
      [...document.querySelectorAll('li[role="option"]')].find((el) =>
        el.offsetParent && (el.textContent || '').replace(/\s+/g, '') === compact) || null;
    let row = await waitFor(findRow, 5000);
    if (!row) {
      // value stuck but the dropdown never opened — nudge it once
      typed.focus();
      typed.dispatchEvent(new Event('input', { bubbles: true }));
      row = await waitFor(findRow, 3000);
    }
    if (!row) { fireClick(document.body); return -1; }
    fireClick(row.querySelector('a') || row);
    await sleep(1200);
    if (filter === 'recent') await clickColumnRecentTab(query);
    return idx;
  }

  // the serp column's Recent tab sits just under its header search box —
  // re-resolve the box by its query value (conversion can remount the header)
  async function clickColumnRecentTab(query) {
    const tab = await waitFor(() => {
      const inputs = [...document.querySelectorAll('input[placeholder="Search"]')]
        .filter((i) => i.offsetParent && i.value === query);
      const input = inputs.length ? inputs[inputs.length - 1] : null;
      if (!input) return null;
      const ir = input.getBoundingClientRect();
      return [...document.querySelectorAll('a, [role="tab"]')].find((el) => {
        if (!el.offsetParent || (el.textContent || '').trim() !== 'Recent') return false;
        const r = el.getBoundingClientRect();
        return r.y > ir.bottom && r.y < ir.bottom + 120 &&
          r.x > ir.left - 80 && r.x < ir.right + 80;
      }) || null;
    }, 4000);
    if (tab) { fireClick(tab); await sleep(800); }
  }

  // A control in the same header ROW as a search column's box, kept inside
  // the column's x-range so a neighbour's buttons can't match. Returns the
  // node to CLICK — the labelled svg itself when there is one, so the
  // synthetic events bubble up THROUGH the interactive wrapper (dispatching
  // on an outer element can start above the handler and miss it).
  function headerRowButton(colEl, input, label) {
    const cr = colEl.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    const iy = ir.y + ir.height / 2;
    const inRow = (r) => {
      const cx = r.x + r.width / 2;
      return r.width > 0 && Math.abs((r.y + r.height / 2) - iy) < 25 &&
        cx >= cr.x && cx <= cr.x + cr.width;
    };
    const svg = [...document.querySelectorAll(`svg[aria-label="${label}"]`)]
      .find((s) => inRow(s.getBoundingClientRect()));
    if (svg) return svg;
    return [...document.querySelectorAll('[role="button"], button')].find((b) => {
      const r = b.getBoundingClientRect();
      return inRow(r) && r.width < 80 &&
        ((b.textContent || '').trim() === label || b.getAttribute('aria-label') === label);
    }) || null;
  }

  // feed columns keep the original header rule (their scroller starts below
  // the header, and they have no search box to anchor on)
  function feedHeaderMore(el) {
    const bodyRect = el.getBoundingClientRect();
    return [...document.querySelectorAll('[role="button"], button')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.y < bodyRect.y &&
        r.x >= bodyRect.x - 10 && r.x <= bodyRect.x + bodyRect.width &&
        (b.textContent || '').trim() === 'More';
    }) || null;
  }

  const removeItem = () =>
    menuItems().find((b) => /Remove column/.test((b.textContent || '').trim()));

  // Remove a column by INDEX (elements go stale as column state changes).
  // Search columns only offer "Remove column" from their BASE state — on a
  // serp their ⋯ menu is just "Add as column / Create new feed" — so walk the
  // column's ← Back first; a still-transient pane gets PINNED via "Add as
  // column" so the Remove entry appears. Feed columns skip all of that.
  async function removeColumn(idx) {
    for (let i = 0; i < 4; i++) {
      const el = colScrollers()[idx];
      if (!el) return;
      const input = columnSearchInput(el);
      if (!input) break; // feed column — no back walk
      const back = headerRowButton(el, input, 'Back');
      if (!back) break;
      fireClick(back);
      await sleep(900);
    }
    const el = colScrollers()[idx];
    if (!el) return;
    const input = columnSearchInput(el);
    const more = input ? headerRowButton(el, input, 'More') : feedHeaderMore(el);
    if (!more) return;
    fireClick(more);
    let item = await waitFor(removeItem, 2500);
    if (!item && input) {
      // transient search pane: pin it first, then Remove column appears
      const addAs = menuItems().find((b) => /Add as column/.test((b.textContent || '').trim()));
      if (!addAs) { closeMenus(); return; }
      fireClick(addAs);
      await sleep(1500);
      const el2 = colScrollers()[idx];
      const input2 = el2 && columnSearchInput(el2);
      const more2 = el2 && input2 && headerRowButton(el2, input2, 'More');
      if (!more2) return;
      fireClick(more2);
      item = await waitFor(removeItem, 2500);
    }
    if (!item) { closeMenus(); return; }
    fireClick(item);
    await sleep(1000);
  }

  // The visible header search box owning a column: its center-x falls within
  // the column's x-range. No y comparison — the scroller's rect sometimes
  // spans the whole column INCLUDING the header, so "above the scroller top"
  // is not a reliable test.
  function columnSearchInput(el) {
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return [...document.querySelectorAll('input[placeholder="Search"]')].find((i) => {
      if (!i.offsetParent) return false;
      const ir = i.getBoundingClientRect();
      const cx = ir.x + ir.width / 2;
      return cx >= r.x && cx <= r.x + r.width;
    }) || null;
  }

  // board columns whose header carries a search box = search columns
  function searchColumnScrollers() {
    return colScrollers().filter((el) => columnSearchInput(el));
  }

  // Leftover search columns (interrupted earlier runs) pile up board render
  // load — sweep the board back to its base state before opening this run's
  // own columns. Feed columns are never touched. An unremovable pane is
  // skipped so it can't block the ones behind it.
  async function removeStaleSearchColumns() {
    let skip = 0;
    for (let guard = 0; guard < 12; guard++) {
      const stale = searchColumnScrollers(); // re-resolve — removal shifts the rest
      if (stale.length <= skip) return;
      const el = stale[skip];
      el.scrollIntoView({ inline: 'center' });
      await sleep(400);
      const before = colScrollers().length;
      await removeColumn(colScrollers().indexOf(el));
      if (colScrollers().length >= before) skip++;
    }
  }

  let removingCols = null; // shared so a wave hand-off can await an in-flight removal
  function removeAddedColumns() {
    if (!removingCols) {
      removingCols = (async () => {
        const toRemove = addedCols;
        addedCols = [];
        // highest index first, so earlier removals don't shift later ones
        toRemove.sort((a, b) => b.idx - a.idx);
        for (const c of toRemove) await removeColumn(c.idx);
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

    const desired = desiredCols.slice(0, MAX_COLUMNS);
    // Search runs: clear leftover search columns from earlier interrupted runs
    // so the board starts from its base state. Safe here because search runs
    // never bind via the uri registry (whose indices removal would shift).
    if (desired.some((s) => s.kind === 'search')) {
      await removeStaleSearchColumns();
      if (!scrolling || mode !== 'columns') return;
    }
    // columns already pinned, by registry order (uris align with the DOM)
    const uris = (columnUris || []).map((u) => (typeof u === 'string' ? u.replace(/\/+$/, '') + '/' : null));
    const bound = [];
    for (const spec of desired) {
      if (!scrolling || mode !== 'columns') return;
      if (spec.kind === 'search') {
        // search columns are always opened by the run (a user's pinned search
        // column has its own query — never hijack it); addSearchColumn tracks
        // the pane in addedCols itself, even when the bind fails
        const idx = await addSearchColumn(spec.query, spec.filter);
        if (idx !== -1) {
          bound.push({ idx, kind: 'search', key: spec.query, idle: 0, lastH: 0, done: false });
        }
        continue;
      }
      let idx = uris.indexOf(spec.url);
      if (idx === -1) {
        idx = await addFeedColumn(spec.name); // not pinned — open it ourselves
        if (idx !== -1) addedCols.push({ idx });
      }
      if (idx !== -1) bound.push({ idx, kind: 'feed', key: spec.url, idle: 0, lastH: 0, done: false });
    }
    cols = bound;
    if (!cols.length) return stopScroll('could not open any columns');
    send({
      type: 'COLUMNS_INFO',
      feeds: cols.filter((c) => c.kind === 'feed').map((c) => ({ url: c.key })),
      cols: cols.map((c) => (c.kind === 'search' ? { kind: 'search', query: c.key } : { kind: 'feed', url: c.key })),
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

  // column specs arrive as msg.cols (mixed kinds) or legacy msg.feeds
  function normalizeSpecs(msg) {
    if (Array.isArray(msg.cols)) return msg.cols;
    if (Array.isArray(msg.feeds)) {
      return msg.feeds.map((f) => ({ kind: 'feed', name: f.name, url: f.url }));
    }
    return [];
  }

  function startScroll(m, specs) {
    if (scrolling && mode === m) return;
    if (scrolling) { // switching modes: kill the old loop first
      scrolling = false;
      if (timer) clearTimeout(timer);
      cols = null;
    }
    mode = m;
    if (m === 'columns') desiredCols = Array.isArray(specs) ? specs : [];
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
      startScroll(msg.mode || 'saved', normalizeSpecs(msg));
      sendResponse({ ok: true, pageKind: pageKind() });
    } else if (msg.type === 'NEXT_WAVE') {
      // batch waves: close this wave's columns, then open the next set of
      // feeds/searches on the same board — no page navigation between waves
      (async () => {
        scrolling = false;
        if (timer) clearTimeout(timer);
        timer = null;
        cols = null;
        await removeAddedColumns(); // waits for an in-flight teardown too
        await sleep(600);           // let the board settle before re-binding
        startScroll('columns', normalizeSpecs(msg));
      })();
      sendResponse({ ok: true });
    } else if (msg.type === 'TEARDOWN_COLUMNS') {
      // remove the columns this run added, and only THEN respond — the
      // service worker navigates away right after, which would cut an
      // async removal short
      (async () => {
        scrolling = false;
        if (timer) clearTimeout(timer);
        timer = null;
        cols = null;
        hideBanner();
        await removeAddedColumns();
        sendResponse({ ok: true });
      })();
      return true; // async sendResponse
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
