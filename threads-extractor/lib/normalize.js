// normalize.js — raw Threads GraphQL post node -> clean normalized record.
// Loaded by sw.js via importScripts(); exposes self.TSENormalize.
//
// Raw field map (verified live, 2026-07-03):
//   pk ......................... numeric post id (string)
//   code ....................... shortcode -> https://www.threads.com/@{user}/post/{code}
//   caption.text ............... post body
//   user.username / full_name .. author
//   taken_at ................... unix seconds (posted time; saved time is NOT exposed)
//   image_versions2.candidates . images (largest first)
//   video_versions[0].url ...... video
//   carousel_media[] ........... multi-media posts, each with the two fields above
(function () {
  'use strict';

  function mediaUrlsOf(node) {
    const urls = [];
    const one = (m) => {
      if (!m) return;
      if (Array.isArray(m.video_versions) && m.video_versions[0] && m.video_versions[0].url) {
        urls.push(m.video_versions[0].url);
      } else if (
        m.image_versions2 &&
        Array.isArray(m.image_versions2.candidates) &&
        m.image_versions2.candidates[0] &&
        m.image_versions2.candidates[0].url
      ) {
        urls.push(m.image_versions2.candidates[0].url);
      }
    };
    if (Array.isArray(node.carousel_media) && node.carousel_media.length) {
      node.carousel_media.forEach(one);
    } else {
      one(node);
    }
    return urls;
  }

  function normalizePost(raw, capturedAt) {
    if (!raw) return null;
    const user = raw.user || {};
    const id = String(raw.pk || raw.id || '');
    if (!id) return null;
    const info = raw.text_post_app_info || {};
    const num = (v) => (typeof v === 'number' ? v : null);

    let url = raw.canonical_url || null;
    if (!url && user.username && raw.code) {
      url = 'https://www.threads.com/@' + user.username + '/post/' + raw.code;
    }

    return {
      id,
      url,
      author: {
        handle: user.username ? '@' + user.username : null,
        name: user.full_name || null,
      },
      text: (raw.caption && raw.caption.text) || '',
      media: mediaUrlsOf(raw),
      likeCount: num(raw.like_count),
      replyCount: num(info.direct_reply_count),
      repostCount: num(info.repost_count),
      quoteCount: num(info.quote_count),
      shareCount: num(info.reshare_count), // the UI's "Share" number
      takenAt: raw.taken_at ? new Date(raw.taken_at * 1000).toISOString() : null,
      savedAt: null, // Threads does not expose the saved timestamp
      capturedAt,
    };
  }

  self.TSENormalize = { normalizePost };
})();
