# Privacy Policy — Threads Extractor

_Last updated: 2026-07-09_

Threads Extractor is a browser extension that captures the user's own
Threads (threads.com) data — saved posts, selected feeds, and profile
threads/replies — for local browsing and export.

## What data is handled

The extension reads website content from threads.com pages you visit
while logged in to your own account: post text, author handles, post
URLs, dates, like/reply counts, and media URLs. It also stores small UI
preferences (e.g. which feeds you selected, posts-per-feed).

## Where the data goes

**Nowhere.** All captured data is stored locally in your browser using
`chrome.storage.local`. The extension has no backend, no servers, no
accounts, no analytics, and no trackers. Nothing is transmitted to the
developer or to any third party.

Export files (JSON / CSV / Markdown) are generated locally and saved
only to your own computer via the browser's download function, and only
when you explicitly click an export button.

## What the extension does NOT do

- It does not collect, transmit, sell, or share any data.
- It does not access any website other than threads.com.
- It does not use remote code, cookies of its own, or fingerprinting.
- It does not read your Threads credentials; it only reads content that
  threads.com already delivers to your logged-in session.

## Data retention and deletion

Captured data stays in your browser until you delete it. You can delete
it at any time with the **Clear** buttons in the popup, the **Delete
shown posts** action in the dashboard, or by uninstalling the extension
(which removes all stored data).

## Contact

Questions or concerns: open an issue at
<https://github.com/eryet/threads-extractor/issues>.
