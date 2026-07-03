# Threads Saved Posts Extractor

Personal MV3 Chrome extension that exports **your own** saved (bookmarked)
Threads posts as JSON / CSV / Markdown. Everything stays local — no backend,
no accounts, no data leaves your machine.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder (`threads-saved-extractor`)

## Use

1. Open [threads.com/saved](https://www.threads.com/saved) while logged in
   (if you're elsewhere on threads.com the extension navigates there for you)
2. Click the extension icon → **Grab all saved**
3. The page auto-scrolls (~1s per step, rate-limited on purpose); the popup
   shows a live count. It stops by itself at the end of the feed.
4. Export with **JSON / CSV / MD**. **Clear captured data** resets the store.

Capture is passive: it reads the GraphQL responses Threads itself loads while
scrolling. You can also just scroll the saved page manually — anything that
loads gets captured, no "grab" needed.

## How it works

```
threads.com tab
 ├─ inject.js   (MAIN world)  wraps fetch/XHR, matches responses containing
 │              "saved_media"; also scans the server-embedded JSON that holds
 │              the FIRST batch (it is never fetched, so interception alone
 │              would miss it)
 ├─ content.js  (isolated)    relays batches to the service worker, drives
 │                            auto-scroll until page_info.has_next_page=false
 │                            or the feed stops growing
 ├─ sw.js                     dedupes by post id, normalizes, buffers in
 │                            chrome.storage.local
 └─ popup                     start/stop, live count, export via chrome.downloads
```

### Discovery findings (2026-07-03, encoded in `inject.js` / `lib/normalize.js`)

| What | Value |
|---|---|
| Endpoint | `POST https://www.threads.com/graphql/query` (threads.com host — no instagram.com permission needed) |
| Query | `BarcelonaSavedPageViewerQuery` / `BarcelonaSavedPagePaginationFragment_connection` |
| Node path | `data.xdt_text_app_viewer.saved_media.edges[].node.thread_items[].post` |
| Pagination | `saved_media.page_info.{end_cursor, has_next_page}` |
| Post URL | `https://www.threads.com/@{user.username}/post/{code}` |
| Saved timestamp | **not exposed** anywhere → `savedAt` is always `null` |

### About `savedAt` / `savedOrder`

`savedAt` is always `null` because Threads simply never sends the save time:
the post node only carries `has_viewer_saved: true`, per-edge cursors are
empty, and `page_info.end_cursor` decodes to an opaque signed blob (verified
live). As a proxy, the extension records **`savedOrder`** — the feed is
ordered by save recency, so `savedOrder: 1` = your most recently saved post.
Exports are sorted by it. It's accurate for a clean top-to-bottom grab; if you
re-grab later without **Clear**, newly saved posts get appended with *higher*
numbers, so hit **Clear** first when the exact order matters.

Capture matches responses by **content** (the `saved_media` key), not by
`doc_id`, so Meta's doc_id rotation doesn't break it. If Meta renames the
connection itself, update `MARKER` in `inject.js` and the field map in
`lib/normalize.js` (re-derive via DevTools → Network → the request fired when
the saved page loads a new batch).

## Permissions

`storage` (buffer), `downloads` (export), host access to threads.com only.
No `tabs`, `webRequest`, `scripting`, or instagram.com access. MAIN-world
injection is declared statically in the manifest (needs Chrome 111+).

## Caveats

- Personal use on your own data; keep it unpublished. Meta's internal GraphQL
  shape **will drift** eventually — see the re-discovery note above.
- Media are exported as URLs only; fbcdn URLs are signed and **expire after a
  few days**, so download anything you want to keep soon after export.
- Also worth checking: Meta's **"Download Your Information"** may include
  saved posts as a free win (Settings → Account Center → Your information).
