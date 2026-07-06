// popup.js — saved grab + multi-feed runs, live progress, exports.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    liveDot: $('liveDot'),
    tabSaved: $('tabSaved'), tabFeeds: $('tabFeeds'), tabProfile: $('tabProfile'),
    badgeSaved: $('badgeSaved'), badgeFeeds: $('badgeFeeds'), badgeProfile: $('badgeProfile'),
    paneSaved: $('paneSaved'), paneFeeds: $('paneFeeds'), paneProfile: $('paneProfile'),
    // saved
    count: $('count'), status: $('status'), savedBar: $('savedBar'),
    start: $('btnStart'), stop: $('btnStop'),
    json: $('btnJson'), csv: $('btnCsv'), md: $('btnMd'),
    clear: $('btnClear'),
    // feeds
    feedCount: $('feedCount'), feedStatus: $('feedStatus'),
    feedBar: $('feedBar'), feedBarFill: $('feedBarFill'),
    feedPicker: $('feedPicker'), feedHint: $('feedHint'), feedTarget: $('feedTarget'),
    selAll: $('selAll'), selNone: $('selNone'),
    feedStart: $('btnFeedStart'), colsStart: $('btnColsStart'), feedStop: $('btnFeedStop'),
    feedJson: $('btnFeedJson'), feedCsv: $('btnFeedCsv'), feedMd: $('btnFeedMd'),
    feedClear: $('btnFeedClear'),
    feedSelCount: $('feedSelCount'),
    // profile
    profCount: $('profCount'), profStatus: $('profStatus'), profBar: $('profBar'),
    profHandle: $('profHandle'),
    profThreads: $('btnProfThreads'), profReplies: $('btnProfReplies'), profStop: $('btnProfStop'),
    profJson: $('btnProfJson'), profCsv: $('btnProfCsv'), profMd: $('btnProfMd'),
    profClear: $('btnProfClear'),
  };

  const BUILTIN_FEEDS = [
    { name: 'For you', url: '/for_you/' },
    { name: 'Following', url: '/following/' },
    { name: 'Ghost posts', url: '/ghost_posts/' },
  ];

  let pollTimer = null;
  let selected = new Set();       // feed URLs the user ticked
  let renderedListKey = null;     // avoid rebuilding the picker every poll
  let lastState = null;
  let tabbedOnce = false;         // auto-focus the busy tab only on first poll

  // ---- tabs ----
  function showTab(which) {
    if (which !== 'saved' && which !== 'feeds' && which !== 'profile') which = 'feeds';
    els.tabSaved.classList.toggle('active', which === 'saved');
    els.tabFeeds.classList.toggle('active', which === 'feeds');
    els.tabProfile.classList.toggle('active', which === 'profile');
    els.paneSaved.classList.toggle('active', which === 'saved');
    els.paneFeeds.classList.toggle('active', which === 'feeds');
    els.paneProfile.classList.toggle('active', which === 'profile');
    try { localStorage.setItem('tse_tab', which); } catch (_) {}
  }
  $('btnDash').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  els.tabSaved.addEventListener('click', () => showTab('saved'));
  els.tabFeeds.addEventListener('click', () => showTab('feeds'));
  els.tabProfile.addEventListener('click', () => showTab('profile'));
  showTab((() => { try { return localStorage.getItem('tse_tab') || 'feeds'; } catch (_) { return 'feeds'; } })());

  function setStatus(el, text, isError) {
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function allFeeds(state) {
    const customs = ((state && state.feedList) || []).map((f) => ({
      name: f.name,
      url: `/custom_feed/${f.id}/`,
      group: 'custom',
    }));
    return BUILTIN_FEEDS.map((f) => Object.assign({ group: 'builtin' }, f)).concat(customs);
  }

  function saveSelection() {
    chrome.storage.local.set({ tse_feed_prefs: { selected: [...selected], target: parseInt(els.feedTarget.value, 10) || 100 } });
  }

  // per-poll refresh of live state on existing rows (badge, selected, active)
  function refreshRows(state) {
    const f = state.feed || {};
    const counts = f.counts || {};
    const active = new Set(
      f.running ? (f.activeNames || (f.currentName ? [f.currentName] : [])) : []
    );
    els.feedSelCount.textContent = selected.size ? `${selected.size} selected` : '';
    els.feedPicker.querySelectorAll('.feedItem').forEach((row) => {
      const name = row.dataset.name;
      row.classList.toggle('sel', selected.has(row.dataset.url));
      const isActive = active.has(name);
      row.classList.toggle('active', isActive);
      const n = counts[name];
      const cnt = row.querySelector('.fcount');
      const spin = row.querySelector('.spinner');
      // spinner on every feed being grabbed right now, count always visible
      // so parallel runs show all four climbing at once (0 until the first
      // batch, so the spinner never floats without its pill)
      spin.style.display = isActive ? '' : 'none';
      cnt.style.display = '';
      cnt.textContent = n != null ? String(n) : (isActive ? '0' : '');
    });
  }

  function makeRow(f) {
    const row = document.createElement('div');
    row.className = 'feedItem';
    row.dataset.name = f.name;
    row.dataset.url = f.url;
    row.setAttribute('role', 'button');
    const check = document.createElement('span');
    check.className = 'check';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = f.name;
    const cnt = document.createElement('span');
    cnt.className = 'fcount';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.style.display = 'none';
    row.append(check, nm, cnt, spin);
    row.addEventListener('click', () => {
      if (selected.has(f.url)) selected.delete(f.url); else selected.add(f.url);
      saveSelection();
      row.classList.toggle('sel', selected.has(f.url));
      els.feedSelCount.textContent = selected.size ? `${selected.size} selected` : '';
      renderButtons();
    });
    return row;
  }

  function renderPicker(state) {
    const feeds = allFeeds(state);
    els.feedHint.hidden = feeds.length > BUILTIN_FEEDS.length;
    const key = feeds.map((f) => f.url).join('|');
    if (key !== renderedListKey) {
      renderedListKey = key;
      els.feedPicker.textContent = '';
      const groups = [
        { id: 'builtin', label: 'Built-in' },
        { id: 'custom', label: 'Your custom feeds' },
      ];
      for (const g of groups) {
        const items = feeds.filter((f) => f.group === g.id);
        if (!items.length) continue;
        const head = document.createElement('div');
        head.className = 'feedGroup';
        head.textContent = g.label;
        els.feedPicker.appendChild(head);
        for (const f of items) els.feedPicker.appendChild(makeRow(f));
      }
    }
    refreshRows(state);
  }

  function setAll(on) {
    for (const f of allFeeds(lastState)) {
      if (on) selected.add(f.url); else selected.delete(f.url);
    }
    saveSelection();
    if (lastState) render(lastState);
  }
  els.selAll.addEventListener('click', () => setAll(true));
  els.selNone.addEventListener('click', () => setAll(false));

  function renderButtons() {
    const s = (lastState && lastState.saved) || {};
    const f = (lastState && lastState.feed) || {};
    const p = (lastState && lastState.profile) || {};
    const busy = !!f.running || !!s.grabbing || !!p.running;
    els.feedStart.disabled = busy || selected.size === 0;
    els.colsStart.disabled = busy || selected.size === 0;
  }

  function render(state) {
    lastState = state;
    const s = state.saved || {};
    const f = state.feed || {};
    const p = state.profile || {};
    const busy = !!s.grabbing || !!f.running || !!p.running;

    els.liveDot.classList.toggle('live', busy);
    els.badgeSaved.textContent = s.count || 0;
    els.badgeFeeds.textContent = f.count || 0;
    els.badgeProfile.textContent = p.count || 0;

    // first poll: jump to whichever tab is busy so progress is visible
    if (!tabbedOnce) {
      tabbedOnce = true;
      if (f.running) showTab('feeds');
      else if (p.running) showTab('profile');
      else if (s.grabbing) showTab('saved');
    }

    // ---- profile pane ----
    els.profCount.textContent = p.count || 0;
    const hasProf = (p.count || 0) > 0;
    els.profThreads.disabled = els.profReplies.disabled = busy;
    els.profStop.disabled = !p.running;
    els.profHandle.disabled = !!p.running;
    els.profJson.disabled = els.profCsv.disabled = els.profMd.disabled = !hasProf;
    els.profClear.disabled = !hasProf || !!p.running;
    els.profBar.classList.toggle('on', !!p.running);
    const profiles = p.profiles || {};
    const handles = Object.keys(profiles);
    if (p.running) {
      const who = p.isOwn ? 'my' : `@${p.target}`;
      setStatus(els.profStatus, `grabbing ${who} ${p.stage}… ${p.curCount || 0} so far`);
    } else if (p.lastError) {
      setStatus(els.profStatus, p.lastError, true);
    } else if (hasProf) {
      if (handles.length === 1) {
        const b = profiles[handles[0]];
        const parts = [];
        if (b.threads) parts.push(`${b.threads} threads`);
        if (b.replies) parts.push(`${b.replies} replies`);
        setStatus(els.profStatus, `${handles[0]} — ${parts.join(' · ')}`);
      } else {
        setStatus(els.profStatus, `${p.count} posts across ${handles.length} profiles`);
      }
    } else {
      setStatus(els.profStatus, 'grab a profile — yours or anyone’s');
    }

    // ---- saved pane ----
    els.count.textContent = s.count || 0;
    const hasSaved = (s.count || 0) > 0;
    els.start.disabled = busy;
    els.stop.disabled = !s.grabbing;
    els.json.disabled = els.csv.disabled = els.md.disabled = !hasSaved;
    els.clear.disabled = !hasSaved || !!s.grabbing;
    els.savedBar.classList.toggle('on', !!s.grabbing);
    if (s.lastError) {
      setStatus(els.status, s.lastError, true);
    } else if (s.grabbing) {
      setStatus(els.status, 'grabbing… scrolling the saved feed');
    } else if (s.hasNext === false && hasSaved) {
      setStatus(els.status, 'done — reached the end of the saved feed');
    } else {
      setStatus(els.status, hasSaved ? 'posts captured' : 'ready');
    }

    // ---- feeds pane ----
    els.feedCount.textContent = f.count || 0;
    const hasFeed = (f.count || 0) > 0;
    renderPicker(state);
    renderButtons();
    els.feedStop.disabled = !f.running;
    els.feedJson.disabled = els.feedCsv.disabled = els.feedMd.disabled = !hasFeed;
    els.feedClear.disabled = !hasFeed || !!f.running;

    els.feedBar.classList.toggle('on', !!f.running);
    if (f.running && f.parallel) {
      const qLen = (f.queue || []).length;
      const overall = qLen ? Math.min(1, (f.count || 0) / (f.target * qLen)) : 0;
      els.feedBarFill.style.width = Math.round(overall * 100) + '%';
      setStatus(els.feedStatus, qLen
        ? `board columns — ${f.doneCount || 0}/${qLen} feeds done · ${f.count || 0} posts`
        : 'board columns — finding feed columns…');
    } else if (f.running) {
      const qLen = (f.queue || []).length || 1;
      const inFeed = Math.min(1, (f.currentCount || 0) / (f.target || 1));
      const overall = Math.min(1, ((f.index || 0) + inFeed) / qLen);
      els.feedBarFill.style.width = Math.round(overall * 100) + '%';
      setStatus(els.feedStatus, `feed ${(f.index || 0) + 1} of ${qLen} — ${f.currentName || '…'} · ${f.currentCount || 0}/${f.target}`);
    } else if (f.lastError) {
      setStatus(els.feedStatus, f.lastError, true);
    } else if (hasFeed) {
      const feedsDone = Object.keys(f.counts || {}).length;
      setStatus(els.feedStatus, `done — ${f.count} posts from ${feedsDone} feed${feedsDone === 1 ? '' : 's'}`);
    } else {
      setStatus(els.feedStatus, 'select feeds, then run');
    }
  }

  async function refresh() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (state) render(state);
    } catch (_) {}
  }

  // ---- saved controls ----
  els.start.addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ type: 'START', mode: 'saved' });
    if (r && !r.ok) setStatus(els.status, r.error || 'could not start', true);
    refresh();
  });
  els.stop.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP', mode: 'saved' });
    refresh();
  });
  els.clear.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR', mode: 'saved' });
    refresh();
  });

  // ---- feed controls ----
  els.feedStart.addEventListener('click', async () => {
    const target = Math.max(1, Math.min(2000, parseInt(els.feedTarget.value, 10) || 100));
    els.feedTarget.value = target;
    saveSelection();
    const feeds = allFeeds(lastState).filter((f) => selected.has(f.url));
    const r = await chrome.runtime.sendMessage({ type: 'START_RUN', feeds, target });
    if (r && !r.ok) setStatus(els.feedStatus, r.error || 'could not start', true);
    refresh();
  });
  els.colsStart.addEventListener('click', async () => {
    const target = Math.max(1, Math.min(2000, parseInt(els.feedTarget.value, 10) || 100));
    els.feedTarget.value = target;
    saveSelection();
    const feeds = allFeeds(lastState).filter((f) => selected.has(f.url)).slice(0, 4);
    const r = await chrome.runtime.sendMessage({ type: 'START_COLUMNS', feeds, target });
    if (r && !r.ok) setStatus(els.feedStatus, r.error || 'could not start', true);
    refresh();
  });
  els.feedStop.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP', mode: 'feed' });
    refresh();
  });
  els.feedClear.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR', mode: 'feed' });
    refresh();
  });
  els.feedTarget.addEventListener('change', saveSelection);

  // ---- profile controls ----
  async function startProfile(stage) {
    const handle = els.profHandle.value.trim().replace(/^@/, '');
    const r = await chrome.runtime.sendMessage({ type: 'START_PROFILE', stage, handle });
    if (r && !r.ok) setStatus(els.profStatus, r.error || 'could not start', true);
    refresh();
  }
  els.profThreads.addEventListener('click', () => startProfile('threads'));
  els.profReplies.addEventListener('click', () => startProfile('replies'));
  els.profStop.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP', mode: 'profile' });
    refresh();
  });
  els.profClear.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR', mode: 'profile' });
    refresh();
  });

  // ---- exports ----
  async function getPosts(storageKey) {
    const got = await chrome.storage.local.get(storageKey);
    return Object.values(got[storageKey] || {});
  }

  function download(text, mime, prefix, ext) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download(
      { url, filename: `${prefix}-${stamp}.${ext}`, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 60000)
    );
  }

  els.json.addEventListener('click', async () =>
    download(TSEExport.toJSON(await getPosts('tse_posts')), 'application/json', 'threads-saved', 'json'));
  els.csv.addEventListener('click', async () =>
    download(TSEExport.toCSV(await getPosts('tse_posts')), 'text/csv', 'threads-saved', 'csv'));
  els.md.addEventListener('click', async () =>
    download(TSEExport.toMarkdown(await getPosts('tse_posts')), 'text/markdown', 'threads-saved', 'md'));

  els.feedJson.addEventListener('click', async () =>
    download(TSEExport.toJSON(await getPosts('tse_feed_posts')), 'application/json', 'threads-feeds', 'json'));
  els.feedCsv.addEventListener('click', async () =>
    download(TSEExport.toCSV(await getPosts('tse_feed_posts'), 'feed'), 'text/csv', 'threads-feeds', 'csv'));
  els.feedMd.addEventListener('click', async () =>
    download(TSEExport.toMarkdown(await getPosts('tse_feed_posts'), 'feed'), 'text/markdown', 'threads-feeds', 'md'));

  els.profJson.addEventListener('click', async () =>
    download(TSEExport.toJSON(await getPosts('tse_profile_posts')), 'application/json', 'threads-profile', 'json'));
  els.profCsv.addEventListener('click', async () =>
    download(TSEExport.toCSV(await getPosts('tse_profile_posts'), 'profile'), 'text/csv', 'threads-profile', 'csv'));
  els.profMd.addEventListener('click', async () =>
    download(TSEExport.toMarkdown(await getPosts('tse_profile_posts'), 'profile'), 'text/markdown', 'threads-profile', 'md'));

  // restore last-used selection + target, then start polling
  chrome.storage.local.get('tse_feed_prefs').then((got) => {
    const prefs = got.tse_feed_prefs || {};
    selected = new Set(prefs.selected || []);
    if (prefs.target) els.feedTarget.value = prefs.target;
  }).catch(() => {}).finally(() => {
    refresh();
    pollTimer = setInterval(refresh, 800);
  });
  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
