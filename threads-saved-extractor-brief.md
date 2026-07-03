# Threads Saved Posts Extractor — Build Brief

A personal Manifest V3 browser extension that extracts **all** of *my own* saved
(bookmarked) posts from Threads and exports them locally as JSON / CSV / Markdown.
Single user, no cloud backend, no account system.

> Scope note: this operates only on my own logged-in account data. It rides the
> session already present in the browser tab — it never handles passwords and
> creates no accounts.

---

## 1. Why an extension (context for the build)

- Threads' **official Graph API does not expose saved/bookmarked posts** — no
  endpoint to list them, no CSV export. The public API is publish + read-own-posts.
- So the only route to saved posts is **inside the logged-in web session**, which
  means a content-script extension (this is also how the commercial tool "Dewey"
  does it after migrating off unstable APIs).
- Because it's personal + single-user, we **drop the entire backend/sync half** and
  just write files locally. This removes most permissions and all server code.

---

## 2. Architecture (rough)

```
threads.com tab (my logged-in session)
        │
        ├─ [injected page-context script]  ← patches window.fetch / XHR
        │      captures saved-feed GraphQL RESPONSE bodies as JSON
        │
        ├─ [content script]                ← drives pagination (auto-scroll
        │      or cursor replay), relays captured data via runtime messaging
        │
        ▼
[service worker] ── dedupes, normalizes, buffers in chrome.storage
        │
        ▼
[popup UI]  ── "Grab all saved", progress, "Export JSON / CSV / MD" (file download)
```

**Key MV3 constraint:** `webRequest` in MV3 **cannot read response bodies**. So the
actual post JSON must be captured by a **page-context injected script that wraps
`fetch`/`XHR`**, not by `webRequest`. Use `webRequest`/header sniffing only if we
need to lift request auth for cursor-replay (see §5, option B).

---

## 3. Permissions (keep minimal)

```jsonc
// manifest.json (MV3)
{
  "manifest_version": 3,
  "permissions": ["storage", "scripting", "downloads"],
  "host_permissions": ["https://www.threads.com/*", "https://threads.com/*"],
  // add "https://www.instagram.com/*" ONLY if discovery shows the saved-feed
  // GraphQL request is issued against an instagram.com host (Threads auth is
  // coupled to Instagram/Meta infra).
  "background": { "service_worker": "sw.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{
    "matches": ["https://www.threads.com/*", "https://threads.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }]
}
```

Deliberately **not** requesting: `tabs`, `webRequest`, `identity`, `bookmarks`,
`activeTab`. Add back only if a discovery step proves one is required.

---

## 4. File structure

```
threads-saved-extractor/
├─ manifest.json
├─ sw.js            # service worker: message hub, dedupe, storage, export trigger
├─ content.js       # injects inject.js, drives scroll/pagination, relays data
├─ inject.js        # page-context: patches fetch/XHR, emits captured JSON via
│                   #   window.postMessage back to content.js
├─ popup.html
├─ popup.js         # UI: start grab, live count, export buttons
└─ lib/
   ├─ normalize.js  # raw GraphQL node -> clean {id, author, text, url, media, savedAt}
   └─ export.js     # toJSON / toCSV / toMarkdown + chrome.downloads
```

---

## 5. Capture strategy — TWO options, decide after discovery

**Option A — Passive interception + auto-scroll (simpler, more robust):**
1. `inject.js` wraps `fetch`/`XHR`; whenever a response matches the saved-feed
   query, clone it, extract nodes, `postMessage` them out.
2. `content.js` auto-scrolls the saved page to force Threads to lazy-load every
   batch; stops when scroll height stabilizes / no new items for N cycles.
3. Rate-limit the scroll (e.g. 800–1500ms between steps) to avoid abuse detection.

**Option B — Active cursor replay (faster, more brittle):**
1. Capture one real saved-feed request (URL, headers, body) — this is where the
   Meta auth tokens live: `fb_dtsg`, `lsd`, `X-IG-App-ID`, and a rotating
   numeric `doc_id`.
2. Replay it from the page context, following the `end_cursor` / `has_next_page`
   pagination until exhausted.
3. Downside: `doc_id` and payload shape change across Meta deploys — expect to
   re-discover them periodically.

**Recommendation:** build **Option A first** (survives token/doc_id rotation),
keep B as an optional accelerator.

---

## 6. ⚠️ Discovery steps Claude Code MUST do first (do not guess these)

These are unknown until inspected live in DevTools on the real saved page. Do not
fabricate endpoint names, `doc_id`s, or JSON paths — derive them:

1. Open `threads.com`, go to the **Saved** page, open DevTools → Network → Fetch/XHR.
2. Scroll to load a batch. Identify the **GraphQL request** that returns saved
   posts. Record: request URL/host, the `doc_id` (or friendly name), request body
   params, and which header carries auth.
3. Inspect the **response JSON shape** — find the array of post nodes and the
   **pagination cursor** fields (`page_info` / `end_cursor` / `has_next_page` or
   equivalents). Write these paths down; `normalize.js` maps from them.
4. Confirm whether the request goes to a `threads.com` or `instagram.com` host
   (decides the instagram.com host-permission question in §3).
5. Note the DOM structure of a saved-feed item as a **fallback** scraper in case
   the GraphQL shape is hostile.

Encode the findings as constants at the top of `inject.js` / `normalize.js`.

---

## 7. Output schema (normalized)

```jsonc
{
  "id": "string",              // post id
  "url": "https://www.threads.com/@user/post/…",
  "author": { "handle": "@user", "name": "Display Name" },
  "text": "post body text",
  "media": ["https://…"],      // image/video URLs if present
  "savedAt": null,             // fill if the API exposes a saved timestamp, else null
  "capturedAt": "ISO-8601"     // when this tool grabbed it
}
```

Exports: **JSON** (full fidelity), **CSV** (flat: id,url,handle,name,text,savedAt),
**Markdown** (one `## @handle` block per post with text + link). Media = URLs only
in v1 (downloading binaries can be a v2).

---

## 8. Build order (suggested milestones)

1. Skeleton MV3 extension that injects `inject.js` and logs any captured
   saved-feed response to console. **(proves interception works)**
2. Normalize one batch → render live count in popup.
3. Auto-scroll pagination until exhausted + dedupe by `id`.
4. Export JSON, then CSV, then Markdown via `chrome.downloads`.
5. Polish: progress bar, stop/resume, error handling for shape changes.

---

## 9. Caveats to keep in mind (not blockers, just awareness)

- Meta enforces anti-automation ToS aggressively; this is personal-use on my own
  data and stays unpublished, which is the low-risk zone. Don't add multi-account
  or scraping-of-others features.
- Internal GraphQL shape is undocumented and **will drift** — that's why Option A
  and the DOM fallback exist.
- Before building, also generate a Meta **"Download Your Information"** archive
  once to check whether saved posts are already included there (possible free win).
