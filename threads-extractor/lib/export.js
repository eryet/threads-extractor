// export.js — normalized posts -> JSON / CSV / Markdown strings.
// Loaded by popup.html via <script>; exposes window.TSEExport.
(function () {
  'use strict';

  function sortPosts(posts) {
    // Group first (profile handle for profile grabs, feed for feed runs, or
    // section), then capture order within the group (savedOrder / feedOrder /
    // profileOrder; 1 = top). Posts captured before order fields existed fall
    // back to newest-posted-first at the end.
    const orderOf = (p) => (p.savedOrder != null ? p.savedOrder
      : p.likedOrder != null ? p.likedOrder
        : p.feedOrder != null ? p.feedOrder : p.profileOrder);
    const feedGroup = (p) => (p.feedIndex != null ? p.feedIndex : p.sectionIndex) || 0;
    return posts.slice().sort((a, b) => {
      // profile grabs: group by whose profile, then section (threads<replies)
      const ah = a.profileHandle || '', bh = b.profileHandle || '';
      if (ah !== bh) return ah < bh ? -1 : 1;
      const as = a.sectionIndex || 0, bs = b.sectionIndex || 0;
      if (ah && as !== bs) return as - bs;
      const af = feedGroup(a), bf = feedGroup(b);
      if (af !== bf) return af - bf;
      const ao = orderOf(a), bo = orderOf(b);
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      return String(b.takenAt || '').localeCompare(String(a.takenAt || ''));
    });
  }

  function toJSON(posts) {
    return JSON.stringify(sortPosts(posts), null, 2);
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCSV(posts, kind) {
    const feed = kind === 'feed';
    const profile = kind === 'profile';
    const liked = kind === 'liked';
    const ENGAGEMENT = ['likeCount', 'replyCount', 'repostCount', 'quoteCount', 'shareCount'];
    const header = profile
      ? ['profile', 'section', 'profileOrder', 'id', 'url', 'text', 'takenAt', ...ENGAGEMENT, 'replyToHandle', 'replyToUrl', 'replyToText', 'media', 'capturedAt']
      : feed
        ? ['feed', 'feedOrder', 'id', 'url', 'handle', 'name', 'text', 'takenAt', ...ENGAGEMENT, 'replyToHandle', 'replyToUrl', 'replyToText', 'media', 'capturedAt']
        : liked
          ? ['likedOrder', 'id', 'url', 'handle', 'name', 'text', 'takenAt', ...ENGAGEMENT, 'replyToHandle', 'replyToUrl', 'replyToText', 'media', 'capturedAt']
          : ['savedOrder', 'id', 'url', 'handle', 'name', 'text', 'takenAt', 'savedAt', ...ENGAGEMENT, 'replyToHandle', 'replyToUrl', 'replyToText', 'media', 'capturedAt'];
    const rows = [header.join(',')];
    for (const p of sortPosts(posts)) {
      const rt = p.replyTo || {};
      const engagement = ENGAGEMENT.map((k) => p[k]);
      let cells;
      if (profile) {
        cells = [p.profileHandle, p.section, p.profileOrder, p.id, p.url, p.text, p.takenAt, ...engagement,
          rt.author && rt.author.handle, rt.url, rt.text];
      } else {
        cells = feed ? [p.feed, p.feedOrder] : [liked ? p.likedOrder : p.savedOrder];
        cells.push(
          p.id, p.url,
          p.author && p.author.handle,
          p.author && p.author.name,
          p.text, p.takenAt
        );
        if (!feed && !liked) cells.push(p.savedAt);
        cells.push(...engagement, rt.author && rt.author.handle, rt.url, rt.text);
      }
      cells.push((p.media || []).join(' | '), p.capturedAt);
      rows.push(cells.map(csvCell).join(','));
    }
    // BOM so Excel opens UTF-8 (CJK text) correctly
    return '\uFEFF' + rows.join('\r\n');
  }

  function toMarkdown(posts, kind) {
    const feed = kind === 'feed';
    const profile = kind === 'profile';
    const grouped = feed || profile;
    const sorted = sortPosts(posts);
    const out = [
      profile ? '# Threads profile posts' : feed ? '# Threads feed posts'
        : kind === 'liked' ? '# Threads liked posts' : '# Threads saved posts',
      '',
      `${sorted.length} posts · exported ${new Date().toISOString().slice(0, 10)}`,
      '',
    ];
    let currentGroup = null;   // feed name / saved (n/a)
    let currentHandle = null;  // profile owner
    let currentSection = null; // profile section
    for (const p of sorted) {
      if (profile) {
        if (p.profileHandle !== currentHandle) {
          currentHandle = p.profileHandle;
          currentSection = null;
          const name = (p.author && p.author.name) ? ` (${p.author.name})` : '';
          out.push(`## ${currentHandle || '@unknown'}${name}`, '');
        }
        if (p.section !== currentSection) {
          currentSection = p.section;
          out.push(`### ${p.section === 'replies' ? 'Replies' : 'Threads'}`, '');
        }
      } else if (feed) {
        if (p.feed !== currentGroup) {
          currentGroup = p.feed;
          out.push(`## Feed: ${currentGroup || 'unknown'}`, '');
        }
      }
      if (!profile) {
        const handle = (p.author && p.author.handle) || '@unknown';
        const name = (p.author && p.author.name) ? ` (${p.author.name})` : '';
        out.push(`${grouped ? '###' : '##'} ${handle}${name}`);
      }
      const meta = [];
      if (p.takenAt) meta.push(p.takenAt.slice(0, 10));
      if (p.url) meta.push(`[open post](${p.url})`);
      if (profile) {
        out.push(`#### ${meta.join(' · ') || 'post'}`, '');
      } else if (meta.length) {
        out.push(meta.join(' · '), '');
      } else {
        out.push('');
      }
      if (p.replyTo) {
        // quote the full post this one replies to
        const rt = p.replyTo;
        const rtHandle = (rt.author && rt.author.handle) || '@unknown';
        const head = [`**replying to ${rt.url ? `[${rtHandle}](${rt.url})` : rtHandle}**`];
        if (rt.takenAt) head.push(rt.takenAt.slice(0, 10));
        out.push('> ' + head.join(' · '));
        for (const line of String(rt.text || '').split('\n')) out.push('> ' + line);
        if (rt.media && rt.media.length) {
          for (const m of rt.media) out.push(`> media: <${m}>`);
        }
        out.push('');
      }
      if (p.text) out.push(p.text, '');
      if (p.media && p.media.length) {
        for (const m of p.media) out.push(`- media: <${m}>`);
        out.push('');
      }
      out.push('---', '');
    }
    return out.join('\n');
  }

  window.TSEExport = { toJSON, toCSV, toMarkdown };
})();
