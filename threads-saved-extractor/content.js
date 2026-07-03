// content.js — isolated world. Relays captured batches from inject.js to the
// service worker and drives auto-scroll pagination on the /saved page.
(() => {
  'use strict';

  const SAVED_PATH = '/saved';

  // ---- scroll driver state ----
  let scrolling = false;
  let idleCycles = 0;     // cycles with no new batch AND no height growth
  let lastHeight = 0;
  let sawEnd = false;     // a captured page_info said has_next_page === false
  let timer = null;

  const IDLE_LIMIT = 8;   // ~8 quiet cycles (≈10s) => assume exhausted
  const STEP_MS_MIN = 900;
  const STEP_MS_MAX = 1500;

  function onSavedPage() {
    return location.pathname === SAVED_PATH || location.pathname === SAVED_PATH + '/';
  }

  function sendState(state, reason) {
    chrome.runtime.sendMessage({ type: 'SCROLL_STATE', state, reason }).catch(() => {});
  }

  // ---- relay batches from the MAIN-world script ----
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__tse !== true || d.type !== 'TSE_BATCH') return;
    chrome.runtime
      .sendMessage({ type: 'BATCH', posts: d.posts || [], pageInfo: d.pageInfo, origin: d.origin })
      .catch(() => {});
    if (scrolling) {
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
    if (sawEnd) return stopScroll('reached end of saved feed');

    const h = document.documentElement.scrollHeight;
    if (h === lastHeight) idleCycles++;
    else idleCycles = 0;
    lastHeight = h;

    if (idleCycles >= IDLE_LIMIT) return stopScroll('no new items — feed exhausted');

    window.scrollTo(0, h);
    sendState('running');
    timer = setTimeout(step, STEP_MS_MIN + Math.random() * (STEP_MS_MAX - STEP_MS_MIN));
  }

  function startScroll() {
    if (scrolling) return;
    if (!onSavedPage()) {
      // Navigate there; after the reload this script re-runs and resumes
      // because the service worker keeps grabbing=true.
      location.assign(SAVED_PATH);
      return;
    }
    scrolling = true;
    sawEnd = false;
    idleCycles = 0;
    lastHeight = 0;
    window.scrollTo(0, 0); // start from the top so the embedded first batch is on screen
    sendState('running');
    timer = setTimeout(step, 800);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_SCROLL') {
      startScroll();
      sendResponse({ ok: true, onSaved: onSavedPage() });
    } else if (msg.type === 'STOP_SCROLL') {
      scrolling = false;
      if (timer) clearTimeout(timer);
      sendState('stopped', 'stopped by user');
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, onSaved: onSavedPage(), scrolling });
    }
    return false;
  });

  // ---- resume after a navigation kicked off mid-grab ----
  chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((state) => {
    if (state && state.grabbing && onSavedPage()) startScroll();
  }).catch(() => {});
})();
