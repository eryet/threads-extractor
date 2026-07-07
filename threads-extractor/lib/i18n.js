// i18n.js — tiny two-language dictionary (en / zh_TW) with a manual override
// stored in chrome.storage.local (tse_lang: 'auto' | 'en' | 'zh_TW').
// Loaded by popup.html / dashboard.html via <script>, and on threads.com as a
// content script (before content.js). Exposes TSEI18n on window/self.
(function () {
  'use strict';

  // key: [english, 繁體中文]
  const DICT = {
    // ---- popup: tabs + shared ----
    tab_saved: ['Saved', '已儲存'],
    tab_liked: ['Liked', '已按讚'],
    tab_feeds: ['Feeds', '動態'],
    tab_profile: ['Profile', '個人檔案'],
    head_export: ['Export', '匯出'],
    btn_dashboard: ['Dashboard ↗', '儀表板 ↗'],
    btn_stop: ['Stop', '停止'],

    // ---- popup: saved pane ----
    lbl_saved_captured: ['saved posts captured', '已擷取的儲存貼文'],
    btn_grab_saved: ['Grab all saved', '擷取全部儲存貼文'],
    btn_clear_saved: ['Clear captured data', '清除擷取資料'],
    st_ready: ['ready', '就緒'],
    st_grabbing_saved: ['grabbing… scrolling the saved feed', '擷取中…正在捲動儲存貼文'],
    st_saved_done: ['done — reached the end of the saved feed', '完成 — 已到達儲存動態底部'],
    st_posts_captured: ['posts captured', '已擷取貼文'],

    // ---- popup: liked pane ----
    lbl_liked_captured: ['liked posts captured', '已擷取的按讚貼文'],
    btn_grab_liked: ['Grab all liked', '擷取全部按讚貼文'],
    btn_clear_liked: ['Clear liked data', '清除按讚資料'],
    st_grabbing_liked: ['grabbing… scrolling your liked posts', '擷取中…正在捲動按讚貼文'],
    st_liked_done: ['done — reached the end of your liked posts', '完成 — 已到達按讚貼文底部'],

    // ---- grab limits (saved + liked) ----
    lbl_max_posts: ['Max posts (blank = all)', '最多貼文數（留空＝全部）'],
    lbl_until_date: ['Stop at posts older than', '停在早於此日期的貼文'],
    st_stopped_limit: ['stopped — reached the post limit', '已停止 — 達到貼文數上限'],
    st_stopped_date: ['stopped — reached posts older than the date', '已停止 — 到達早於指定日期的貼文'],

    // ---- popup: feeds pane ----
    lbl_feed_captured: ['feed posts captured', '已擷取的動態貼文'],
    st_select_feeds: ['select feeds, then run', '選擇動態後開始'],
    pick_feeds: ['Feeds', '動態'],
    link_all: ['all', '全選'],
    link_none: ['none', '全不選'],
    sel_count: ['{n} selected', '已選 {n} 個'],
    hint_custom_feeds: [
      'open any feed page once so your custom feeds show up here',
      '開啟任一動態頁面一次，自訂動態就會出現在這裡',
    ],
    lbl_target: ['Posts per feed', '每個動態的貼文數'],
    btn_batch: ['Grab in batch · 4 at a time', '批次擷取 · 每批 4 個'],
    btn_onebyone: ['Grab one by one', '逐一擷取'],
    hint_batch: [
      'batch grabs every selected feed, opening them side by side 4 at a time (in waves) · one by one visits each feed page in turn — either way, keep the tab visible',
      '批次：擷取所有所選動態，每批並排開啟 4 個（分批進行）· 逐一：依序造訪每個動態頁面 — 兩種方式都需保持分頁可見',
    ],
    btn_stop_run: ['Stop run', '停止執行'],
    btn_clear_feed: ['Clear feed data', '清除動態資料'],
    group_builtin: ['Built-in', '內建'],
    group_custom: ['Your custom feeds', '你的自訂動態'],
    st_feed_progress: ['feed {i} of {n} — {name} · {cur}/{target}', '第 {i}/{n} 個動態 — {name} · {cur}/{target}'],
    st_columns_progress: ['board columns — {done}/{n} feeds done · {count} posts', '看板欄位 — {done}/{n} 個動態完成 · {count} 篇貼文'],
    st_columns_wave: ['batch {w}/{ws} — {done}/{n} feeds done · {count} posts total', '第 {w}/{ws} 批 — {done}/{n} 個動態完成 · 共 {count} 篇貼文'],
    st_columns_finding: ['board columns — finding feed columns…', '看板欄位 — 尋找動態欄位中…'],
    st_feed_done: ['done — {count} posts from {n} feed(s)', '完成 — {n} 個動態共 {count} 篇貼文'],
    st_could_not_start: ['could not start', '無法開始'],

    // ---- popup: profile pane ----
    lbl_prof_captured: ['profile posts captured', '已擷取的個人檔案貼文'],
    ph_handle: ['my profile (leave blank)', '我的個人檔案（留空）'],
    btn_grab_threads: ['Grab threads', '擷取串文'],
    btn_grab_replies: ['Grab replies', '擷取回覆'],
    hint_profile: [
      'blank = your own profile · replies include the full post replied to',
      '留空＝自己的個人檔案 · 回覆會包含被回覆的完整貼文',
    ],
    btn_clear_prof: ['Clear profile data', '清除個人檔案資料'],
    st_prof_ready: ["grab a profile — yours or anyone's", '擷取個人檔案 — 你的或任何人的'],
    st_prof_grabbing: ['grabbing {who} {stage}… {n} so far', '正在擷取 {who} 的{stage}… 目前 {n} 篇'],
    who_my: ['my', '我'],
    stage_threads: ['threads', '串文'],
    stage_replies: ['replies', '回覆'],
    n_threads: ['{n} threads', '{n} 篇串文'],
    n_replies: ['{n} replies', '{n} 篇回覆'],
    st_prof_multi: ['{count} posts across {n} profiles', '{n} 個帳號共 {count} 篇貼文'],

    // ---- language picker ----
    lang_label: ['Language', '語言'],

    // ---- dashboard: sidebar ----
    dash_title: ['Dashboard', '儀表板'],
    sec_source: ['Source', '來源'],
    sec_feed: ['Feed', '動態'],
    sec_profile: ['Profile', '個人檔案'],
    sec_authors: ['Top authors', '熱門作者'],
    sec_export: ['Export this view', '匯出目前檢視'],
    sec_import: ['Import', '匯入'],
    sec_delete: ['Delete', '刪除'],
    btn_delete_shown: ['Delete shown posts…', '刪除顯示中的貼文…'],
    confirm_delete: [
      "Delete the {n} posts the current filters show? This can't be undone.",
      '確定刪除目前篩選顯示的 {n} 篇貼文？刪除後無法復原。',
    ],
    confirm_del_post: [
      "Delete this post by {who}? This can't be undone.",
      '確定刪除 {who} 的這篇貼文？刪除後無法復原。',
    ],
    dlg_delete_title: ['Delete', '刪除'],
    btn_cancel: ['Cancel', '取消'],
    btn_delete: ['Delete', '刪除'],
    title_post_actions: ['post actions', '貼文動作'],
    menu_open_post: ['Open on Threads', '在 Threads 開啟'],
    menu_copy_link: ['Copy link', '複製連結'],
    menu_copied: ['Link copied', '已複製連結'],
    menu_delete_post: ['Delete post…', '刪除貼文…'],
    note_delete: [
      "Removes exactly what the current filters show — narrow it down with a feed, profile, author, date range or search first. Can't be undone; export first if unsure.",
      '只會刪除目前篩選顯示的貼文 — 可先用動態、個人檔案、作者、日期範圍或搜尋來縮小範圍。刪除後無法復原；不確定時請先匯出。',
    ],
    link_clear: ['clear', '清除'],
    nav_all: ['All posts', '全部貼文'],
    nav_saved: ['Saved', '已儲存'],
    nav_liked: ['Liked', '已按讚'],
    nav_feeds: ['Feeds', '動態'],
    nav_profiles: ['Profiles', '個人檔案'],
    chip_threads: ['Threads', '串文'],
    chip_replies: ['Replies', '回覆'],
    note_export: [
      "Exports exactly what the current filters show. Media URLs are signed by Meta's CDN and expire after a few days.",
      '匯出內容即為目前篩選所顯示的貼文。媒體網址由 Meta CDN 簽章，數天後就會失效。',
    ],
    btn_import: ['Import export JSON…', '匯入先前匯出的 JSON…'],
    note_import: [
      'Restore posts from earlier JSON exports (saved / feeds / profile — multiple files ok). Duplicates are skipped; imported feed posts survive future runs.',
      '從先前匯出的 JSON 還原貼文（儲存／動態／個人檔案，可多檔）。重複貼文會略過；匯入的動態貼文不會被之後的擷取清除。',
    ],
    imp_importing: ['importing {n} posts…', '匯入 {n} 篇貼文中…'],
    imp_done: ['imported {n} posts', '已匯入 {n} 篇貼文'],
    imp_dupes: [' · {n} duplicates skipped', ' · 略過 {n} 篇重複'],
    imp_badfiles: [' · {n} unreadable file(s)', ' · {n} 個檔案無法讀取'],
    imp_none: ['no posts found in the selected file(s)', '所選檔案中找不到貼文'],
    imp_unreadable: [
      'could not read those files — expected JSON exports from this extension',
      '無法讀取這些檔案 — 需為本擴充功能匯出的 JSON',
    ],

    // ---- dashboard: topbar ----
    ph_search: ['Search text, @handle, name…  ( / )', '搜尋內文、@帳號、名稱…（/）'],
    opt_all_posts: ['All posts', '全部貼文'],
    opt_with_media: ['With media', '有媒體'],
    opt_text_only: ['Text only', '純文字'],
    metric_replies: ['💬 replies', '💬 回覆'],
    metric_likes: ['❤️ likes', '❤️ 讚'],
    metric_reposts: ['🔁 reposts', '🔁 轉發'],
    metric_shares: ['📤 shares', '📤 分享'],
    opt_any: ['any', '不限'],
    title_min_metric: ['engagement filter — hide posts below the threshold', '互動數篩選 — 隱藏低於門檻的貼文'],
    title_date_range: ['posted between (takenAt)', '發佈日期範圍'],
    title_clear_dates: ['clear date range', '清除日期範圍'],
    btn_date_range: ['Date range', '日期範圍'],
    preset_today: ['Today', '今天'],
    preset_7d: ['Last 7 days', '過去 7 天'],
    preset_30d: ['Last 30 days', '過去 30 天'],
    preset_90d: ['Last 90 days', '過去 90 天'],
    preset_this_month: ['This month', '本月'],
    preset_this_year: ['This year', '今年'],
    preset_all: ['All time', '全部時間'],
    cal_hint_start: ['pick a start date', '選擇開始日期'],
    cal_hint_end: ['pick an end date — click a day', '選擇結束日期 — 點選日期'],
    opt_sort_capture: ['Capture order (asc)', '擷取順序（正序）'],
    opt_sort_capture_desc: ['Capture order (desc)', '擷取順序（倒序）'],
    opt_sort_new: ['Newest posted', '最新發佈'],
    opt_sort_old: ['Oldest posted', '最舊發佈'],
    opt_sort_likes: ['Most liked', '最多讚'],
    opt_sort_likes_asc: ['Least liked', '最少讚'],
    opt_sort_replies: ['Most replied', '最多回覆'],
    opt_sort_replies_asc: ['Least replied', '最少回覆'],
    opt_sort_reposts: ['Most reposted', '最多轉發'],
    opt_sort_reposts_asc: ['Least reposted', '最少轉發'],
    opt_sort_shares: ['Most shared', '最多分享'],
    opt_sort_shares_asc: ['Least shared', '最少分享'],
    title_grid: ['Grid', '格狀'],
    title_list: ['List', '列表'],
    title_compact: ['Compact', '精簡'],

    // ---- dashboard: content ----
    shown_posts: ['{n} posts', '{n} 篇貼文'],
    shown_of: ['of {n}', '（共 {n} 篇）'],
    shown_hidden_metric: [
      '· {n} hidden (no data for this metric — older capture, re-grab)',
      '· 隱藏 {n} 篇（此指標無資料 — 較舊的擷取，請重新擷取）',
    ],
    empty_no_match: ['Nothing matches the current filters.', '沒有符合目前篩選條件的貼文。'],
    empty_no_capture: [
      'Nothing captured yet.<br /><b>Grab</b> saved posts, feeds, or a profile from the extension popup — results show up here live.',
      '尚未擷取任何內容。<br />請從擴充功能視窗<b>擷取</b>儲存貼文、動態或個人檔案 — 結果會即時顯示在這裡。',
    ],
    more: ['more', '更多'],
    less: ['less', '收合'],
    open_post: ['open ↗', '開啟 ↗'],
    replying_to: ['↩ replying to ', '↩ 回覆 '],
    badge_saved: ['saved', '已儲存'],
    badge_liked: ['liked', '已按讚'],
    badge_thread: ['thread', '串文'],
    badge_reply: ['reply', '回覆'],
    title_filter_author: ['filter by this author', '以此作者篩選'],
    video_tile: ['video · open post', '影片 · 開啟貼文'],
    title_video_tile: ['video — open the post on Threads', '影片 — 在 Threads 開啟貼文'],
    media_expired: ['media expired', '媒體已過期'],
    live_idle: ['Threads Extractor', 'Threads Extractor'],
    live_feeds: ['grabbing feeds… ({p})', '擷取動態中…（{p}）'],
    live_profile: ['grabbing @{h} {stage}…', '正在擷取 @{h} 的{stage}…'],
    live_saved: ['grabbing saved posts…', '擷取儲存貼文中…'],
    live_liked: ['grabbing liked posts…', '擷取按讚貼文中…'],

    // ---- content script banner ----
    banner_running: ['Auto-grab running', '自動擷取進行中'],
    banner_saved: ['grabbing your saved posts', '正在擷取你的儲存貼文'],
    banner_liked: ['grabbing your liked posts', '正在擷取你按讚的貼文'],
    banner_feed: ['grabbing a feed', '正在擷取動態'],
    banner_profile: ['grabbing a profile', '正在擷取個人檔案'],
    banner_columns: ['grabbing feeds in parallel', '正在同時擷取多個動態'],
    banner_generic: ['grabbing', '擷取中'],
    banner_tail: [
      "{label} — don't use this tab, keep it visible · stop anytime from the extension popup",
      '{label} — 請勿操作此分頁並保持可見 · 隨時可從擴充功能視窗停止',
    ],
  };

  // Service-worker error strings are stored in English; translate at display
  // time so sw.js stays language-free.
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
  };
  const ERROR_PATTERNS = [
    [/^"(.+)" stalled — skipped$/, '「$1」停滯 — 已略過'],
    [/^couldn't open: (.+)$/, '無法開啟：$1'],
    [/^"(.+)" is not a valid handle\.$/, '「$1」不是有效的帳號。'],
    [/^profile (?:threads|replies) stalled — moved on$/, '個人檔案擷取停滯 — 已結束'],
  ];

  let lang = 'en';

  function resolve(pref) {
    if (pref === 'en' || pref === 'zh_TW') return pref;
    try {
      const ui = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || 'en';
      return /^zh/i.test(ui) ? 'zh_TW' : 'en';
    } catch (_) { return 'en'; }
  }

  async function init() {
    try {
      const got = await chrome.storage.local.get('tse_lang');
      lang = resolve(got.tse_lang || 'auto');
    } catch (_) { lang = 'en'; }
    return lang;
  }

  function t(key, subs) {
    const entry = DICT[key];
    let s = entry ? (lang === 'zh_TW' ? entry[1] : entry[0]) : key;
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

  async function setLang(pref) {
    try { await chrome.storage.local.set({ tse_lang: pref }); } catch (_) {}
    lang = resolve(pref);
  }

  const api = {
    init, t, apply, setLang, translateError,
    get lang() { return lang; },
  };
  if (typeof window !== 'undefined') window.TSEI18n = api;
  else self.TSEI18n = api;
})();
