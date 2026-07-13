// sw.js — service worker: message hub, dedupe, storage, multi-feed run driver.
// Storage layout (chrome.storage.local):
//   tse_posts      : { [id]: normalizedPost }                  (saved posts)
//   tse_state      : { grabbing, hasNext, lastBatchAt, lastError, orderCounter }
//   tse_feed_posts : { [feedUrl + '|' + id]: normalizedPost }  (feed runs)
//   tse_feed_state : run state — see FEED_STATE_DEFAULTS
//   tse_feed_list  : { feeds: [{name, id}], at }               (discovered custom feeds)
importScripts('lib/normalize.js');

let mem = null;              // in-memory mirror of storage
let persistQueue = Promise.resolve(); // serializes writes
let storageFull = false;     // last persist hit the quota — surfaced via GET_STATE

const STORAGE_FULL_ERR = 'Storage is full — capture stopped. Export, then delete old posts to free space.';

const WATCHDOG = 'tse-watchdog';
const STALL_MS = 60000;      // no progress for this long => skip to next feed

const FEED_STATE_DEFAULTS = {
  running: false,
  parallel: false,           // false: navigate feed→feed; true: board columns run
  queue: [],                 // [{name, url}] snapshot taken at run start
  index: 0,                  // current position in queue (sequential runs)
  target: 100,               // posts per feed
  counts: {},                // feed name -> captured count
  feedEnded: {},             // parallel: feed url -> has_next_page === false seen
  orderCounters: {},         // parallel: feed url -> per-feed order counter
  waveQueue: [],             // parallel: feeds waiting for the next wave of 4
  wave: 1,                   // parallel: current wave number (1-based)
  wavesTotal: 1,             // parallel: total waves for this run
  waveBound: false,          // parallel: current wave's COLUMNS_INFO arrived
  awaitingNav: false,        // navigated, waiting for CONTENT_READY on the new page
  tabId: null,               // tab the run drives (persisted: survives SW restarts)
  orderCounter: 0,           // per-feed, reset on advance (sequential runs)
  hasNext: null,
  lastProgressAt: null,      // watchdog heartbeat (nav / batches)
  lastBatchAt: null,
  lastError: null,
};

const PROFILE_STATE_DEFAULTS = {
  running: false,
  target: null,              // handle being grabbed (own, or any other user)
  isOwn: true,               // whether target resolved from the nav sidebar
  stage: 'threads',          // which section this grab targets: 'threads' | 'replies'
  awaitingNav: false,
  tabId: null,
  orderCounter: 0,           // per grab
  curCount: 0,               // posts captured in the current grab
  hasNext: null,
  lastProgressAt: null,
  lastBatchAt: null,
  lastError: null,
};

async function getStore() {
  if (!mem) {
    const got = await chrome.storage.local.get([
      'tse_posts', 'tse_state', 'tse_feed_posts', 'tse_feed_state', 'tse_feed_list',
      'tse_profile_posts', 'tse_profile_state', 'tse_liked_posts', 'tse_liked_state',
    ]);
    const SCROLL_STATE_DEFAULTS = {
      grabbing: false, hasNext: null, lastBatchAt: null, lastError: null, orderCounter: 0,
      limit: null,       // stop after this many posts added in one grab
      until: null,       // stop once a whole batch is older than this date (YYYY-MM-DD)
      grabAdded: 0,      // posts added by the current grab
      stopNote: null,    // 'limit' | 'date' — why the grab auto-stopped
    };
    mem = {
      posts: got.tse_posts || {},
      state: Object.assign({}, SCROLL_STATE_DEFAULTS, got.tse_state),
      likedPosts: got.tse_liked_posts || {},
      likedState: Object.assign({}, SCROLL_STATE_DEFAULTS, got.tse_liked_state),
      feedPosts: got.tse_feed_posts || {},
      // fresh object fields so persisted pre-parallel states never share (and
      // mutate) the DEFAULTS references
      feedState: Object.assign({}, FEED_STATE_DEFAULTS, { feedEnded: {}, orderCounters: {} }, got.tse_feed_state),
      feedList: got.tse_feed_list || { feeds: [], at: null },
      profilePosts: got.tse_profile_posts || {},
      profileState: Object.assign({}, PROFILE_STATE_DEFAULTS, got.tse_profile_state),
    };
  }
  return mem;
}

function persist() {
  persistQueue = persistQueue.then(() =>
    chrome.storage.local.set({
      tse_posts: mem.posts, tse_state: mem.state,
      tse_liked_posts: mem.likedPosts, tse_liked_state: mem.likedState,
      tse_feed_posts: mem.feedPosts, tse_feed_state: mem.feedState,
      tse_feed_list: mem.feedList,
      tse_profile_posts: mem.profilePosts, tse_profile_state: mem.profileState,
    }).then(
      () => { storageFull = false; },
      () => {
        // Quota hit. Swallow the rejection — a rejected tail would silently
        // skip every later persist — and stop the grabs so scrolling doesn't
        // keep capturing into the void. The error state only lives in mem
        // (it can't be persisted while over quota), but GET_STATE reads mem,
        // so the popup still shows it.
        storageFull = true;
        haltAllGrabs(STORAGE_FULL_ERR);
      }
    )
  );
  return persistQueue;
}

