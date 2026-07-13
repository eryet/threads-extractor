# Threads Extractor

Personal MV3 Chrome extension that grabs **your own** Threads data — saved
(bookmarked) posts, the top N posts of any feed (For you / Following / Ghost
posts / custom feeds, one by one or in waves of 4 board columns), profiles
(threads + replies), and search results (any query, Top or Recent) — then
lets you browse it all in a local dashboard and export JSON / CSV / Markdown. Everything stays local — no
backend, no accounts, no data leaves your machine.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder (`threads-extractor`)

Note: Chrome keys an unpacked extension's identity (and its stored data) to
the folder path — if you rename or move this folder, re-load it and expect an
empty store (export first if you care about what's captured).

## Use

### Saved posts

1. Open [threads.com/saved](https://www.threads.com/saved) while logged in
   (if you're elsewhere on threads.com the extension navigates there for you)
2. Click the extension icon → **Grab all saved**
3. The page auto-scrolls (~1s per step, rate-limited on purpose); the popup
   shows a live count. It stops by itself at the end of the feed.
4. Export with **JSON / CSV / MD**. **Clear captured data** resets the store.

Saved capture is passive: anything that loads on /saved gets captured even
without hitting "grab".

### Feeds (automated multi-feed runs)

1. Have any threads.com tab open. Your custom feeds appear in the popup's
   **Feeds** checklist automatically (they're discovered passively from page
   data whenever you're on a single-column page — visit any feed or the saved
   page once if the list is empty).
2. Tick the feeds you want (For you / Following / Ghost posts / your custom
   feeds — selection is remembered), set **Posts per feed** (default 100),
   and click **Grab selected feeds**.
3. The extension does the rest: it navigates the tab to each selected feed in
   turn, scrolls, captures the top N posts, and moves on — no interaction
   needed. Keep the tab visible; Threads pauses feed loading in hidden tabs.
   A watchdog skips any feed that stalls for 60s, so a run always finishes.
4. Export everything with the Feeds section's **JSON / CSV / MD** buttons —
   one combined file with a `feed` column/section per feed.

Each run starts from a clean slate ("the top N of these feeds right now").
Unlike saved capture, feed capture only records while a run is active and
only from the tab driving it — normal browsing is never hoovered up. A post
appearing in two selected feeds is kept once per feed, so per-feed rankings
stay complete.

#### Board columns (parallel, 4 at a time in waves)

**Grab in batch** uses the board home (`/`) instead of navigating feed→feed:
it opens selected feeds as board columns, 4 at a time, scrolls all of them at
the same time, then closes that wave's columns and opens the next 4 — until
every selected feed is grabbed. The popup shows wave progress ("batch 2/3").
Feeds you already had pinned as columns are reused and left alone.

The add/remove automation drives Threads' own "Add a column" → Feeds →
&lt;name&gt; and column "More" → "Remove column" menus with synthesized pointer
events (verified live), so it depends on the **English UI strings** — if your
Threads UI language isn't English, pin the columns manually and the run will
use them. If a run is interrupted mid-way (tab closed / navigated), columns
it added may stay pinned; remove them by hand.

Because columns interleave their responses in one tab, each captured batch is
attributed to its feed via the GraphQL request variables (`variant` for
built-ins, `interest_feed_id` for custom feeds) rather than by page URL — see
the discovery table. Everything else matches sequential runs: same clean
slate, same `feed`/`feedOrder` fields, same exports, same watchdog. Keep the
tab visible; hidden tabs pause all columns at once.

### Profiles (yours or anyone's · threads + replies)

1. In the popup's **Profile** tab, optionally type a **@handle** (leave it
   blank for your own profile), then click **Grab threads** or **Grab
   replies**.
2. The extension navigates to that profile (or its Replies tab) and grabs
   top-to-bottom. Only posts authored by the profile owner are stored — but
   each reply embeds the **full post it replies to** as `replyTo` (a complete
   normalized post: author, text, URL, date, likes, media). A blank handle
   resolves your own from the sidebar Profile link.
3. Grabs are independent and additive: threads and replies are separate
   buttons, each replaces only *that profile's* *that section*, and different
   users accumulate — so you can build up several people's posts and export
   them together.
4. Export with the Profile tab's **JSON / CSV / MD** buttons. Output is
   grouped by profile then section (`profile` + `section` columns in CSV);
   Markdown nests profile → section → posts and block-quotes each replied-to
   post in full.

This reads other users' **public** posts through your own logged-in session,
one profile at a time, with the same deliberately throttled scrolling — a
private account you don't follow simply returns nothing. Keep it personal and
low-volume.

### Search results (any query · Recent / Top / Profiles)

1. In the popup's **Search** tab, type the search terms — or just search on
   Threads first: if your Threads tab is already on `/search?q=…`, the popup
   detects it and prefills the query and filter from the tab (a click-to-use
   hint appears under the box). Pick **Max results** and the **results
   filter** — all three of Threads' serp tabs are supported: **Recent**
   (default; paginates newest-first), **Top** (Threads' ranking), or
   **Profiles** (matching accounts instead of posts) — then **Grab search
   results**.
2. The extension navigates your Threads tab to `/search?q=…`, auto-scrolls
   with the same throttled pacing, and stops at the target count or the end
   of the results.
3. Recent/Top grabs store posts tagged with the query (`searchQuery`), the
   filter used (`searchFilter`), and capture order (`searchOrder`, 1 = first
   result at grab time). Profiles grabs store flat **account records**
   (handle, name, bio, follower count, verified/private flags, profile URL)
   with the same query tagging. Different queries **accumulate**; re-grabbing
   a query replaces only that query's earlier snapshot (posts and accounts).
4. The popup keeps a **remembered searches** list (last 15 queries, filter
   included): click a row to refill the form, or its ▶ button to re-run that
   search as-is.
5. Export posts with **Export posts** (`query` + `searchOrder` CSV columns;
   Markdown groups by query) and accounts with **Export accounts** (appears
   once a Profiles grab has stored some). In the dashboard, search *posts*
   are a source of their own with per-query filter chips; account records
   are export-only (the dashboard renders posts).

### Dashboard (browse everything captured)

Click **Dashboard ↗** in the popup header to open a full-page view of every
captured post — saved, feeds, and profiles together. It reads the extension's
storage directly (no export needed) and updates live while a grab is running.

- **Filter** by source, feed, profile / section, or author (click any author
  chip or a card's @handle); combine with full-text search (`/` focuses it),
  a with-media / text-only toggle, and a minimum reply-count filter.
- **Sort** by capture order (default — same order as exports), post date,
  likes, or replies. Grid, list, and compact (reddit-style) layouts.
- **Export this view**: the JSON / CSV / MD buttons export exactly what the
  current filters show, so the dashboard doubles as an export query builder.
- **Import**: load earlier JSON exports back in (multiple files ok) — exports
  double as backups. Duplicates are skipped, and imported feed posts survive
  future runs (which otherwise start from a clean slate).
- **Delete this view**: removes exactly what the current filters show (one
  feed, one profile, an author, a date range, a search — any combination),
  with a two-click confirm. Finer-grained than the popup's per-tab Clear
  buttons; can't be undone, so export first if unsure.

Media are shown from Meta's signed CDN URLs, so image thumbnails only render
while the URLs are still valid (a few days); expired ones collapse to a
placeholder. Videos don't play outside Threads' own player, so they render as
a ▶ tile that opens the post.

## How it works

```
threads.com tab
 ├─ inject.js   (MAIN world)  wraps fetch/XHR, matches responses containing a
 │              known connection key (saved_media / feedData / results); also
 │              scans the server-embedded JSON that holds each page's FIRST
 │              batch (it is never fetched), and keeps a replay buffer so a
 │              grab started after page load can recover earlier batches
 ├─ content.js  (isolated)    relays batches (tagged saved/feed) + the feed
 │                            list to the service worker; drives auto-scroll
 │                            until has_next_page is false, the feed stops
 │                            growing, or the SW says stop; announces
 │                            CONTENT_READY after each navigation
 ├─ sw.js                     two stores: saved (always-on capture) and feeds
 │                            (per-run, target-capped). Multi-feed runs: keeps
 │                            a queue, navigates the tab feed→feed
 │                            (chrome.tabs.update), starts scrolling on
 │                            CONTENT_READY, advances at target / feed end,
 │                            watchdog alarm skips stalled feeds
 └─ popup                     Saved section + Feeds checklist (discovered
 │                            custom feeds + built-ins), posts-per-feed, live
                              run progress, exports via chrome.downloads
```

### Discovery findings (2026-07-03 saved, 2026-07-06 feeds — encoded in `inject.js` / `lib/normalize.js`)

| What | Value |
|---|---|
| Endpoint | `POST https://www.threads.com/graphql/query` (threads.com host — no instagram.com permission needed) |
| Saved query | `BarcelonaSavedPageViewerQuery` / `BarcelonaSavedPagePaginationFragment_connection` |
| Saved path | `data.xdt_text_app_viewer.saved_media.edges[].node.thread_items[].post` |
| For you / Following query | `BarcelonaFeedPaginationDirectQuery` |
| For you / Following path | `data…feedData.edges[].node.text_post_app_thread.thread_items[].post` (edges without a thread — e.g. `suggested_users` — are skipped) |
| Custom feed query | `BarcelonaCustomFeedRefetchableQuery` (page `/custom_feed/<id>/`) |
| Custom feed path | `data…results.edges[].node.thread_items[].post` (`results` is generic, so it only counts when its edges carry posts) |
| Search query (2026-07-13) | `BarcelonaSearchResultsQuery` (page `/search?q=<q>`, `&filter=recent` for the Recent tab) |
| Search path | `data…searchResults.edges[].node.thread.thread_items[].post` — the connection is `searchResults` itself (`edges` + `page_info` directly on it); the Profiles serp reuses it with non-post nodes, which are skipped |
| Search attribution | request `variables.query` (the term) + `variables.recent` (`1` = Recent tab, `0` = Top); embedded first batches join their `adp_BarcelonaSearchResultsQueryRelayPreloader_…` registration like feeds do |
| Search profiles (2026-07-13) | `BarcelonaSearchUserResultsQuery` (page `/search?q=<q>&filter=profiles`, variables `{query}`); same `searchResults` connection but node = `XDTUserDict` `{username, full_name, biography, follower_count, is_verified, text_post_app_is_private, pk}` — captured as flat account records |
| Pagination | `<conn>.page_info.{end_cursor, has_next_page}` on every connection |
| Post URL | `https://www.threads.com/@{user.username}/post/{code}` |
| Saved timestamp | **not exposed** anywhere → `savedAt` is always `null` |
| Feed pages | only the single-column pages (`/for_you/` etc.) window-scroll; the board home (`/`) uses column scrollers and is not driven |
| Custom-feed list | embedded on single-column pages: `data.custom_feeds.interest_feeds[] = {feed_name, id}` → page `/custom_feed/<id>/` |
| Profile (Threads + Replies tabs) | `/@user` and `/@user/replies` both use connection key `mediaData`, node = thread with `thread_items[].post`; Replies threads interleave parent posts by others (filtered by username) |
| Post engagers (who liked / reposted) | The default sort (`BarcelonaFeedbackHubTabQuery`) caps at ~100 and does **not** paginate. The **most-recent** sort does: `BarcelonaFeedbackHubTabContentRefetchableQuery` (doc_id rotates), connection `data.feedback_hub_tab_items`; variables `{post_id: <numeric pk>, tab_type: 'like' / 'repost' / 'quote', sort_type: 'most_recent', first, after}` + relay providers; node = `{actor:{username, pk}, extra:{context}, timestamp}`, standard `page_info`. Page size is server-capped at ~100. Fetched on demand from the dashboard — see below |
| Own username | the only bare `/@x` link inside the sidebar `[role="navigation"]` |
| Board columns (2026-07-06) | pinned-column list embedded as `…text_app_default_board_new.columns.edges[].node.uri` (`/for_you`, `/custom_feed/<id>`, …), same order as the `[data-column-scrollable]` DOM elements |
| Feed attribution | request `variables.variant` (`for_you` / `following` / …) for built-ins, `variables.interest_feed_id` (posts) / `custom_feed_id` (metadata) for custom feeds; embedded first batches join their `{"adp_<label>","queryID":…,"variables":{…}}` registration via the shared `adp_` label |

### About order fields

`savedAt` is always `null` because Threads never sends the save time (the post
node only carries `has_viewer_saved: true`, per-edge cursors are empty, and
`page_info.end_cursor` decodes to an opaque signed blob — verified live). As a
proxy the extension records **`savedOrder`** — the saved feed is ordered by
save recency, so `savedOrder: 1` = your most recently saved post. Accurate for
a clean top-to-bottom grab; hit **Clear** first when exact order matters.

Feed runs record **`feedOrder`** the same way (`1` = top of that feed at grab
time) plus `feed` (the feed's name) and `feedIndex` (the feed's position in
the run, used to keep exports in run order). Runs always start from a clean
slate, so `feedOrder` is always a clean per-feed ranking.

Capture matches responses by **content** (connection key names), not by
`doc_id`, so Meta's doc_id rotation doesn't break it. If Meta renames a
connection, update `CONN_KINDS` in `inject.js` (re-derive via DevTools →
Network → the request fired when the page loads a new batch).

## Permissions

`storage` (buffer), `downloads` (export), `alarms` (watchdog that keeps
multi-feed runs from hanging when the MV3 service worker sleeps), host access
to threads.com only. No `tabs`, `webRequest`, `scripting`, or instagram.com
access — navigation between feeds uses `chrome.tabs.update`, which needs no
extra permission. MAIN-world injection is declared statically in the manifest
(needs Chrome 111+).

## Caveats

- Personal use on your own data, at a personal, low-volume scale. Meta's
  internal GraphQL shape **will drift** eventually — see the re-discovery
  note above.
- Keep the tab **visible** during a grab: Threads throttles hidden tabs and
  feed pagination stops (verified live — this is a Threads behavior, not an
  extension bug).
- Media are exported as URLs only; fbcdn URLs are signed and **expire after a
  few days**, so download anything you want to keep soon after export.
- The For you feed is effectively endless — the target count is what stops a
  grab there.
- Also worth checking: Meta's **"Download Your Information"** may include
  saved posts as a free win (Settings → Account Center → Your information).
