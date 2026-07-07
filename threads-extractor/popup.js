// popup.js — saved grab + multi-feed runs, live progress, exports.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (k, subs) => TSEI18n.t(k, subs);
  const terr = (s) => TSEI18n.translateError(s);
  const els = {
    liveDot: $('liveDot'),
    tabSaved: $('tabSaved'), tabLiked: $('tabLiked'), tabFeeds: $('tabFeeds'), tabProfile: $('tabProfile'),
    badgeSaved: $('badgeSaved'), badgeLiked: $('badgeLiked'), badgeFeeds: $('badgeFeeds'), badgeProfile: $('badgeProfile'),
    paneSaved: $('paneSaved'), paneLiked: $('paneLiked'), paneFeeds: $('paneFeeds'), paneProfile: $('paneProfile'),
    // saved
    count: $('count'), status: $('status'), savedBar: $('savedBar'),
    savedLimit: $('savedLimit'), savedUntil: $('savedUntil'),
    start: $('btnStart'), stop: $('btnStop'),
    json: $('btnJson'), csv: $('btnCsv'), md: $('btnMd'),
    clear: $('btnClear'),
    // liked
    likedCount: $('likedCount'), likedStatus: $('likedStatus'), likedBar: $('likedBar'),
    likedLimit: $('likedLimit'), likedUntil: $('likedUntil'),
    likedStart: $('btnLikedStart'), likedStop: $('btnLikedStop'),
    likedJson: $('btnLikedJson'), likedCsv: $('btnLikedCsv'), likedMd: $('btnLikedMd'),
    likedClear: $('btnLikedClear'),
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
    // storage meter
    storeRow: $('storeRow'), storeFill: $('storeFill'),
    storeTxt: $('storeTxt'), storeHint: $('storeHint'),
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
    if (!['saved', 'liked', 'feeds', 'profile'].includes(which)) which = 'feeds';
    els.tabSaved.classList.toggle('active', which === 'saved');
    els.tabLiked.classList.toggle('active', which === 'liked');
    els.tabFeeds.classList.toggle('active', which === 'feeds');
    els.tabProfile.classList.toggle('active', which === 'profile');
    els.paneSaved.classList.toggle('active', which === 'saved');
    els.paneLiked.classList.toggle('active', which === 'liked');
    els.paneFeeds.classList.toggle('active', which === 'feeds');
    els.paneProfile.classList.toggle('active', which === 'profile');
    try { localStorage.setItem('tse_tab', which); } catch (_) {}
  }
  $('btnDash').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  els.tabSaved.addEventListener('click', () => showTab('saved'));
  els.tabLiked.addEventListener('click', () => showTab('liked'));
  els.tabFeeds.addEventListener('click', () => showTab('feeds'));
  els.tabProfile.addEventListener('click', () => showTab('profile'));
  showTab((() => { try { return localStorage.getItem('tse_tab') || 'feeds'; } catch (_) { return 'feeds'; } })());

  function setStatus(el, text, isError) {
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function allFeeds(state) {
    // drop built-in pseudo-entries that some surfaces interleave into the
    // discovered custom list (they already have fixed rows above)
    const builtinNames = new Set(BUILTIN_FEEDS.map((f) => f.name.toLowerCase()));
    const customs = ((state && state.feedList) || [])
      .filter((f) => /^\d+$/.test(String(f.id)) && !builtinNames.has(String(f.name || '').trim().toLowerCase()))
      .map((f) => ({
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
    els.feedSelCount.textContent = selected.size ? t('sel_count', { n: selected.size }) : '';
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
      els.feedSelCount.textContent = selected.size ? t('sel_count', { n: selected.size }) : '';
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
        { id: 'builtin', label: t('group_builtin') },
        { id: 'custom', label: t('group_custom') },
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
    const lk = (lastState && lastState.liked) || {};
    const busy = !!f.running || !!s.grabbing || !!lk.grabbing || !!p.running;
    els.feedStart.disabled = busy || selected.size === 0;
    els.colsStart.disabled = busy || selected.size === 0;
  }

  function render(state) {
    lastState = state;
    const s = state.saved || {};
    const lk = state.liked || {};
    const f = state.feed || {};
    const p = state.profile || {};
    const busy = !!s.grabbing || !!lk.grabbing || !!f.running || !!p.running;

    els.liveDot.classList.toggle('live', busy);
    // compact so a big capture can't stretch its tab (12345 -> 12.3k)
    const fmtB = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
    els.badgeSaved.textContent = fmtB(s.count || 0);
    els.badgeLiked.textContent = fmtB(lk.count || 0);
    els.badgeFeeds.textContent = fmtB(f.count || 0);
    els.badgeProfile.textContent = fmtB(p.count || 0);

    // first poll: jump to whichever tab is busy so progress is visible
    if (!tabbedOnce) {
      tabbedOnce = true;
      if (f.running) showTab('feeds');
      else if (p.running) showTab('profile');
      else if (lk.grabbing) showTab('liked');
      else if (s.grabbing) showTab('saved');
    }

    // ---- liked pane ----
    els.likedCount.textContent = lk.count || 0;
    const hasLiked = (lk.count || 0) > 0;
    els.likedStart.disabled = busy;
    els.likedStop.disabled = !lk.grabbing;
    els.likedJson.disabled = els.likedCsv.disabled = els.likedMd.disabled = !hasLiked;
    els.likedClear.disabled = !hasLiked || !!lk.grabbing;
    els.likedBar.classList.toggle('on', !!lk.grabbing);
    if (lk.lastError) {
      setStatus(els.likedStatus, terr(lk.lastError), true);
    } else if (lk.grabbing) {
      setStatus(els.likedStatus, t('st_grabbing_liked'));
    } else if (lk.stopNote) {
      setStatus(els.likedStatus, t(lk.stopNote === 'date' ? 'st_stopped_date' : 'st_stopped_limit'));
    } else if (lk.hasNext === false && hasLiked) {
      setStatus(els.likedStatus, t('st_liked_done'));
    } else {
      setStatus(els.likedStatus, hasLiked ? t('st_posts_captured') : t('st_ready'));
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
      const who = p.isOwn ? t('who_my') : `@${p.target}`;
      const stage = t(p.stage === 'replies' ? 'stage_replies' : 'stage_threads');
      setStatus(els.profStatus, t('st_prof_grabbing', { who, stage, n: p.curCount || 0 }));
    } else if (p.lastError) {
      setStatus(els.profStatus, terr(p.lastError), true);
    } else if (hasProf) {
      if (handles.length === 1) {
        const b = profiles[handles[0]];
        const parts = [];
        if (b.threads) parts.push(t('n_threads', { n: b.threads }));
        if (b.replies) parts.push(t('n_replies', { n: b.replies }));
        setStatus(els.profStatus, `${handles[0]} — ${parts.join(' · ')}`);
      } else {
        setStatus(els.profStatus, t('st_prof_multi', { count: p.count, n: handles.length }));
      }
    } else {
      setStatus(els.profStatus, t('st_prof_ready'));
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
      setStatus(els.status, terr(s.lastError), true);
    } else if (s.grabbing) {
      setStatus(els.status, t('st_grabbing_saved'));
    } else if (s.stopNote) {
      setStatus(els.status, t(s.stopNote === 'date' ? 'st_stopped_date' : 'st_stopped_limit'));
    } else if (s.hasNext === false && hasSaved) {
      setStatus(els.status, t('st_saved_done'));
    } else {
      setStatus(els.status, hasSaved ? t('st_posts_captured') : t('st_ready'));
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
      // progress across ALL waves, not just the columns currently open
      const totalFeeds = qLen + (f.waveQueueLen || 0) + ((f.wave || 1) - 1) * 4;
      const overall = totalFeeds ? Math.min(1, (f.count || 0) / (f.target * totalFeeds)) : 0;
      els.feedBarFill.style.width = Math.round(overall * 100) + '%';
      const waves = (f.wavesTotal || 1) > 1;
      setStatus(els.feedStatus, qLen
        ? (waves
          ? t('st_columns_wave', { w: f.wave || 1, ws: f.wavesTotal, done: f.doneCount || 0, n: qLen, count: f.count || 0 })
          : t('st_columns_progress', { done: f.doneCount || 0, n: qLen, count: f.count || 0 }))
        : t('st_columns_finding'));
    } else if (f.running) {
      const qLen = (f.queue || []).length || 1;
      const inFeed = Math.min(1, (f.currentCount || 0) / (f.target || 1));
      const overall = Math.min(1, ((f.index || 0) + inFeed) / qLen);
      els.feedBarFill.style.width = Math.round(overall * 100) + '%';
      setStatus(els.feedStatus, t('st_feed_progress', {
        i: (f.index || 0) + 1, n: qLen, name: f.currentName || '…',
        cur: f.currentCount || 0, target: f.target,
      }));
    } else if (f.lastError) {
      setStatus(els.feedStatus, terr(f.lastError), true);
    } else if (hasFeed) {
      const feedsDone = Object.keys(f.counts || {}).length;
      setStatus(els.feedStatus, t('st_feed_done', { count: f.count, n: feedsDone }));
    } else {
      setStatus(els.feedStatus, t('st_select_feeds'));
    }

    // ---- storage meter ----
    const sg = state.storage || {};
    if (sg.quota) {
      const pct = Math.min(1, (sg.bytes || 0) / sg.quota);
      const full = !!sg.full || pct >= 0.97;
      const warn = !full && pct >= 0.8;
      els.storeRow.hidden = false;
      els.storeRow.classList.toggle('warn', warn);
      els.storeRow.classList.toggle('full', full);
      els.storeFill.style.width = Math.max(1, Math.round(pct * 100)) + '%';
      els.storeTxt.textContent = t('storage_used', {
        used: ((sg.bytes || 0) / 1048576).toFixed(1),
        quota: Math.round(sg.quota / 1048576),
      });
      els.storeHint.hidden = !(warn || full);
      if (warn || full) els.storeHint.textContent = t(full ? 'storage_full' : 'storage_low');
    }
  }

  async function refresh() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (state) render(state);
    } catch (_) {}
  }

  // ---- saved controls ----
  function grabLimits(limitEl, untilEl) {
    return {
      limit: parseInt(limitEl.value, 10) > 0 ? parseInt(limitEl.value, 10) : null,
      until: untilEl.value || null,
    };
  }
  function saveGrabPrefs() {
    chrome.storage.local.set({
      tse_grab_prefs: {
        saved: grabLimits(els.savedLimit, els.savedUntil),
        liked: grabLimits(els.likedLimit, els.likedUntil),
      },
    });
  }
  els.savedLimit.addEventListener('change', saveGrabPrefs);
  els.savedUntil.addEventListener('change', saveGrabPrefs);
  els.likedLimit.addEventListener('change', saveGrabPrefs);
  els.likedUntil.addEventListener('change', saveGrabPrefs);

  els.start.addEventListener('click', async () => {
    saveGrabPrefs();
    const r = await chrome.runtime.sendMessage(
      Object.assign({ type: 'START', mode: 'saved' }, grabLimits(els.savedLimit, els.savedUntil)));
    if (r && !r.ok) setStatus(els.status, terr(r.error) || t('st_could_not_start'), true);
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

  // ---- liked controls ----
  els.likedStart.addEventListener('click', async () => {
    saveGrabPrefs();
    const r = await chrome.runtime.sendMessage(
      Object.assign({ type: 'START', mode: 'liked' }, grabLimits(els.likedLimit, els.likedUntil)));
    if (r && !r.ok) setStatus(els.likedStatus, terr(r.error) || t('st_could_not_start'), true);
    refresh();
  });
  els.likedStop.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP', mode: 'liked' });
    refresh();
  });
  els.likedClear.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR', mode: 'liked' });
    refresh();
  });

  // ---- feed controls ----
  els.feedStart.addEventListener('click', async () => {
    const target = Math.max(1, Math.min(2000, parseInt(els.feedTarget.value, 10) || 100));
    els.feedTarget.value = target;
    saveSelection();
    const feeds = allFeeds(lastState).filter((f) => selected.has(f.url));
    const r = await chrome.runtime.sendMessage({ type: 'START_RUN', feeds, target });
    if (r && !r.ok) setStatus(els.feedStatus, terr(r.error) || t('st_could_not_start'), true);
    refresh();
  });
  els.colsStart.addEventListener('click', async () => {
    const target = Math.max(1, Math.min(2000, parseInt(els.feedTarget.value, 10) || 100));
    els.feedTarget.value = target;
    saveSelection();
    const feeds = allFeeds(lastState).filter((f) => selected.has(f.url));
    const r = await chrome.runtime.sendMessage({ type: 'START_COLUMNS', feeds, target });
    if (r && !r.ok) setStatus(els.feedStatus, terr(r.error) || t('st_could_not_start'), true);
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
    if (r && !r.ok) setStatus(els.profStatus, terr(r.error) || t('st_could_not_start'), true);
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

  els.likedJson.addEventListener('click', async () =>
    download(TSEExport.toJSON(await getPosts('tse_liked_posts')), 'application/json', 'threads-liked', 'json'));
  els.likedCsv.addEventListener('click', async () =>
    download(TSEExport.toCSV(await getPosts('tse_liked_posts'), 'liked'), 'text/csv', 'threads-liked', 'csv'));
  els.likedMd.addEventListener('click', async () =>
    download(TSEExport.toMarkdown(await getPosts('tse_liked_posts'), 'liked'), 'text/markdown', 'threads-liked', 'md'));

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

  // resolve language, restore last-used selection + target, then poll
  TSEI18n.init().then(() => {
    TSEI18n.apply();
    return chrome.storage.local.get(['tse_feed_prefs', 'tse_grab_prefs']);
  }).then((got) => {
    const prefs = got.tse_feed_prefs || {};
    selected = new Set(prefs.selected || []);
    if (prefs.target) els.feedTarget.value = prefs.target;
    const gp = got.tse_grab_prefs || {};
    if (gp.saved) {
      if (gp.saved.limit) els.savedLimit.value = gp.saved.limit;
      if (gp.saved.until) els.savedUntil.value = gp.saved.until;
    }
    if (gp.liked) {
      if (gp.liked.limit) els.likedLimit.value = gp.liked.limit;
      if (gp.liked.until) els.likedUntil.value = gp.liked.until;
    }
  }).catch(() => {}).finally(() => {
    refresh();
    pollTimer = setInterval(refresh, 800);
  });
  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
