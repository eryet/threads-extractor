// daterange.js — self-contained date-range calendar popover (no deps, CSP-safe).
// Two months side by side, click start → click end, presets column, hover
// preview. Exposes window.TSEDateRange; styled by dashboard.html (.datePop *).
(function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayIso = () => iso(new Date());
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const parseMonth = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, 1);

  // opts: { button, label, clearBtn, pop, t, locale, onChange(from, to) }
  function init(opts) {
    const { button, label, clearBtn, pop, onChange } = opts;
    const t = opts.t || ((k) => k);
    const locale = opts.locale || 'en';

    const monthFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' });
    const wdFmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    // Sunday-first weekday header (2024-09-01 is a Sunday)
    const WEEKDAYS = Array.from({ length: 7 }, (_, i) => wdFmt.format(new Date(2024, 8, 1 + i)));

    const PRESETS = [
      ['preset_today', () => [todayIso(), todayIso()]],
      ['preset_7d', () => [daysAgo(6), todayIso()]],
      ['preset_30d', () => [daysAgo(29), todayIso()]],
      ['preset_90d', () => [daysAgo(89), todayIso()]],
      ['preset_this_month', () => {
        const d = new Date();
        return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), todayIso()];
      }],
      ['preset_this_year', () => [new Date().getFullYear() + '-01-01', todayIso()]],
      ['preset_all', () => ['', '']],
    ];

    let from = '', to = '';   // committed range ('YYYY-MM-DD' or '')
    let pendingStart = null;  // first click of a new range, not committed yet
    let view = addMonths(new Date(), -1); // left month; right month is view+1

    function paintLabel() {
      if (from && to) {
        label.textContent = from === to ? from : from + ' – ' + to;
        label.classList.remove('ph');
      } else {
        label.textContent = t('btn_date_range');
        label.classList.add('ph');
      }
      clearBtn.hidden = !from && !to;
    }

    function commit() {
      pendingStart = null;
      paintLabel();
      onChange(from, to);
    }

    function monthGrid(mDate) {
      const y = mDate.getFullYear(), m = mDate.getMonth();
      const days = new Date(y, m + 1, 0).getDate();
      const today = todayIso();
      let html = '<div class="dpGrid">';
      for (const w of WEEKDAYS) html += '<span class="dpWd">' + esc(w) + '</span>';
      for (let i = 0; i < new Date(y, m, 1).getDay(); i++) html += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const dIso = y + '-' + pad(m + 1) + '-' + pad(d);
        let cls = 'dpDay';
        if (dIso === today) cls += ' dpToday';
        if (dIso > today) cls += ' dpFuture';
        html += '<button class="' + cls + '" data-d="' + dIso + '">' + d + '</button>';
      }
      return html + '</div>';
    }

    function render() {
      const right = addMonths(view, 1);
      let html = '<div class="dpPresets">';
      PRESETS.forEach(([key], i) => {
        html += '<button data-preset="' + i + '">' + esc(t(key)) + '</button>';
      });
      html += '</div><div class="dpCal"><div class="dpHead">' +
        '<button class="dpArr" data-nav="-12" title="− 1y">«</button>' +
        '<button class="dpArr" data-nav="-1">‹</button>' +
        '<span class="dpTitles"><b>' + esc(monthFmt.format(view)) + '</b><b>' + esc(monthFmt.format(right)) + '</b></span>' +
        '<button class="dpArr" data-nav="1">›</button>' +
        '<button class="dpArr" data-nav="12" title="+ 1y">»</button>' +
        '</div><div class="dpMonths">' + monthGrid(view) + monthGrid(right) +
        '</div><div class="dpFoot"><span class="dpHint">' +
        esc(t(pendingStart ? 'cal_hint_end' : 'cal_hint_start')) + '</span></div></div>';
      pop.innerHTML = html;
      paintRange();
    }

    // selection / hover-preview highlighting, applied over the rendered grid
    function paintRange(hoverDay) {
      let a, b;
      if (pendingStart) {
        a = pendingStart;
        b = hoverDay || pendingStart;
        if (b < a) { const tmp = a; a = b; b = tmp; }
      } else { a = from; b = to; }
      for (const el of pop.querySelectorAll('.dpDay')) {
        const d = el.dataset.d;
        el.classList.toggle('dpSel', !!a && (d === a || d === b));
        el.classList.toggle('dpInR', !!a && !!b && d > a && d < b);
      }
    }

    function open() {
      // right month shows the range end (or today); left is the month before
      const base = to || from || todayIso();
      view = addMonths(parseMonth(base), -1);
      pendingStart = null;
      render();
      pop.hidden = false;
      // flip to right-aligned if the popover would run off the viewport
      pop.style.left = '0';
      pop.style.right = 'auto';
      const r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 12) { pop.style.left = 'auto'; pop.style.right = '0'; }
    }

    function close() { pop.hidden = true; pendingStart = null; }

    button.addEventListener('click', () => (pop.hidden ? open() : close()));

    clearBtn.addEventListener('click', () => {
      from = ''; to = '';
      commit();
      close();
    });

    pop.addEventListener('click', (e) => {
      const day = e.target.closest('.dpDay');
      if (day) {
        if (!pendingStart) {
          pendingStart = day.dataset.d;
          pop.querySelector('.dpHint').textContent = t('cal_hint_end');
          paintRange();
        } else {
          from = pendingStart < day.dataset.d ? pendingStart : day.dataset.d;
          to = pendingStart < day.dataset.d ? day.dataset.d : pendingStart;
          commit();
          close();
        }
        return;
      }
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        view = addMonths(view, +nav.dataset.nav);
        render();
        return;
      }
      const preset = e.target.closest('[data-preset]');
      if (preset) {
        [from, to] = PRESETS[+preset.dataset.preset][1]();
        commit();
        close();
      }
    });

    pop.addEventListener('mouseover', (e) => {
      if (!pendingStart) return;
      const day = e.target.closest('.dpDay');
      if (day) paintRange(day.dataset.d);
    });

    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) close();
    });

    paintLabel(); // empty-state label, without firing onChange during boot
    return { get: () => ({ from, to }) };
  }

  window.TSEDateRange = { init };
})();
