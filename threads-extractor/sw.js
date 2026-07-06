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
      'tse_profile_posts', 'tse_profile_state',
    ]);
    mem = {
      posts: got.tse_posts || {},
      state: Object.assign({ grabbing: false, hasNext: null, lastBatchAt: null, lastError: null, orderCounter: 0 }, got.tse_state),
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
      tse_feed_posts: mem.feedPosts, tse_feed_state: mem.feedState,
      tse_feed_list: mem.feedList,
      tse_profile_posts: mem.profilePosts, tse_profile_state: mem.profileState,
    })
  );
  return persistQueue;
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
  maybeClearWatchdog(store);
  if (st.tabId != null) {
    chrome.tabs.sendMessage(st.tabId, { type: 'STOP_SCROLL' }).catch(() => {});
  }
  await persist();
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

async function handleSavedBatch(msg) {
  const store = await getStore();
  const now = new Date().toISOString();
  let added = 0;
  for (const raw of msg.posts || []) {
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
  }
  if (msg.pageInfo && typeof msg.pageInfo.has_next_page === 'boolean') {
    store.state.hasNext = msg.pageInfo.has_next_page;
  }
  store.state.lastBatchAt = now;
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
  let added = 0;
  for (const raw of msg.posts || []) {
    if ((st.counts[feed.name] || 0) >= st.target) break;
    const p = self.TSENormalize.normalizePost(raw, now);
    if (!p) continue;
    const key = feed.url + '|' + p.id;
    if (store.feedPosts[key]) continue;
    p.feed = feed.name;
    p.feedIndex = st.queue.indexOf(feed);
    p.feedOrder = (st.orderCounters[feed.url] = (st.orderCounters[feed.url] || 0) + 1);
    attachReplyTo(p, raw, now);
    store.feedPosts[key] = p;
    st.counts[feed.name] = (st.counts[feed.name] || 0) + 1;
    added++;
  }
  if (msg.pageInfo && msg.pageInfo.has_next_page === false) st.feedEnded[feed.url] = true;
  st.lastBatchAt = now;
  touchProgress(st);
  const doneFeeds = parallelDone(st);
  if (st.queue.length && doneFeeds.length >= st.queue.length) {
    await finishRun(store);
  } else {
    await persist();
  }
  return { added, count: total(), doneFeeds };
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
  let added = 0;
  for (const raw of msg.posts || []) {
    if ((st.counts[feed.name] || 0) >= st.target) break;
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
  }
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
  let added = 0;
  for (const raw of msg.posts || []) {
    // keep only the profile owner's posts (the Replies tab interleaves the
    // posts they replied to, authored by other people)
    if (!raw || !raw.user || String(raw.user.username || '').toLowerCase() !== target) continue;
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
  }
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
  // saved grab resume after the /saved navigation
  if (store.state.grabbing && msg.kind === 'saved') {
    chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL', mode: 'saved' }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const store = await getStore();
  const st = store.feedState;
  const ps = store.profileState;
  if (!st.running && !ps.running) { chrome.alarms.clear(WATCHDOG).catch(() => {}); return; }
  if (st.running) {
    const last = Date.parse(st.lastProgressAt || '') || 0;
    if (Date.now() - last > STALL_MS) {
      if (st.parallel) {
        // columns all paginate at once — a stall means the whole run is stuck
        st.lastError = 'columns run stalled — stopped (keep the tab visible)';
        await finishRun(store);
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
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const store = await getStore();
    switch (msg.type) {
      case 'BATCH':
        if (msg.kind === 'feed') sendResponse(await handleFeedBatch(msg, sender));
        else if (msg.kind === 'profile') sendResponse(await handleProfileBatch(msg, sender));
        else sendResponse(await handleSavedBatch(msg));
        break;

      case 'FEEDS': {
        // passively discovered custom-feed list (embedded page data)
        const feeds = (msg.feeds || []).filter((f) => f && f.id && f.name);
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
        sendResponse({
          saved: {
            count: Object.keys(store.posts).length,
            grabbing: store.state.grabbing,
            hasNext: store.state.hasNext,
            lastBatchAt: store.state.lastBatchAt,
            lastError: store.state.lastError,
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

      case 'START': { // saved grab (feed grabs use START_RUN)
        const tab = await findThreadsTab();
        if (!tab) {
          store.state.lastError = 'No threads.com tab found — open threads.com/saved first.';
          await persist();
          sendResponse({ ok: false, error: store.state.lastError });
          break;
        }
        store.state.grabbing = true;
        store.state.lastError = null;
        store.feedState.running = false;
        store.profileState.running = false;
        await persist();
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'START_SCROLL', mode: 'saved' });
          sendResponse({ ok: true });
        } catch (e) {
          store.state.grabbing = false;
          store.state.lastError = 'Could not reach the Threads tab — reload it and try again.';
          await persist();
          sendResponse({ ok: false, error: store.state.lastError });
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
        store.profileState.running = false;
        chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
        await navigateToCurrent(store); // persists
        sendResponse({ ok: true });
        break;
      }

      case 'START_COLUMNS': { // board columns: selected feeds, up to 4 in parallel
        const feeds = (msg.feeds || [])
          .filter((f) => f && f.url && f.name)
          .map((f) => ({ name: f.name, url: normPath(f.url) + '/' }))
          .slice(0, 4);
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
        // clean slate, like sequential runs; the content script opens columns
        // for these feeds and reconciles the queue via COLUMNS_INFO
        clearLiveFeedPosts(store);
        store.feedState = Object.assign({}, FEED_STATE_DEFAULTS, {
          running: true,
          parallel: true,
          queue: feeds,
          target: Math.max(1, Math.min(2000, Number(msg.target) || 100)),
          tabId: tab.id,
          counts: {},
          feedEnded: {},
          orderCounters: {},
        });
        store.state.grabbing = false; // modes share one scroll loop
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
        if (!st.queue.length) {
          st.lastError = 'Could not open any feed columns on the board.';
          await finishRun(store);
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
          store.state.grabbing = false;
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
            // all columns finished (or none found) — close out the run
            if (store.feedState.running && store.feedState.parallel && msg.state === 'done' &&
                sender && sender.tab && sender.tab.id === store.feedState.tabId) {
              await finishRun(store);
            }
          } else if (msg.mode === 'profile') {
            if (store.profileState.running && !store.profileState.awaitingNav && msg.state === 'done' &&
                sender && sender.tab && sender.tab.id === store.profileState.tabId) {
              await advanceProfile(store);
            }
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

      case 'CLEAR':
        if (msg.mode === 'feed') {
          store.feedPosts = {};
          store.feedState = Object.assign({}, FEED_STATE_DEFAULTS, { target: store.feedState.target });
        } else if (msg.mode === 'profile') {
          store.profilePosts = {};
          store.profileState = Object.assign({}, PROFILE_STATE_DEFAULTS);
        } else {
          store.posts = {};
          store.state.orderCounter = 0;
          store.state.hasNext = null;
          store.state.lastBatchAt = null;
          store.state.lastError = null;
        }
        await persist();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    }
  })();
  return true; // async sendResponse
});