function haltAllGrabs(err) {
  if (!mem) return;
  for (const st of [mem.state, mem.likedState]) {
    if (st.grabbing) { st.grabbing = false; st.lastError = err; }
  }
  if (mem.feedState.running) { mem.feedState.running = false; mem.feedState.lastError = err; }
  if (mem.profileState.running) { mem.profileState.running = false; mem.profileState.lastError = err; }
  chrome.tabs.query({ url: ['https://www.threads.com/*', 'https://threads.com/*'] }, (tabs) => {
    for (const tb of tabs || []) chrome.tabs.sendMessage(tb.id, { type: 'STOP_SCROLL' }).catch(() => {});
  });
}

// tse_errlog: ring buffer of the last unexpected errors ({at, where, msg}),
// persisted so failures survive the SW's ~30s idle teardown. Inspect from any
// extension page devtools: chrome.storage.local.get('tse_errlog')
const ERRLOG_MAX = 20;
function logError(where, e) {
  const entry = { at: new Date().toISOString(), where, msg: String((e && e.message) || e) };
  chrome.storage.local.get('tse_errlog').then((got) => {
    const log = Array.isArray(got.tse_errlog) ? got.tse_errlog : [];
    log.push(entry);
    while (log.length > ERRLOG_MAX) log.shift();
    return chrome.storage.local.set({ tse_errlog: log });
  }).catch(() => {});
}

// surface an unexpected error on whichever mode is mid-grab (popup shows it)
function stampActiveError(err) {
  if (!mem) return;
  for (const st of [mem.state, mem.likedState]) {
    if (st.grabbing) st.lastError = err;
  }
  if (mem.feedState.running) mem.feedState.lastError = err;
  if (mem.profileState.running) mem.profileState.lastError = err;
}

function normPath(p) {
  return String(p || '').replace(/\/+$/, '') || '/';
}

function currentFeed(st) {
  return st.queue[st.index] || null;
}

const BUILTIN_FEED_NAMES = {
  '/for_you/': 'For you',
  '/following/': 'Following',
  '/ghost_posts/': 'Ghost posts',
};

