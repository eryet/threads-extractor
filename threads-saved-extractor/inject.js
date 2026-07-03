// inject.js — runs in the PAGE (MAIN) world at document_start.
// Captures saved-feed GraphQL responses by wrapping fetch/XHR, and also scans
// the server-embedded JSON that carries the FIRST batch (it is never fetched).
//
// ---- Discovery constants (verified live on threads.com, 2026-07-03) ----
// Endpoint ......... POST https://www.threads.com/graphql/query  (threads.com host)
// Query names ...... BarcelonaSavedPageViewerQuery / BarcelonaSavedPagePaginationFragment_connection
// Response shape ... data.xdt_text_app_viewer.saved_media
//                      .edges[].node.thread_items[].post
//                      .page_info.{end_cursor, has_next_page}
// Marker ........... we match responses by CONTENT (the "saved_media" key) rather
//                    than by doc_id / friendly name, so doc_id rotation across
//                    Meta deploys does not break capture.
(() => {
  'use strict';
  if (window.__tseInjected) return;
  window.__tseInjected = true;

  const MARKER = 'saved_media';

  function emit(posts, pageInfo, origin) {
    if (!posts.length && !pageInfo) return;
    window.postMessage(
      { __tse: true, type: 'TSE_BATCH', posts, pageInfo: pageInfo || null, origin },
      window.location.origin
    );
  }

  // Recursively collect every {saved_media: {edges, page_info}} connection in a JSON tree.
  function findConnections(root) {
    const found = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (o[MARKER] && typeof o[MARKER] === 'object' && Array.isArray(o[MARKER].edges)) {
        found.push(o[MARKER]);
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v);
    })(root);
    return found;
  }

  function extractPosts(conn) {
    const posts = [];
    for (const e of conn.edges || []) {
      const items = (e && e.node && e.node.thread_items) || [];
      for (const ti of items) if (ti && ti.post) posts.push(ti.post);
    }
    return posts;
  }

  function handleJsonText(text, origin) {
    if (!text || text.indexOf(MARKER) === -1) return;
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
      for (const conn of findConnections(j)) {
        emit(extractPosts(conn), conn.page_info, origin);
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
  // On a hard load of /saved the first ~20 posts arrive inside
  // <script type="application/json"> (Relay preloader) and are never fetched.
  function scanScript(s) {
    const t = s.textContent;
    if (t && t.includes(MARKER)) handleJsonText(t, 'embedded');
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
})();
