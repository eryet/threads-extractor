// popup.js — start/stop the grab, show live count, export files.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    count: $('count'), status: $('status'),
    start: $('btnStart'), stop: $('btnStop'),
    json: $('btnJson'), csv: $('btnCsv'), md: $('btnMd'),
    clear: $('btnClear'),
  };

  let pollTimer = null;

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.classList.toggle('error', !!isError);
  }

  function render(state) {
    els.count.textContent = state.count;
    const hasPosts = state.count > 0;
    els.start.disabled = state.grabbing;
    els.stop.disabled = !state.grabbing;
    els.json.disabled = els.csv.disabled = els.md.disabled = els.clear.disabled = !hasPosts;

    if (state.lastError) {
      setStatus(state.lastError, true);
    } else if (state.grabbing) {
      setStatus('grabbing… scrolling the saved feed');
    } else if (state.hasNext === false && hasPosts) {
      setStatus('done — reached the end of the saved feed');
    } else {
      setStatus('posts captured');
    }
  }

  async function refresh() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (state) render(state);
    } catch (_) {}
  }

  els.start.addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ type: 'START' });
    if (r && !r.ok) setStatus(r.error || 'could not start', true);
    refresh();
  });

  els.stop.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP' });
    refresh();
  });

  els.clear.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR' });
    refresh();
  });

  async function getPosts() {
    const got = await chrome.storage.local.get('tse_posts');
    return Object.values(got.tse_posts || {});
  }

  function download(text, mime, ext) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download(
      { url, filename: `threads-saved-${stamp}.${ext}`, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 60000)
    );
  }

  els.json.addEventListener('click', async () =>
    download(TSEExport.toJSON(await getPosts()), 'application/json', 'json'));
  els.csv.addEventListener('click', async () =>
    download(TSEExport.toCSV(await getPosts()), 'text/csv', 'csv'));
  els.md.addEventListener('click', async () =>
    download(TSEExport.toMarkdown(await getPosts()), 'text/markdown', 'md'));

  refresh();
  pollTimer = setInterval(refresh, 800);
  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
