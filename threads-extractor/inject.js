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
//
// ---- Board columns (verified live 2026-07-06) ----
// The board home ("/") renders pinned feeds as side-by-side columns, so their
// responses interleave. Attribution comes from the GraphQL REQUEST variables:
//   variant: "for_you" | "following" | …        (built-in feeds)
//   interest_feed_id / custom_feed_id: "<id>"   (custom feeds)
// The pinned-column list is embedded as
//   …text_app_default_board_new.columns.edges[].node.uri  ("/for_you", …)
// in the same order as the [data-column-scrollable] elements. Embedded first
// batches are wrapped as ["adp_<label>", {__bbox:{result}}] and their
// variables live in a separate {"adp_<label>","queryID":…,"variables":{…}}
// registration — joined here via the shared label.
(() => {
  'use strict';
  if (window.__tseInjected) return;
  window.__tseInjected = true;

  // connection key -> which capture bucket it belongs to
  // mediaData = profile content (Threads AND Replies tabs share it; also fires
  // on other people's profiles — the service worker filters by username)
  // liked_media = /liked (verified 2026-07-06: same shape as saved_media)
  const CONN_KINDS = { saved_media: 'saved', liked_media: 'liked', feedData: 'feed', results: 'feed', mediaData: 'profile' };
  const MARKERS = Object.keys(CONN_KINDS);

  // ---- Post engagers: who liked / reposted a post (verified live 2026-07-09) ----
  // The post's "View activity" → Likes/Reposts list. The DEFAULT sort caps at
  // ~100 with no pagination (BarcelonaFeedbackHubTabQuery); the "Most recent"
  // sort uses a paginating refetch query that returns the WHOLE list, so we use
  // that instead:
  //   query BarcelonaFeedbackHubTabContentRefetchableQuery  doc_id 27564308013202368
  //   connection data.feedback_hub_tab_items
  //   variables: { post_id: <numeric pk>, tab_type: 'like'|'repost',
  //     sort_type: 'most_recent', first: <n>, after: <cursor>, + relay providers }
  //   node: { actor: {username, pk}, extra: {context}, timestamp }, page_info
  //   (the server caps page size at ~100 regardless of `first`)
  // doc_id rotates across Meta deploys; we self-heal by caching the live doc_id
  // whenever the user opens a post's "Most recent" list, and fall back to this
  // constant otherwise (re-derive via DevTools if it ever 400s).
  const ENGAGERS_FRIENDLY = 'BarcelonaFeedbackHubTabContentRefetchableQuery';
  const ENGAGERS_DOC_ID = '27564308013202368';
  const ENGAGERS_PROVIDERS = {
    BarcelonaShouldShowFediverseM075Featuresrelayprovider: true,
    BarcelonaIsLoggedInrelayprovider: true,
    BarcelonaHasEventBadgerelayprovider: false,
    BarcelonaHasWebFaviconsrelayprovider: false,
    BarcelonaIsCrawlerrelayprovider: false,
    BarcelonaHasCommunityTopContributorsrelayprovider: true,
  };
  let gqlTemplate = null;        // {url, headers, body} of a recent authenticated graphql POST
  let liveEngagersDocId = null;  // doc_id captured from a real FeedbackHub request, if seen
  const harvestedProviders = {}; // __relay_internal__pv__* -> value observed live

  // Replay buffer: everything emitted since page load. content.js asks for a
  // replay (TSE_RESCAN) when a grab starts, so batches that arrived BEFORE the
  // user hit "Grab" (embedded first batch, manual pre-scrolling) are not lost.
  const replay = [];

  function emit(kind, connKey, posts, pageInfo, origin, feedUrl) {
    if (!posts.length && !pageInfo) return;
    // "results" is used by other surfaces (search, …) — only trust it when it
    // actually contained thread posts.
    if (connKey === 'results' && !posts.length) return;
    const msg = {
      __tse: true, type: 'TSE_BATCH', kind, connKey, posts,
      pageInfo: pageInfo || null, origin, feedUrl: feedUrl || null,
    };
    replay.push(msg);
    if (replay.length > 300) replay.shift();
    window.postMessage(msg, window.location.origin);
  }

  // ---- feed attribution from GraphQL request variables ----
  function feedUrlFromVars(v) {
    if (!v || typeof v !== 'object') return null;
    const cid = v.interest_feed_id || v.custom_feed_id;
    if (cid) return '/custom_feed/' + cid + '/';
    if (typeof v.variant === 'string' && /^[a-z_]+$/.test(v.variant)) return '/' + v.variant + '/';
    return null;
  }

  function feedUrlFromBody(body) {
    try {
      if (body instanceof URLSearchParams) body = body.toString();
      if (typeof body !== 'string' || body.indexOf('variables=') === -1) return null;
      const raw = new URLSearchParams(body).get('variables');
      return raw ? feedUrlFromVars(JSON.parse(raw)) : null;
    } catch (_) { return null; }
  }

  // adp_<label> -> feed url, filled from embedded preloader registrations so
  // embedded first batches can be attributed like fetched ones
  const preloaderFeeds = {};

  function harvestPreloaderVars(text) {
    const re = /"(adp_[A-Za-z0-9_]+)","queryID":"[^"]*","variables":/g;
    let m;
    while ((m = re.exec(text))) {
      const start = re.lastIndex;
      if (text[start] !== '{') continue;
      let depth = 0, end = -1;
      for (let i = start; i < text.length && i < start + 20000; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { end = i; break; }
      }
      if (end === -1) continue;
      try {
        const fu = feedUrlFromVars(JSON.parse(text.slice(start, end + 1)));
        if (fu) preloaderFeeds[m[1]] = fu;
      } catch (_) {}
    }
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

  // Recursively collect every known {<marker>: {edges, page_info}} connection
  // in a JSON tree. feedUrl context: the whole tree's (a fetched response,
  // from its request variables), or per-subtree via adp_ preloader labels
  // (embedded payloads).
  function findConnections(root, defaultFeedUrl) {
    const found = [];
    const seen = new Set();
    (function walk(o, feedUrl) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o) && typeof o[0] === 'string' && o[0].indexOf('adp_') === 0 &&
          preloaderFeeds[o[0]]) {
        feedUrl = preloaderFeeds[o[0]];
      }
      for (const key of MARKERS) {
        const c = o[key];
        if (c && typeof c === 'object' && Array.isArray(c.edges)) found.push({ key, conn: c, feedUrl });
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v, feedUrl);
    })(root, defaultFeedUrl || null);
    return found;
  }

  // The board's pinned-column list: …text_app_default_board_new.columns.edges[]
  // = {node: {uri}} in the same order as the column DOM.
  function findColumnUris(root) {
    let uris = null;
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o) || uris) return;
      seen.add(o);
      const board = o.text_app_default_board_new;
      if (board && board.columns && Array.isArray(board.columns.edges)) {
        uris = board.columns.edges.map((e) => (e && e.node && e.node.uri) || null);
        return;
      }
      const vals = Array.isArray(o) ? o : Object.values(o);
      for (const v of vals) walk(v);
    })(root);
    return uris;
  }

  function extractPosts(conn) {
    const posts = [];
    for (const e of conn.edges || []) {
      const items = threadItemsOf(e && e.node) || [];
      let prev = null;
      for (const ti of items) {
        if (!ti || !ti.post) continue;
        if (prev) {
          // multi-item threads chain replies (profile Replies tab, feed
          // conversation previews) — attach the FULL post this one replies
          // to (shallow copy, without its own annotation so chains don't nest)
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

  function handleJsonText(text, origin, requestFeedUrl) {
    if (!text) return;
    const wantsFeeds = text.indexOf('"custom_feeds"') !== -1;
    const wantsColumns = text.indexOf('text_app_default_board_new') !== -1;
    if (!hasMarker(text) && !wantsFeeds && !wantsColumns) return;
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
      for (const { key, conn, feedUrl } of findConnections(j, requestFeedUrl)) {
        emit(CONN_KINDS[key], key, extractPosts(conn), conn.page_info, origin, feedUrl);
      }
      if (wantsFeeds) {
        const feeds = findFeedList(j);
        if (feeds && feeds.length) {
          window.postMessage({ __tse: true, type: 'TSE_FEEDS', feeds }, window.location.origin);
        }
      }
      if (wantsColumns) {
        const uris = findColumnUris(j);
        if (uris && uris.length) {
          window.postMessage({ __tse: true, type: 'TSE_COLUMNS', uris }, window.location.origin);
        }
      }
    }
  }

  // ---- Engager fetch (who liked / reposted a post) ----
  // Learn an authenticated graphql request as a template from live traffic, so
  // we can re-issue it for the FeedbackHub query without hard-coding the
  // rotating CSRF/session tokens (they're reused verbatim from the template).
  function headersToObject(h) {
    const o = {};
    if (!h) return o;
    if (Array.isArray(h)) { for (const pair of h) if (pair) o[pair[0]] = pair[1]; return o; }
    if (typeof h.forEach === 'function') { h.forEach((v, k) => { o[k] = v; }); return o; }
    return Object.assign({}, h);
  }

  // threads.com issues graphql over XHR (not fetch), so the template — and its
  // request headers (x-fb-lsd, x-csrftoken, x-asbd-id, …) — must be captured
  // from either transport. headers is a plain {name: value} object.
  function noteGraphqlBody(url, headers, body) {
    try {
      if (body instanceof URLSearchParams) body = body.toString();
      if (typeof body !== 'string' || body.indexOf('fb_dtsg=') === -1) return;
      gqlTemplate = { url, headers: headers || {}, body };
      const params = new URLSearchParams(body);
      if (params.get('fb_api_req_friendly_name') === ENGAGERS_FRIENDLY) {
        const did = params.get('doc_id');
        if (did) liveEngagersDocId = did;
      }
      const vraw = params.get('variables');
      if (vraw) {
        const v = JSON.parse(vraw);
        for (const k of Object.keys(v)) {
          if (k.indexOf('__relay_internal__pv__') === 0) harvestedProviders[k] = v[k];
        }
      }
    } catch (_) {}
  }

  // Issue BarcelonaFeedbackHubTabQuery for one post and page through the actors.
  async function fetchEngagers(postId, tabType) {
    if (!gqlTemplate) throw new Error('Threads request context not ready — reload the Threads tab and try again.');
    const pid = String(postId || '').trim();
    if (!/^\d+$/.test(pid)) throw new Error('This post has no numeric id to look up.');
    const tab = tabType === 'repost' ? 'repost' : 'like';
    const providers = {};
    for (const k of Object.keys(ENGAGERS_PROVIDERS)) {
      const full = '__relay_internal__pv__' + k;
      providers[full] = (full in harvestedProviders) ? harvestedProviders[full] : ENGAGERS_PROVIDERS[k];
    }
    const seen = new Set();
    const engagers = [];
    let after = null, pages = 0, partial = false;
    // ~100 per page (server-capped), so these bound very large/viral posts;
    // partial is flagged if we stop before Threads runs out
    const MAX_PAGES = 120, MAX_TOTAL = 10000, PAGE_SIZE = 100;
    while (pages < MAX_PAGES && engagers.length < MAX_TOTAL) {
      pages++;
      // most_recent + first/after paginates the full list (default sort caps ~100)
      const vars = Object.assign(
        { post_id: pid, sort_type: 'most_recent', tab_type: tab, first: PAGE_SIZE, after: after || null },
        providers);
      const params = new URLSearchParams(gqlTemplate.body);
      params.set('fb_api_req_friendly_name', ENGAGERS_FRIENDLY);
      params.set('doc_id', liveEngagersDocId || ENGAGERS_DOC_ID);
      params.set('variables', JSON.stringify(vars));
      const headers = Object.assign({}, gqlTemplate.headers);
      // the template may be borrowed from any query — make the routing headers
      // consistent with the FeedbackHub query we're actually sending
      for (const hk of Object.keys(headers)) {
        const low = hk.toLowerCase();
        if (low === 'x-fb-friendly-name') headers[hk] = ENGAGERS_FRIENDLY;
        else if (low === 'x-root-field-name') headers[hk] = 'feedback_hub_tab_items';
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      let json;
      try {
        const resp = await origFetch.call(window, gqlTemplate.url, {
          method: 'POST', headers, body: params.toString(), credentials: 'include',
        });
        const text = await resp.text();
        json = JSON.parse(text.split('\n')[0]); // responses can stream; the first doc holds the connection
      } catch (e) {
        if (after) break; // a later page failed — keep what we already have
        throw new Error('Threads rejected the request (its data format may have changed).');
      }
      const conn = json && json.data && json.data.feedback_hub_tab_items;
      if (!conn || !Array.isArray(conn.edges)) {
        if (after) break;
        throw new Error('Unexpected response — Threads may have changed its data format.');
      }
      for (const e of conn.edges) {
        const n = e && e.node; const a = (n && n.actor) || {};
        if (!a.username || seen.has(a.username)) continue;
        seen.add(a.username);
        let at = null;
        if (n.timestamp) {
          const ms = n.timestamp > 1e12 ? n.timestamp : n.timestamp * 1000;
          at = new Date(ms).toISOString();
        }
        engagers.push({
          handle: '@' + a.username,
          name: (n.extra && n.extra.context) || a.full_name || null,
          pk: String(a.pk || a.id || ''),
          at,
        });
      }
      const pi = conn.page_info || {};
      if (pi.has_next_page && pi.end_cursor) {
        after = pi.end_cursor;
        // gentle throttle between pages — jittered so the cadence isn't machine-regular
        await new Promise((r) => setTimeout(r, 120 + Math.random() * 240));
      } else { partial = !!pi.has_next_page; break; }
    }
    if (pages >= MAX_PAGES || engagers.length >= MAX_TOTAL) partial = true;
    return { engagers, partial };
  }

  // ---- 1. fetch interception ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes('/graphql')) {
        noteGraphqlBody(url, headersToObject(args[1] && args[1].headers), args[1] && args[1].body);
        const feedUrl = feedUrlFromBody(args[1] && args[1].body);
        p.then((resp) => {
          try {
            resp.clone().text().then((t) => handleJsonText(t, 'fetch', feedUrl)).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  // ---- 2. XHR interception ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tseUrl = String(url || '');
    this.__tseHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (this.__tseHeaders) this.__tseHeaders[name] = value; } catch (_) {}
    return origSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__tseUrl && this.__tseUrl.includes('/graphql')) {
      noteGraphqlBody(this.__tseUrl, this.__tseHeaders || {}, body);
      const feedUrl = feedUrlFromBody(body);
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            handleJsonText(this.responseText, 'xhr', feedUrl);
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
    if (!t) return;
    if (t.indexOf('"adp_') !== -1) harvestPreloaderVars(t); // variables registrations
    if (hasMarker(t) || t.indexOf('text_app_default_board_new') !== -1) {
      handleJsonText(t, 'embedded');
    }
  }
  function scanAllEmbedded() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    // registrations first, so payload attribution can join on the adp_ label
    scripts.forEach((s) => {
      const t = s.textContent;
      if (t && t.indexOf('"adp_') !== -1) harvestPreloaderVars(t);
    });
    scripts.forEach(scanScript);
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

  // ---- 4. Message handling from content.js (replay + engager fetch) ----
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__tse !== true) return;
    if (d.type === 'TSE_GET_ENGAGERS') {
      fetchEngagers(d.postId, d.tabType).then(
        (r) => window.postMessage({ __tse: true, type: 'TSE_ENGAGERS', reqId: d.reqId, ok: true, engagers: r.engagers, partial: r.partial }, window.location.origin),
        (e) => window.postMessage({ __tse: true, type: 'TSE_ENGAGERS', reqId: d.reqId, ok: false, error: String((e && e.message) || e) }, window.location.origin)
      );
      return;
    }
    if (d.type !== 'TSE_RESCAN') return;
    const snapshot = replay.slice(); // scanAllEmbedded() below emits live; avoid double-posting
    scanAllEmbedded();
    for (const m of snapshot) window.postMessage(m, window.location.origin);
  });
})();
