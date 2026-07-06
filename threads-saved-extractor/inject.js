// inject.js — runs in the PAGE (MAIN) world at document_start.
// Captures saved-feed and home/custom-feed GraphQL responses by wrapping
// fetch/XHR, and also scans the server-embedded JSON that carries the FIRST
// batch (it is never fetched).
//
// ---- Discovery constants (verified live on threads.com, 2026-07-03 + 2026-07-06) ----
// Endpoint ......... POST https://www.threads.com/graphql/query  (threads.com host)
// Saved ............ BarcelonaSavedPageViewerQuery / BarcelonaSavedPagePaginationFragment_connection
//                    data...saved_media.edges[].node.thread_items[].post
// For you/Following  BarcelonaFeedPaginationDirectQuery
//                    data...feedData.edges[].node.text_post_app_thread.thread_items[].post
//                    (some edges are non-post units, e.g. node.suggested_users)
// Custom feed ...... BarcelonaCustomFeedRefetchableQuery  (page: /custom_feed/<id>/)
//                    data...results.edges[].node.thread_items[].post
// Pagination ....... <conn>.page_info.{end_cursor, has_next_page} on every connection
// Marker ........... we match responses by CONTENT (connection key names) rather
//                    than by doc_id / friendly name, so doc_id rotation across
//                    Meta deploys does not break capture. "results" is a generic
//                    key, so it only counts when its edges actually carry posts.
(() => {
  'use strict';
  if (window.__tseInjected) return;
  window.__tseInjected = true;

  // connection key -> which capture bucket it belongs to
  // mediaData = profile content (Threads AND Replies tabs share it; also fires
  // on other people's profiles — the service worker filters by username)
  const CONN_KINDS = { saved_media: 'saved', feedData: 'feed', results: 'feed', mediaData: 'profile' };
  const MARKERS = Object.keys(CONN_KINDS);

  // Replay buffer: everything emitted since page load. content.js asks for a
  // replay (TSE_RESCAN) when a grab starts, so batches that arrived BEFORE the
  // user hit "Grab" (embedded first batch, manual pre-scrolling) are not lost.
  const replay = [];

  function emit(kind, connKey, posts, pageInfo, origin) {
    if (!posts.length && !pageInfo) return;
    // "results" is used by other surfaces (search, …) — only trust it when it
    // actually contained thread posts.
    if (connKey === 'results' && !posts.length) return;
    const msg = { __tse: true, type: 'TSE_BATCH', kind, connKey, posts, pageInfo: pageInfo || null, origin };
    replay.push(msg);
    if (replay.length > 300) replay.shift();
    window.postMessage(msg, window.location.origin);
  }

  // thread items live at node.thread_items (saved_media, results) or
  // node.text_post_app_thread.thread_items (feedData)
  function threadItemsOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node.thread_items)) return node.thread_items;
    const t = node.text_post_app_thread;
    if (t && Array.isArray(t.thread_items)) return t.thread_items;
    return null;
  }

  // Recursively collect every known {<marker>: {edges, page_info}} connection in a JSON tree.
  function findConnections(root) {
    const found = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      for (const key of MARKERS) {
        const c = o[key];
        if (c && typeof c === 'object' && Array.isArray(c.edges)) found.push({ key, conn: c });
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v);
    })(root);
    return found;
  }

  function extractPosts(conn, annotateReplies) {
    const posts = [];
    for (const e of conn.edges || []) {
      const items = threadItemsOf(e && e.node) || [];
      let prev = null;
      for (const ti of items) {
        if (!ti || !ti.post) continue;
        if (annotateReplies && prev) {
          // profile Replies tab: thread_items = [parent(s)…, own reply] —
          // attach the FULL post this one replies to (shallow copy, without
          // its own annotation so chains don't nest)
          try {
            const parent = Object.assign({}, prev);
            delete parent.__tsePrevPost;
            ti.post.__tsePrevPost = parent;
          } catch (_) {}
        }
        posts.push(ti.post);
        prev = ti.post;
      }
    }
    return posts;
  }

  function hasMarker(text) {
    for (const m of MARKERS) if (text.indexOf('"' + m + '"') !== -1) return true;
    return false;
  }

  // The viewer's custom-feed list is embedded on single-column pages as
  // data.custom_feeds.interest_feeds[] = {feed_name, id} (verified 2026-07-06).
  function findFeedList(root) {
    let feeds = null;
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o) || feeds) return;
      seen.add(o);
      const cf = o.custom_feeds;
      if (cf && Array.isArray(cf.interest_feeds)) {
        feeds = cf.interest_feeds
          .filter((f) => f && f.id && f.feed_name)
          .map((f) => ({ name: String(f.feed_name), id: String(f.id) }));
        return;
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v);
    })(root);
    return feeds;
  }

  function handleJsonText(text, origin) {
    if (!text) return;
    const wantsFeeds = text.indexOf('"custom_feeds"') !== -1;
    if (!hasMarker(text) && !wantsFeeds) return;
    // Meta GraphQL responses can be streamed as several newline-separated JSON docs.
    const chunks = [];
    try {
      chunks.push(JSON.parse(text));
    } catch (_) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { chunks.push(JSON.parse(line)); } catch (_) { /* partial chunk, skip */ }
      }
    }
    for (const j of chunks) {
      for (const { key, conn } of findConnections(j)) {
        emit(CONN_KINDS[key], key, extractPosts(conn, key === 'mediaData'), conn.page_info, origin);
      }
      if (wantsFeeds) {
        const feeds = findFeedList(j);
        if (feeds && feeds.length) {
          window.postMessage({ __tse: true, type: 'TSE_FEEDS', feeds }, window.location.origin);
        }
      }
    }
  }

  // ---- 1. fetch interception ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes('/graphql')) {
        p.then((resp) => {
          try {
            resp.clone().text().then((t) => handleJsonText(t, 'fetch')).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  // ---- 2. XHR interception ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tseUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__tseUrl && this.__tseUrl.includes('/graphql')) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            handleJsonText(this.responseText, 'xhr');
          }
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };

  // ---- 3. Server-embedded first batch ----
  // On a hard load the first batch of any feed arrives inside
  // <script type="application/json"> (Relay preloader) and is never fetched.
  function scanScript(s) {
    const t = s.textContent;
    if (t && hasMarker(t)) handleJsonText(t, 'embedded');
  }
  function scanAllEmbedded() {
    document.querySelectorAll('script[type="application/json"]').forEach(scanScript);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAllEmbedded);
    // Meta appends preloader scripts progressively during load — watch briefly.
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeName === 'SCRIPT' && n.type === 'application/json') scanScript(n);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  } else {
    scanAllEmbedded();
  }

  // ---- 4. Replay on demand (content.js sends this when a grab starts) ----
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__tse !== true || d.type !== 'TSE_RESCAN') return;
    const snapshot = replay.slice(); // scanAllEmbedded() below emits live; avoid double-posting
    scanAllEmbedded();
    for (const m of snapshot) window.postMessage(m, window.location.origin);
  });
})();
