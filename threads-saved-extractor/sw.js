// sw.js — service worker: message hub, dedupe, storage.
// Storage layout (chrome.storage.local):
//   tse_posts : { [id]: normalizedPost }
//   tse_state : { grabbing, hasNext, lastBatchAt, lastError }
importScripts('lib/normalize.js');

let mem = null;              // in-memory mirror of storage
let persistQueue = Promise.resolve(); // serializes writes

async function getStore() {
  if (!mem) {
    const got = await chrome.storage.local.get(['tse_posts', 'tse_state']);
    mem = {
      posts: got.tse_posts || {},
      state: Object.assign({ grabbing: false, hasNext: null, lastBatchAt: null, lastError: null, orderCounter: 0 }, got.tse_state),
    };
  }
  return mem;
}

function persist() {
  persistQueue = persistQueue.then(() =>
    chrome.storage.local.set({ tse_posts: mem.posts, tse_state: mem.state })
  );
  return persistQueue;
}

async function findThreadsTab() {
  const tabs = await chrome.tabs.query({ url: ['https://www.threads.com/*', 'https://threads.com/*'] });
  if (!tabs.length) return null;
  // prefer active tab, then the saved page, then the first
  return tabs.find((t) => t.active) || tabs.find((t) => (t.url || '').includes('/saved')) || tabs[0];
}

async function handleBatch(msg) {
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const store = await getStore();
    switch (msg.type) {
      case 'BATCH':
        sendResponse(await handleBatch(msg));
        break;

      case 'GET_STATE':
        sendResponse({
          count: Object.keys(store.posts).length,
          grabbing: store.state.grabbing,
          hasNext: store.state.hasNext,
          lastBatchAt: store.state.lastBatchAt,
          lastError: store.state.lastError,
        });
        break;

      case 'START': {
        const tab = await findThreadsTab();
        if (!tab) {
          store.state.lastError = 'No threads.com tab found — open threads.com/saved first.';
          await persist();
          sendResponse({ ok: false, error: store.state.lastError });
          break;
        }
        store.state.grabbing = true;
        store.state.lastError = null;
        await persist();
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'START_SCROLL' });
          sendResponse({ ok: true });
        } catch (e) {
          store.state.grabbing = false;
          store.state.lastError = 'Could not reach the Threads tab — reload it and try again.';
          await persist();
          sendResponse({ ok: false, error: store.state.lastError });
        }
        break;
      }

      case 'STOP': {
        store.state.grabbing = false;
        await persist();
        const tab = await findThreadsTab();
        if (tab) chrome.tabs.sendMessage(tab.id, { type: 'STOP_SCROLL' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'SCROLL_STATE':
        if (msg.state === 'done' || msg.state === 'stopped') {
          store.state.grabbing = false;
          await persist();
        }
        sendResponse({ ok: true });
        break;

      case 'CLEAR':
        store.posts = {};
        store.state.orderCounter = 0;
        store.state.hasNext = null;
        store.state.lastBatchAt = null;
        store.state.lastError = null;
        await persist();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    }
  })();
  return true; // async sendResponse
});