function resolveFeedName(store, url) {
  if (BUILTIN_FEED_NAMES[url]) return BUILTIN_FEED_NAMES[url];
  const m = url.match(/^\/custom_feed\/([^/]+)\//);
  if (m) {
    const f = (store.feedList.feeds || []).find((x) => String(x.id) === m[1]);
    return f ? f.name : 'Custom feed ' + m[1];
  }
  return url;
}

// multi-item threads arrive with the parent chained on the raw node — keep
// the full replied-to post on the normalized record (all capture modes)
function attachReplyTo(p, raw, now) {
  if (!raw || !raw.__tsePrevPost) return;
  const parent = self.TSENormalize.normalizePost(raw.__tsePrevPost, now);
  if (parent) {
    delete parent.savedAt; // meaningless on a reply parent
    p.replyTo = parent;
  }
}

// parallel runs: feeds that hit their target or ran out of posts
function parallelDone(st) {
  return st.queue
    .filter((f) => (st.counts[f.name] || 0) >= st.target || st.feedEnded[f.url])
    .map((f) => f.url);
}

// wipe live-captured feed posts but keep imported ones (their keys are
// prefixed "import:") — imports are restored backups, not run snapshots
function clearLiveFeedPosts(store) {
  for (const k of Object.keys(store.feedPosts)) {
    if (!k.startsWith('import:')) delete store.feedPosts[k];
  }
}

async function findThreadsTab() {
  const tabs = await chrome.tabs.query({ url: ['https://www.threads.com/*', 'https://threads.com/*'] });
  if (!tabs.length) return null;
  // prefer active tab, then the saved page, then the first
  return tabs.find((t) => t.active) || tabs.find((t) => (t.url || '').includes('/saved')) || tabs[0];
}

// ---- multi-feed run driving ----

function touchProgress(st) {
  st.lastProgressAt = new Date().toISOString();
}

async function navigateToCurrent(store) {
  const st = store.feedState;
  const feed = currentFeed(st);
  if (!feed) return finishRun(store);
  st.awaitingNav = true;
  st.orderCounter = 0;
  st.hasNext = null;
  touchProgress(st);
  await persist();
  try {
    await chrome.tabs.update(st.tabId, { url: 'https://www.threads.com' + feed.url });
  } catch (e) {
    st.lastError = 'Lost the Threads tab mid-run.';
    await finishRun(store);
  }
}

async function advanceFeed(store) {
  const st = store.feedState;
  if (!st.running) return;
  st.index++;
  if (st.index >= st.queue.length) return finishRun(store);
  await navigateToCurrent(store);
}

function maybeClearWatchdog(store) {
  if (!store.feedState.running && !store.profileState.running) {
    chrome.alarms.clear(WATCHDOG).catch(() => {});
  }
}

async function finishRun(store) {
  const st = store.feedState;
  st.running = false;
  st.awaitingNav = false;
  st.waveQueue = [];
  maybeClearWatchdog(store);
  if (st.tabId != null) {
    chrome.tabs.sendMessage(st.tabId, { type: 'STOP_SCROLL' }).catch(() => {});
  }
  await persist();
}

// batch waves: current wave's columns are done — hand the next 4 feeds to the
// content script, which tears down this wave's columns and opens the new ones
async function startNextWave(store) {
  const st = store.feedState;
  st.queue = st.waveQueue.slice(0, 4);
  st.waveQueue = st.waveQueue.slice(4);
  st.wave = (st.wave || 1) + 1;
  st.feedEnded = {};
  st.waveBound = false;
  touchProgress(st);
  await persist();
  try {
    await chrome.tabs.sendMessage(st.tabId, { type: 'NEXT_WAVE', feeds: st.queue });
  } catch (e) {
    st.lastError = 'Lost the Threads tab between batch waves.';
    await finishRun(store);
  }
}

// ---- profile run driving (threads stage -> optional replies stage) ----

function profileStagePath(st) {
  return '/@' + st.target + (st.stage === 'replies' ? '/replies' : '');
}

async function navigateToProfileStage(store) {
  const st = store.profileState;
  st.awaitingNav = true;
  st.orderCounter = 0;
  st.hasNext = null;
  touchProgress(st);
  await persist();
  try {
    await chrome.tabs.update(st.tabId, { url: 'https://www.threads.com' + profileStagePath(st) });
  } catch (e) {
    st.lastError = 'Lost the Threads tab mid-grab.';
    await finishProfile(store);
  }
}

async function advanceProfile(store) {
  // threads and replies are grabbed separately — a grab is one stage
  await finishProfile(store);
}

async function finishProfile(store) {
  const st = store.profileState;
  st.running = false;
  st.awaitingNav = false;
  maybeClearWatchdog(store);
  if (st.tabId != null) {
    chrome.tabs.sendMessage(st.tabId, { type: 'STOP_SCROLL' }).catch(() => {});
  }
  await persist();
}

// Post-limit / date-cutoff for saved & liked grabs. The feeds are ordered by
// save/like recency (not post date), so the date cutoff fires only when an
// ENTIRE batch is older — one old post saved recently shouldn't end the grab.
function checkGrabLimits(st, msg, added, senderTabId) {
  if (!st.grabbing) return;
  st.grabAdded = (st.grabAdded || 0) + added;
  let stop = null;
  if (st.limit && st.grabAdded >= st.limit) {
    stop = 'limit';
  } else if (st.until && (msg.posts || []).length) {
    const cutoff = Date.parse(st.until);
    if (!Number.isNaN(cutoff) &&
        msg.posts.every((raw) => raw && raw.taken_at && raw.taken_at * 1000 < cutoff)) {
      stop = 'date';
    }
  }
  if (stop) {
    st.grabbing = false;
    st.stopNote = stop;
    if (senderTabId != null) {
      chrome.tabs.sendMessage(senderTabId, { type: 'STOP_SCROLL' }).catch(() => {});
    }
  }
}

async function handleSavedBatch(msg, sender) {
  const store = await getStore();
  const now = new Date().toISOString();
  let added = 0, bad = 0;
  for (const raw of msg.posts || []) {
    try {
      const p = self.TSENormalize.normalizePost(raw, now);
      if (p && !store.posts[p.id]) {
        // The saved feed is ordered by save recency (Threads exposes no saved
        // timestamp — verified: pagination cursors are opaque signed blobs).
        // Capture order is therefore the best available proxy: 1 = saved most
        // recently. Accurate for a clean top-to-bottom grab (Clear -> Grab).
        p.savedOrder = ++store.state.orderCounter;
        attachReplyTo(p, raw, now);
        store.posts[p.id] = p;
        added++;
      }
    } catch (e) { bad++; }
  }
  if (bad) logError('normalize:saved', bad + ' post(s) failed to parse — skipped');
  if (msg.pageInfo && typeof msg.pageInfo.has_next_page === 'boolean') {
    store.state.hasNext = msg.pageInfo.has_next_page;
  }
  store.state.lastBatchAt = now;
  checkGrabLimits(store.state, msg, added, sender && sender.tab && sender.tab.id);
  if (added || msg.pageInfo) await persist();
  return { added, count: Object.keys(store.posts).length };
}

// Board-columns run: several feeds paginate at once in the same tab, so
// attribution comes from msg.feedUrl (derived from the request variables by
// inject.js) instead of "the feed we navigated to".
async function handleColumnsBatch(store, msg) {
  const st = store.feedState;
  const total = () => Object.keys(store.feedPosts).length;
  const url = msg.feedUrl ? normPath(msg.feedUrl) + '/' : null;
  const feed = url && st.queue.find((f) => f.url === url);
  if (!feed) return { added: 0, count: total(), doneFeeds: parallelDone(st) };

  const now = new Date().toISOString();
  let added = 0, bad = 0;
  for (const raw of msg.posts || []) {
    if ((st.counts[feed.name] || 0) >= st.target) break;
    try {
      const p = self.TSENormalize.normalizePost(raw, now);
      if (!p) continue;
      const key = feed.url + '|' + p.id;
      if (store.feedPosts[key]) continue;
      p.feed = feed.name;
      // run-global index: waves reuse queue slots 0-3, exports group by this
      p.feedIndex = ((st.wave || 1) - 1) * 4 + st.queue.indexOf(feed);
      p.feedOrder = (st.orderCounters[feed.url] = (st.orderCounters[feed.url] || 0) + 1);
      attachReplyTo(p, raw, now);
      store.feedPosts[key] = p;
      st.counts[feed.name] = (st.counts[feed.name] || 0) + 1;
      added++;
    } catch (e) { bad++; }
  }
  if (bad) logError('normalize:feed-columns', bad + ' post(s) failed to parse — skipped');
  if (msg.pageInfo && msg.pageInfo.has_next_page === false) st.feedEnded[feed.url] = true;
  st.lastBatchAt = now;
  touchProgress(st);
  const doneFeeds = parallelDone(st);
  if (st.queue.length && doneFeeds.length >= st.queue.length) {
    if ((st.waveQueue || []).length) await startNextWave(store);
    else await finishRun(store);
  } else {
    await persist();
  }
  return { added, count: total(), doneFeeds };
}

// /liked mirrors /saved: always-on capture, order = like recency proxy
async function handleLikedBatch(msg, sender) {
  const store = await getStore();
  const now = new Date().toISOString();
  let added = 0, bad = 0;
  for (const raw of msg.posts || []) {
    try {
      const p = self.TSENormalize.normalizePost(raw, now);
      if (p && !store.likedPosts[p.id]) {
        p.likedOrder = ++store.likedState.orderCounter; // 1 = liked most recently
        attachReplyTo(p, raw, now);
        store.likedPosts[p.id] = p;
        added++;
      }
    } catch (e) { bad++; }
  }
  if (bad) logError('normalize:liked', bad + ' post(s) failed to parse — skipped');
  if (msg.pageInfo && typeof msg.pageInfo.has_next_page === 'boolean') {
    store.likedState.hasNext = msg.pageInfo.has_next_page;
  }
  store.likedState.lastBatchAt = now;
  checkGrabLimits(store.likedState, msg, added, sender && sender.tab && sender.tab.id);
  if (added || msg.pageInfo) await persist();
  return { added, count: Object.keys(store.likedPosts).length };
}

async function handleFeedBatch(msg, sender) {
  const store = await getStore();
  const st = store.feedState;
  const total = () => Object.keys(store.feedPosts).length;
  // Feed capture is opt-in per run (unlike saved, which is always-on): ignore
  // feed traffic unless a run is active, from the run's tab, and not while a
  // navigation between feeds is still settling.
  if (!st.running || st.awaitingNav) return { added: 0, count: total() };
  if (sender && sender.tab && st.tabId != null && sender.tab.id !== st.tabId) {
    return { added: 0, count: total() };
  }
  if (st.parallel) return handleColumnsBatch(store, msg);
  const feed = currentFeed(st);
  if (!feed) return { added: 0, count: total() };

  const now = new Date().toISOString();
  let added = 0, bad = 0;
  for (const raw of msg.posts || []) {
    if ((st.counts[feed.name] || 0) >= st.target) break;
    try {
      const p = self.TSENormalize.normalizePost(raw, now);
      if (!p) continue;
      const key = feed.url + '|' + p.id;
      if (store.feedPosts[key]) continue;
      p.feed = feed.name;
      p.feedIndex = st.index;              // preserves run order in exports
      p.feedOrder = ++st.orderCounter;     // 1 = top of this feed at grab time
      attachReplyTo(p, raw, now);
      store.feedPosts[key] = p;
      st.counts[feed.name] = (st.counts[feed.name] || 0) + 1;
      added++;
    } catch (e) { bad++; }
  }
  if (bad) logError('normalize:feed', bad + ' post(s) failed to parse — skipped');
  if (msg.pageInfo && typeof msg.pageInfo.has_next_page === 'boolean') {
    st.hasNext = msg.pageInfo.has_next_page;
  }
  st.lastBatchAt = now;
  touchProgress(st);
  const doneHere = (st.counts[feed.name] || 0) >= st.target || st.hasNext === false;
  if (doneHere) {
    await advanceFeed(store);            // persists via navigateToCurrent/finishRun
  } else {
    await persist();
  }
  return { added, count: total() };
}

async function handleProfileBatch(msg, sender) {
  const store = await getStore();
  const st = store.profileState;
  const total = () => Object.keys(store.profilePosts).length;
  if (!st.running || st.awaitingNav) return { added: 0, count: total() };
  if (sender && sender.tab && st.tabId != null && sender.tab.id !== st.tabId) {
    return { added: 0, count: total() };
  }
  // mediaData fires on both profile tabs — only trust batches from the page
  // of the current stage
  if (normPath(msg.path) !== normPath(profileStagePath(st))) {
    return { added: 0, count: total() };
  }

  const now = new Date().toISOString();
  const target = String(st.target || '').toLowerCase();
  let added = 0, bad = 0;
  for (const raw of msg.posts || []) {
    // keep only the profile owner's posts (the Replies tab interleaves the
    // posts they replied to, authored by other people)
    if (!raw || !raw.user || String(raw.user.username || '').toLowerCase() !== target) continue;
    try {
      const p = self.TSENormalize.normalizePost(raw, now);
      if (!p) continue;
      const key = st.target + '|' + st.stage + '|' + p.id;
      if (store.profilePosts[key]) continue;
      p.profileHandle = '@' + st.target;           // whose profile this came from
      p.section = st.stage;                        // 'threads' | 'replies'
      p.sectionIndex = st.stage === 'replies' ? 1 : 0;
      p.profileOrder = ++st.orderCounter;          // 1 = newest in this section
      attachReplyTo(p, raw, now);
      store.profilePosts[key] = p;
      st.curCount++;
      added++;
    } catch (e) { bad++; }
  }
  if (bad) logError('normalize:profile', bad + ' post(s) failed to parse — skipped');
  if (msg.pageInfo && typeof msg.pageInfo.has_next_page === 'boolean') {
    st.hasNext = msg.pageInfo.has_next_page;
  }
  st.lastBatchAt = now;
  touchProgress(st);
  if (st.hasNext === false) {
    await advanceProfile(store);                 // persists
  } else {
    await persist();
  }
  return { added, count: total() };
}

async function handleContentReady(msg, sender) {
  const store = await getStore();
  const st = store.feedState;
  const ps = store.profileState;
  const tabId = sender && sender.tab && sender.tab.id;

  // multi-feed run: is this the page we were navigating to?
  if (st.running && tabId === st.tabId) {
    if (st.parallel) {
      // columns run: we were navigating to the board home
      if (normPath(msg.path) === '/') {
        st.awaitingNav = false;
        touchProgress(st);
        await persist();
        chrome.tabs.sendMessage(tabId, {
          type: 'START_SCROLL', mode: 'columns', feeds: st.queue,
        }).catch(() => {});
      }
      return;
    }
    const feed = currentFeed(st);
    if (feed && normPath(msg.path) === normPath(feed.url)) {
      st.awaitingNav = false;
      touchProgress(st);
      await persist();
      chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL', mode: 'feed' }).catch(() => {});
    }
    return;
  }
  // profile run: expected stage page reached?
  if (ps.running && tabId === ps.tabId) {
    if (normPath(msg.path) === normPath(profileStagePath(ps))) {
      ps.awaitingNav = false;
      touchProgress(ps);
      await persist();
      chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL', mode: 'profile' }).catch(() => {});
    }
    return;
  }
  // saved/liked grab resume after the /saved or /liked navigation
  if (store.state.grabbing && msg.kind === 'saved') {
    chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL', mode: 'saved' }).catch(() => {});
  }
  if (store.likedState.grabbing && msg.kind === 'liked') {
    chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL', mode: 'liked' }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  watchdogTick(alarm).catch((e) => logError('watchdog', e));
});

async function watchdogTick(alarm) {
  if (alarm.name !== WATCHDOG) return;
  const store = await getStore();
  const st = store.feedState;
  const ps = store.profileState;
  if (!st.running && !ps.running) { chrome.alarms.clear(WATCHDOG).catch(() => {}); return; }
  if (st.running) {
    const last = Date.parse(st.lastProgressAt || '') || 0;
    if (Date.now() - last > STALL_MS) {
      if (st.parallel) {
        // columns all paginate at once — a stall means this wave is stuck
        if ((st.waveQueue || []).length) {
          st.lastError = 'batch wave stalled — skipped to the next wave';
          await startNextWave(store);
        } else {
          st.lastError = 'columns run stalled — stopped (keep the tab visible)';
          await finishRun(store);
        }
      } else {
        // Feed (or tab) stalled — skip to the next one instead of hanging forever.
        const feed = currentFeed(st);
        if (feed) st.lastError = `"${feed.name}" stalled — skipped`;
        await advanceFeed(store);
      }
    }
  }
  if (ps.running) {
    const last = Date.parse(ps.lastProgressAt || '') || 0;
    if (Date.now() - last > STALL_MS) {
      ps.lastError = `profile ${ps.stage} stalled — moved on`;
      await advanceProfile(store);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const store = await getStore();
    switch (msg.type) {
      case 'BATCH':
        if (msg.kind === 'feed') sendResponse(await handleFeedBatch(msg, sender));
        else if (msg.kind === 'profile') sendResponse(await handleProfileBatch(msg, sender));
        else if (msg.kind === 'liked') sendResponse(await handleLikedBatch(msg, sender));
        else sendResponse(await handleSavedBatch(msg, sender));
        break;

      case 'FEEDS': {
        // Passively discovered custom-feed list (embedded page data). Some
        // surfaces interleave built-in pseudo-entries (For you / Following /
        // Ghost posts) into the list — keep only real custom feeds: numeric
        // id and not a built-in name.
        const builtinNames = new Set(Object.values(BUILTIN_FEED_NAMES).map((n) => n.toLowerCase()));
        const feeds = (msg.feeds || []).filter((f) =>
          f && f.id && f.name &&
          /^\d+$/.test(String(f.id)) &&
          !builtinNames.has(String(f.name).trim().toLowerCase()));
        if (feeds.length) {
          store.feedList = { feeds, at: new Date().toISOString() };
          await persist();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CONTENT_READY':
        await handleContentReady(msg, sender);
        sendResponse({ ok: true });
        break;

      case 'GET_STATE': {
        const st = store.feedState;
        const cur = currentFeed(st);
        let bytes = 0;
        try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (_) {}
        sendResponse({
          storage: {
            bytes,
            quota: chrome.storage.local.QUOTA_BYTES || 10485760,
            full: storageFull,
          },
          saved: {
            count: Object.keys(store.posts).length,
            grabbing: store.state.grabbing,
            hasNext: store.state.hasNext,
            lastBatchAt: store.state.lastBatchAt,
            lastError: store.state.lastError,
            stopNote: store.state.stopNote,
          },
          liked: {
            count: Object.keys(store.likedPosts).length,
            grabbing: store.likedState.grabbing,
            hasNext: store.likedState.hasNext,
            lastBatchAt: store.likedState.lastBatchAt,
            lastError: store.likedState.lastError,
            stopNote: store.likedState.stopNote,
          },
          feed: {
            count: Object.keys(store.feedPosts).length,
            running: st.running,
            parallel: st.parallel,
            queue: st.queue.map((f) => f.name),
            index: st.index,
            target: st.target,
            counts: st.counts,
            currentName: cur ? cur.name : null,
            currentCount: cur ? (st.counts[cur.name] || 0) : 0,
            doneCount: st.parallel ? parallelDone(st).length : 0,
            wave: st.wave || 1,
            wavesTotal: st.wavesTotal || 1,
            waveQueueLen: (st.waveQueue || []).length,
            // feeds actively being grabbed right now (all of them in a
            // columns run, just the current one sequentially)
            activeNames: !st.running ? []
              : st.parallel
                ? st.queue
                    .filter((f) => (st.counts[f.name] || 0) < st.target && !st.feedEnded[f.url])
                    .map((f) => f.name)
                : (cur ? [cur.name] : []),
            lastError: st.lastError,
          },
          feedList: store.feedList.feeds,
          profile: (() => {
            const ps = store.profileState;
            // summarize what's stored: handle -> {threads, replies}
            const byHandle = {};
            for (const p of Object.values(store.profilePosts)) {
              const h = p.profileHandle || '@?';
              const b = byHandle[h] || (byHandle[h] = { threads: 0, replies: 0 });
              b[p.section === 'replies' ? 'replies' : 'threads']++;
            }
            return {
              count: Object.keys(store.profilePosts).length,
              running: ps.running,
              stage: ps.stage,
              target: ps.target,
              isOwn: ps.isOwn,
              curCount: ps.curCount,
              profiles: byHandle,
              lastError: ps.lastError,
            };
          })(),
        });
        break;
      }

      case 'START': { // saved or liked grab (feed grabs use START_RUN)
        const liked = msg.mode === 'liked';
        const st = liked ? store.likedState : store.state;
        const tab = await findThreadsTab();
        if (!tab) {
          st.lastError = liked
            ? 'No threads.com tab found — open threads.com/liked first.'
            : 'No threads.com tab found — open threads.com/saved first.';
          await persist();
          sendResponse({ ok: false, error: st.lastError });
          break;
        }
        st.grabbing = true;
        st.lastError = null;
        st.stopNote = null;
        st.grabAdded = 0;
        st.limit = Number(msg.limit) > 0 ? Math.floor(Number(msg.limit)) : null;
        st.until = msg.until && !Number.isNaN(Date.parse(msg.until)) ? msg.until : null;
        (liked ? store.state : store.likedState).grabbing = false; // modes share one scroll loop
        store.feedState.running = false;
        store.profileState.running = false;
        await persist();
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'START_SCROLL', mode: liked ? 'liked' : 'saved' });
          sendResponse({ ok: true });
        } catch (e) {
          st.grabbing = false;
          st.lastError = 'Could not reach the Threads tab — reload it and try again.';
          await persist();
          sendResponse({ ok: false, error: st.lastError });
        }
        break;
      }

      case 'START_RUN': {
        const feeds = (msg.feeds || []).filter((f) => f && f.url && f.name);
        if (!feeds.length) {
          sendResponse({ ok: false, error: 'No feeds selected.' });
          break;
        }
        const tab = await findThreadsTab();
        if (!tab) {
          store.feedState.lastError = 'No threads.com tab found — open threads.com first.';
          await persist();
          sendResponse({ ok: false, error: store.feedState.lastError });
          break;
        }
        // Each run starts from a clean slate: "give me the top N of these
        // feeds now." Imported posts (import: keys) are backups — keep them.
        clearLiveFeedPosts(store);
        store.feedState = Object.assign({}, FEED_STATE_DEFAULTS, {
          running: true,
          queue: feeds,
          target: Math.max(1, Math.min(2000, Number(msg.target) || 100)),
          tabId: tab.id,
          counts: {},
        });
        store.state.grabbing = false; // modes share one scroll loop
        store.likedState.grabbing = false;
        store.profileState.running = false;
        chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
        await navigateToCurrent(store); // persists
        sendResponse({ ok: true });
        break;
      }

      case 'START_COLUMNS': { // board columns: all selected feeds, in waves of 4
        const allFeeds = (msg.feeds || [])
          .filter((f) => f && f.url && f.name)
          .map((f) => ({ name: f.name, url: normPath(f.url) + '/' }));
        if (!allFeeds.length) {
          sendResponse({ ok: false, error: 'No feeds selected.' });
          break;
        }
        const feeds = allFeeds.slice(0, 4);
        const tab = await findThreadsTab();
        if (!tab) {
          store.feedState.lastError = 'No threads.com tab found — open threads.com first.';
          await persist();
          sendResponse({ ok: false, error: store.feedState.lastError });
          break;
        }
        // clean slate, like sequential runs; the content script opens columns
        // for these feeds and reconciles the queue via COLUMNS_INFO
        clearLiveFeedPosts(store);
        store.feedState = Object.assign({}, FEED_STATE_DEFAULTS, {
          running: true,
          parallel: true,
          queue: feeds,
          waveQueue: allFeeds.slice(4),
          wave: 1,
          wavesTotal: Math.ceil(allFeeds.length / 4),
          waveBound: false,
          target: Math.max(1, Math.min(2000, Number(msg.target) || 100)),
          tabId: tab.id,
          counts: {},
          feedEnded: {},
          orderCounters: {},
        });
        store.state.grabbing = false; // modes share one scroll loop
        store.likedState.grabbing = false;
        store.profileState.running = false;
        chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
        let onBoard = false;
        try { onBoard = normPath(new URL(tab.url || '').pathname) === '/'; } catch (_) {}
        if (onBoard) {
          touchProgress(store.feedState);
          await persist();
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'START_SCROLL', mode: 'columns', feeds: store.feedState.queue,
            });
          } catch (e) {
            store.feedState.running = false;
            store.feedState.lastError = 'Could not reach the Threads tab — reload it and try again.';
            await persist();
            sendResponse({ ok: false, error: store.feedState.lastError });
            break;
          }
        } else {
          store.feedState.awaitingNav = true;
          touchProgress(store.feedState);
          await persist();
          try {
            await chrome.tabs.update(tab.id, { url: 'https://www.threads.com/' });
          } catch (e) {
            store.feedState.lastError = 'Lost the Threads tab.';
            await finishRun(store);
            sendResponse({ ok: false, error: store.feedState.lastError });
            break;
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'COLUMNS_INFO': { // content script reporting the columns it actually bound
        const st = store.feedState;
        if (!st.running || !st.parallel) { sendResponse({ ok: false }); break; }
        const bound = new Set(
          (msg.feeds || []).map((f) => normPath(f && f.url) + '/').filter((u) => u !== '//')
        );
        const missing = st.queue.filter((f) => !bound.has(f.url));
        st.queue = st.queue.filter((f) => bound.has(f.url));
        st.waveBound = true;
        if (!st.queue.length) {
          st.lastError = 'Could not open any feed columns on the board.';
          if ((st.waveQueue || []).length) await startNextWave(store);
          else await finishRun(store);
          sendResponse({ ok: false, error: st.lastError });
          break;
        }
        if (missing.length) {
          st.lastError = `couldn't open: ${missing.map((f) => f.name).join(', ')}`;
        }
        touchProgress(st);
        await persist();
        sendResponse({ ok: true, target: st.target });
        break;
      }

      case 'START_PROFILE': {
        const tab = await findThreadsTab();
        if (!tab) {
          store.profileState.lastError = 'No threads.com tab found — open threads.com first.';
          await persist();
          sendResponse({ ok: false, error: store.profileState.lastError });
          break;
        }
        // A blank handle means "my own profile" — resolve it from the tab's
        // nav sidebar. A typed handle grabs that user's public profile.
        const typed = String(msg.handle || '').trim().replace(/^@/, '').replace(/\/.*$/, '');
        let target = typed;
        let isOwn = false;
        if (!target) {
          try {
            const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_USERNAME' });
            target = r && r.username;
            isOwn = true;
          } catch (e) { /* handled below */ }
          if (!target) {
            store.profileState.lastError = 'Could not find your profile link — reload the Threads tab, or type a handle.';
            await persist();
            sendResponse({ ok: false, error: store.profileState.lastError });
            break;
          }
        }
        if (!/^[A-Za-z0-9._]+$/.test(target)) {
          store.profileState.lastError = `"${target}" is not a valid handle.`;
          await persist();
          sendResponse({ ok: false, error: store.profileState.lastError });
          break;
        }
        // A grab replaces only this profile's + this section's data, so threads
        // and replies (and different users) accumulate and export together.
        const stage = msg.stage === 'replies' ? 'replies' : 'threads';
        const prefix = target + '|' + stage + '|';
        for (const k of Object.keys(store.profilePosts)) {
          if (k.startsWith(prefix)) delete store.profilePosts[k];
        }
        store.profileState = Object.assign({}, PROFILE_STATE_DEFAULTS, {
          running: true,
          target,
          isOwn,
          stage,
          tabId: tab.id,
        });
        store.state.grabbing = false;      // modes share one scroll loop
        store.likedState.grabbing = false;
        store.feedState.running = false;
        chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
        await navigateToProfileStage(store); // persists
        sendResponse({ ok: true });
        break;
      }

      case 'STOP': {
        if (msg.mode === 'feed') {
          await finishRun(store);
        } else if (msg.mode === 'profile') {
          await finishProfile(store);
        } else {
          if (msg.mode === 'liked') store.likedState.grabbing = false;
          else store.state.grabbing = false;
          await persist();
          const tab = await findThreadsTab();
          if (tab) chrome.tabs.sendMessage(tab.id, { type: 'STOP_SCROLL' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SCROLL_STATE':
        if (msg.state === 'done' || msg.state === 'stopped') {
          if (msg.mode === 'feed') {
            // content.js exhausted this feed (or gave up) — move on.
            // awaitingNav guards against a late "done" from the page we just
            // left, which would otherwise advance the queue twice.
            if (store.feedState.running && !store.feedState.awaitingNav && msg.state === 'done' &&
                sender && sender.tab && sender.tab.id === store.feedState.tabId) {
              await advanceFeed(store);
            }
          } else if (msg.mode === 'columns') {
            // all columns finished (or none found) — next wave, or close out.
            // A "done · all columns finished" while the new wave isn't bound
            // yet is the PREVIOUS wave's stop racing NEXT_WAVE — ignore it.
            if (store.feedState.running && store.feedState.parallel && msg.state === 'done' &&
                sender && sender.tab && sender.tab.id === store.feedState.tabId) {
              const st = store.feedState;
              const stale = !st.waveBound && (st.wave || 1) > 1 &&
                msg.reason === 'all columns finished';
              if (!stale) {
                if ((st.waveQueue || []).length) await startNextWave(store);
                else await finishRun(store);
              }
            }
          } else if (msg.mode === 'profile') {
            if (store.profileState.running && !store.profileState.awaitingNav && msg.state === 'done' &&
                sender && sender.tab && sender.tab.id === store.profileState.tabId) {
              await advanceProfile(store);
            }
          } else if (msg.mode === 'liked') {
            store.likedState.grabbing = false;
            await persist();
          } else {
            store.state.grabbing = false;
            await persist();
          }
        }
        sendResponse({ ok: true });
        break;

      case 'IMPORT_POSTS': {
        // posts from an earlier JSON export, routed by shape. Runs through
        // the SW so the in-memory mirror stays consistent with storage.
        const posts = Array.isArray(msg.posts) ? msg.posts : [];
        let added = 0, skipped = 0;
        for (const p of posts) {
          if (!p || !p.id || typeof p !== 'object') { skipped++; continue; }
          if (p.profileHandle) {
            const key = String(p.profileHandle).replace(/^@/, '') + '|' +
              (p.section === 'replies' ? 'replies' : 'threads') + '|' + p.id;
            if (store.profilePosts[key]) { skipped++; continue; }
            store.profilePosts[key] = p;
          } else if (p.feed) {
            const key = 'import:' + p.feed + '|' + p.id;
            if (store.feedPosts[key]) { skipped++; continue; }
            store.feedPosts[key] = p;
          } else if (p.likedOrder != null) {
            if (store.likedPosts[p.id]) { skipped++; continue; }
            store.likedPosts[p.id] = p;
          } else {
            if (store.posts[p.id]) { skipped++; continue; }
            store.posts[p.id] = p;
          }
          added++;
        }
        if (added) await persist();
        sendResponse({ ok: true, added, skipped });
        break;
      }

      case 'GET_LIKERS': { // dashboard: fetch who liked / reposted / quoted one post, on demand
        const FIELDS = { like: 'likers', repost: 'reposters', quote: 'quoters' };
        const tabType = FIELDS[msg.tabType] ? msg.tabType : 'like';
        const tab = await findThreadsTab();
        if (!tab) {
          sendResponse({ ok: false, error: 'No threads.com tab found — open threads.com first.' });
          break;
        }
        let r;
        try {
          r = await chrome.tabs.sendMessage(tab.id, {
            type: 'FETCH_ENGAGERS', postId: msg.postId, tabType,
          });
        } catch (e) {
          sendResponse({ ok: false, error: 'Could not reach the Threads tab — reload it and try again.' });
          break;
        }
        if (!r || !r.ok) {
          sendResponse({ ok: false, error: (r && r.error) || 'Could not fetch that list.' });
          break;
        }
        // attach to the stored post so it persists and flows into exports
        const buckets = {
          saved: store.posts, liked: store.likedPosts,
          feed: store.feedPosts, profile: store.profilePosts,
        };
        const field = FIELDS[tabType];
        const bucket = buckets[msg.source];
        const rec = bucket && bucket[msg.key];
        if (rec) {
          rec[field] = r.engagers || [];
          rec[field + 'At'] = new Date().toISOString();
          rec[field + 'Partial'] = !!r.partial;
          await persist();
        }
        sendResponse({ ok: true, engagers: r.engagers || [], partial: !!r.partial, count: (r.engagers || []).length });
        break;
      }

      case 'DELETE_POSTS': { // dashboard: delete an explicit set of posts by storage key
        const buckets = {
          saved: store.posts,
          liked: store.likedPosts,
          feed: store.feedPosts,
          profile: store.profilePosts,
        };
        let removed = 0;
        for (const [src, keys] of Object.entries(msg.keys || {})) {
          const bucket = buckets[src];
          if (!bucket || !Array.isArray(keys)) continue;
          for (const k of keys) {
            if (bucket[k] !== undefined) { delete bucket[k]; removed++; }
          }
        }
        if (removed) await persist();
        sendResponse({ ok: true, removed });
        break;
      }

      case 'CLEAR':
        if (msg.mode === 'feed') {
          store.feedPosts = {};
          store.feedState = Object.assign({}, FEED_STATE_DEFAULTS, { target: store.feedState.target });
        } else if (msg.mode === 'profile') {
          store.profilePosts = {};
          store.profileState = Object.assign({}, PROFILE_STATE_DEFAULTS);
        } else if (msg.mode === 'liked') {
          store.likedPosts = {};
          store.likedState.orderCounter = 0;
          store.likedState.hasNext = null;
          store.likedState.lastBatchAt = null;
          store.likedState.lastError = null;
          store.likedState.stopNote = null;
        } else {
          store.posts = {};
          store.state.orderCounter = 0;
          store.state.hasNext = null;
          store.state.lastBatchAt = null;
          store.state.lastError = null;
          store.state.stopNote = null;
        }
        await persist();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    }
  })().catch((e) => {
    // Unexpected throw in a handler. Without this catch the rejection is
    // unhandled: sendResponse never fires, the caller's port just closes,
    // and nothing is recorded anywhere. Log it, surface it on the active
    // grab, and still answer the caller.
    const err = 'Internal error: ' + String((e && e.message) || e);
    logError('message:' + (msg && msg.type), e);
    stampActiveError(err);
    if (mem) persist();
    try { sendResponse({ ok: false, error: err }); } catch (_) {}
  });
  return true; // async sendResponse
});
