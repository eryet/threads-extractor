# Pacing, caps & rate-limit posture

Everything the extension does that causes network traffic, how fast it goes,
and where to tune it. Two kinds of traffic exist:

1. **Passive** — feed/saved/profile grabs never fetch anything themselves;
   they scroll the page and Threads' own code decides when to request the
   next batch. The extension only controls the *scroll* cadence.
2. **Active** — the who-liked / who-reposted fetch (`fetchEngagers` in
   `inject.js`) is the one place the extension issues GraphQL requests
   itself, in a pagination loop.

## All pacing knobs

| Knob | Where | Value | Paces |
| --- | --- | --- | --- |
| Scroll step delay | `STEP_MS_MIN`/`STEP_MS_MAX`, `content.js` | 900–1500 ms, jittered | single-feed **and** per-column batch scrolling; Threads' IntersectionObserver then decides if a step actually fires a request |
| Idle give-up | `IDLE_LIMIT`, `content.js` | 8 quiet cycles (≈10 s) | when a feed/column is declared exhausted |
| Batch width | `MAX_COLUMNS`, `content.js` | 4 | columns scrolled per tick — up to 4 feed requests can land together (same burst the board UI itself produces) |
| Engager page delay | `fetchEngagers`, `inject.js` | 120–360 ms, jittered (mean 240) | delay between likers/reposters pages |
| Engager page size | `PAGE_SIZE`, `inject.js` | 100 | server-capped at ~100 regardless of `first` |
| Engager caps | `MAX_PAGES` / `MAX_TOTAL`, `inject.js` | 120 pages / 10 000 accounts | stops huge lists; result flagged `partial`, dashboard shows "N of M" |
| Engager timeout | `FETCH_ENGAGERS` handler, `content.js` | 180 s | dashboard request abandoned if the tab never answers |

One-shot delays (first scroll step 800 ms, freshly added column skeleton wait
2.5 s, 600 ms settle between batch waves) are setup/teardown, not a repeating
cadence — nothing to jitter.

## Engager fetch — worst case

A post that hits the 10 000-account cap costs ~100 requests over roughly
25–60 s (jittered). Typical posts (≤ a few hundred likers) are 1–5 requests.
A mid-run page failure keeps what was already collected instead of erroring.

## Ban-risk reasoning (as of 2026-07)

- The engager fetch replays `BarcelonaFeedbackHubTabQuery` with headers/body
  borrowed from the page's own requests — same shape as clicking "View
  activity", just faster. Read-only, own-session data.
- Meta's aggressive enforcement targets **write** automation and cross-account
  scraping; the realistic downside here is a soft rate-limit or temporary
  feature block (surfaces as a failed/partial grab), not an account ban.
- The signals that *would* stand out: burst rate (many pages/second — hence
  the jittered delay), and frequency (many posts grabbed back-to-back —
  self-restraint is the only control). Avoid hammering many large posts in
  one sitting.
- More safety margin = raise the engager delay (e.g. `400 + Math.random() *
  400`) and/or lower `MAX_PAGES`. Cost is linear in fetch time.
- Automated collection violates Meta's ToS regardless of detection, so
  enforcement is always at their discretion — keep it personal and
  low-volume.
