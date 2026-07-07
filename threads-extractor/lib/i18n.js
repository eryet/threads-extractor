// i18n.js — thin wrapper over chrome.i18n; strings live in _locales/{en,zh_TW}.
// Language follows the browser UI language (Chrome picks the locale dir).
// Loaded by popup.html / dashboard.html via <script>, and on threads.com as a
// content script (before content.js). Exposes TSEI18n on window/self.
(function () {
  'use strict';

  // Service-worker error strings are stored in English; translate at display
  // time so sw.js stays language-free. Regexes can't live in messages.json,
  // so this map stays here.
  const ERROR_MAP = {
    'No threads.com tab found — open threads.com/saved first.': '找不到 threads.com 分頁 — 請先開啟 threads.com/saved。',
    'No threads.com tab found — open threads.com/liked first.': '找不到 threads.com 分頁 — 請先開啟 threads.com/liked。',
    'No threads.com tab found — open threads.com first.': '找不到 threads.com 分頁 — 請先開啟 threads.com。',
    'Could not reach the Threads tab — reload it and try again.': '無法連線到 Threads 分頁 — 請重新整理後再試。',
    'Lost the Threads tab mid-run.': '執行途中失去 Threads 分頁。',
    'Lost the Threads tab mid-grab.': '擷取途中失去 Threads 分頁。',
    'Lost the Threads tab.': '失去 Threads 分頁。',
    'No feeds selected.': '未選擇任何動態。',
    'Could not open any feed columns on the board.': '無法在看板開啟任何動態欄位。',
    'columns run stalled — stopped (keep the tab visible)': '欄位執行停滯 — 已停止（請保持分頁可見）',
    'Could not find your profile link — reload the Threads tab, or type a handle.': '找不到你的個人檔案連結 — 請重新整理 Threads 分頁，或輸入帳號。',
    'No feed columns pinned on your board — add feed columns first.': '你的看板沒有釘選動態欄位 — 請先新增動態欄位。',
    'Storage is full — capture stopped. Export, then delete old posts to free space.': '儲存空間已滿 — 擷取已停止。請先匯出，再刪除舊貼文以釋放空間。',
  };
  const ERROR_PATTERNS = [
    [/^"(.+)" stalled — skipped$/, '「$1」停滯 — 已略過'],
    [/^couldn't open: (.+)$/, '無法開啟：$1'],
    [/^"(.+)" is not a valid handle\.$/, '「$1」不是有效的帳號。'],
    [/^profile (?:threads|replies) stalled — moved on$/, '個人檔案擷取停滯 — 已結束'],
    [/^Internal error: (.+)$/, '內部錯誤：$1'],
  ];

  // locale_tag in each messages.json says which locale Chrome actually served
  // (e.g. a zh-CN browser falls back to en, not zh_TW)
  let lang = 'en';
  try { lang = chrome.i18n.getMessage('locale_tag') || 'en'; } catch (_) {}

  async function init() { return lang; } // kept async for existing callers

  function t(key, subs) {
    let s = '';
    try { s = chrome.i18n.getMessage(key); } catch (_) {}
    if (!s) s = key;
    if (subs) {
      for (const k of Object.keys(subs)) s = s.split('{' + k + '}').join(String(subs[k]));
    }
    return s;
  }

  function translateError(s) {
    if (lang !== 'zh_TW' || !s) return s;
    if (ERROR_MAP[s]) return ERROR_MAP[s];
    for (const [re, out] of ERROR_PATTERNS) {
      if (re.test(s)) return s.replace(re, out);
    }
    return s;
  }

  // apply data-i18n / data-i18n-title / data-i18n-placeholder to static markup
  function apply(root) {
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    r.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    r.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    r.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  const api = {
    init, t, apply, translateError,
    get lang() { return lang; },
  };
  if (typeof window !== 'undefined') window.TSEI18n = api;
  else self.TSEI18n = api;
})();
