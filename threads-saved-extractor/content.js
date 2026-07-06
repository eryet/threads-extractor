// content.js — isolated world. Relays captured batches from inject.js to the
// service worker and drives auto-scroll pagination on the /saved page or on a
// feed page (For you / Following / Ghost posts / custom feeds).
(() => {
  'use strict';

  const SAVED_RE = /^\/saved\/?$/;
  // single-column feed pages that window-scroll (the "/" board layout does not)
  const FEED_RE = /^\/(for_you|following|ghost_posts|custom_feed\/[^/]+)\/?$/;
  // a profile root or its replies tab (NOT /@user/post/… permalinks)
  const PROFILE_RE = /^\/@[^/]+(?:\/replies)?\/?$/;

  // ---- scroll driver state ----
  let scrolling = false;
  let mode = null;        // 'saved' | 'feed' while scrolling
  let idleCycles = 0;     // cycles with no new batch AND no height growth
  let lastHeight = 0;
  let sawEnd = false;     // a captured page_info said has_next_page === false
  let timer = null;

  const IDLE_LIMIT = 8;   // ~8 quiet cycles (≈10s) => assume exhausted
  const STEP_MS_MIN = 900;
  const STEP_MS_MAX = 1500;

  function pageKind() {
    if (SAVED_RE.test(location.pathname)) return 'saved';
    if (FEED_RE.test(location.pathname)) return 'feed';
    if (PROFILE_RE.test(location.pathname)) return 'profile';
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

  function sendState(state, reason) {
    chrome.runtime.sendMessage({ type: 'SCROLL_STATE', mode, state, reason }).catch(() => {});
  }

  // ---- relay batches + the discovered feed list from the MAIN-world script ----
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__tse !== true) return;
    if (d.type === 'TSE_FEEDS') {
      chrome.runtime.sendMessage({ type: 'FEEDS', feeds: d.feeds || [] }).catch(() => {});
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
      path: location.pathname,
    };
    if (msg.kind === 'feed') msg.feedName = currentFeedName();
    chrome.runtime.sendMessage(msg).catch(() => {});
    if (scrolling && msg.kind === mode) {
      idleCycles = 0;
      if (d.pageInfo && d.pageInfo.has_next_page === false) sawEnd = true;
    }
  });

  // ---- auto-scroll loop ----
  function stopScroll(reason) {
    scrolling = false;
    if (timer) clearTimeout(timer);
    timer = null;
    sendState('done', reason);
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

  function startScroll(m) {
    if (scrolling && mode === m) return;
    if (scrolling) { // switching modes: kill the old loop first
      scrolling = false;
      if (timer) clearTimeout(timer);
    }
    mode = m;
    if (pageKind() !== m) {
      if (m === 'saved') {
        // Navigate there; after the reload this script re-runs and the
        // service worker restarts the grab via CONTENT_READY.
        location.assign('/saved');
      }
      // feed mode: the service worker drives navigation itself — if we're not
      // on a feed page yet, a navigation is already on its way.
      return;
    }
    scrolling = true;
    sawEnd = false;
    idleCycles = 0;
    lastHeight = 0;
    window.scrollTo(0, 0); // start from the top so the first batch is on screen
    // Ask inject.js to replay everything it captured before the grab started
    // (server-embedded first batch, any manual pre-scrolling).
    window.postMessage({ __tse: true, type: 'TSE_RESCAN' }, window.location.origin);
    sendState('running');
    timer = setTimeout(step, 800);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SCROLL') {
      startScroll(msg.mode || 'saved');
      sendResponse({ ok: true, pageKind: pageKind() });
    } else if (msg.type === 'STOP_SCROLL') {
      scrolling = false;
      if (timer) clearTimeout(timer);
      sendState('stopped', msg.reason || 'stopped');
      sendResponse({ ok: true });
    } else if (msg.type === 'GET_USERNAME') {
      sendResponse({ username: ownUsername() });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, pageKind: pageKind(), scrolling, mode });
    }
    return false;
  });

  // ---- announce readiness; the service worker decides whether to (re)start
  // scrolling here (single-feed resume, or the next stop of a multi-feed run)
  chrome.runtime.sendMessage({
    type: 'CONTENT_READY',
    path: location.pathname,
    kind: pageKind(),
  }).catch(() => {});
})();
