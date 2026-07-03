// export.js — normalized posts -> JSON / CSV / Markdown strings.
// Loaded by popup.html via <script>; exposes window.TSEExport.
(function () {
  'use strict';

  function sortPosts(posts) {
    // saved-feed order (savedOrder 1 = saved most recently); posts captured
    // before savedOrder existed fall back to newest-posted-first at the end
    return posts.slice().sort((a, b) => {
      const ao = a.savedOrder, bo = b.savedOrder;
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

  function toCSV(posts) {
    const header = ['savedOrder', 'id', 'url', 'handle', 'name', 'text', 'takenAt', 'savedAt', 'likeCount', 'media', 'capturedAt'];
    const rows = [header.join(',')];
    for (const p of sortPosts(posts)) {
      rows.push([
        csvCell(p.savedOrder),
        csvCell(p.id),
        csvCell(p.url),
        csvCell(p.author && p.author.handle),
        csvCell(p.author && p.author.name),
        csvCell(p.text),
        csvCell(p.takenAt),
        csvCell(p.savedAt),
        csvCell(p.likeCount),
        csvCell((p.media || []).join(' | ')),
        csvCell(p.capturedAt),
      ].join(','));
    }
    // BOM so Excel opens UTF-8 (CJK text) correctly
    return '\uFEFF' + rows.join('\r\n');
  }

  function toMarkdown(posts) {
    const sorted = sortPosts(posts);
    const out = [
      '# Threads saved posts',
      '',
      `${sorted.length} posts · exported ${new Date().toISOString().slice(0, 10)}`,
      '',
    ];
    for (const p of sorted) {
      const handle = (p.author && p.author.handle) || '@unknown';
      const name = (p.author && p.author.name) ? ` (${p.author.name})` : '';
      out.push(`## ${handle}${name}`);
      const meta = [];
      if (p.takenAt) meta.push(p.takenAt.slice(0, 10));
      if (p.url) meta.push(`[open post](${p.url})`);
      if (meta.length) out.push(meta.join(' · '));
      out.push('');
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
