/**
 * Event Log tab.
 *
 * Messages from the server (forwarded by app.js):
 *   events          { categories, severities, types, notObservable, events[] }  (on connect)
 *   event           one new event
 *   events_cleared  the list was cleared
 *
 * Filtering: buttons in a row are combined with OR (show any checked type);
 * the type row and severity row are combined with AND. Nothing checked in a
 * row means that row doesn't filter.
 */
(function () {
  'use strict';

  const MAX_EVENTS = 20000;
  const MAX_ROWS = 1000;
  const FILTER_KEY = 'dmb.eventFilters.v1';
  const SEVERITY_LABELS = { error: 'Error', warning: 'Warning', info: 'Info' };

  const $ = (id) => document.getElementById(id);
  const els = {
    view: $('eventLogView'),
    categoryChips: $('eventCategoryChips'),
    severityChips: $('eventSeverityChips'),
    search: $('eventSearch'),
    showAll: $('btnEventShowAll'),
    exportCsv: $('btnEventExport'),
    clear: $('btnEventClear'),
    summary: $('eventSummary'),
    rows: $('eventRows'),
    empty: $('eventEmpty'),
    coverage: $('eventCoverage'),
    badge: $('tabLogBadge')
  };

  const state = {
    meta: { categories: [], severities: ['error', 'warning', 'info'], types: {}, notObservable: [] },
    events: [],
    categories: new Set(),
    severities: new Set(),
    search: '',
    visible: false,
    unseenErrors: 0,
    lastRenderedId: 0,
    renderQueued: false
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function pad(n, width = 2) {
    return String(n).padStart(width, '0');
  }

  function formatTime(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  function loadFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
      state.categories = new Set(saved.categories || []);
      state.severities = new Set(saved.severities || []);
    } catch {
      // storage unavailable; start unfiltered
    }
  }

  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ categories: [...state.categories], severities: [...state.severities] }));
    } catch {
      // ignore
    }
  }

  function matches(e) {
    if (state.categories.size && !state.categories.has(e.category)) return false;
    if (state.severities.size && !state.severities.has(e.severity)) return false;
    if (state.search) {
      const hay = `${e.title} ${e.device || ''} ${e.ip || ''} ${e.message}`.toLowerCase();
      if (!hay.includes(state.search)) return false;
    }
    return true;
  }

  function filtered() {
    return state.events.filter(matches);
  }

  function buildChips() {
    const chip = (group, id, label, extraClass) => {
      const btn = el('button', `event-chip ${extraClass || ''}`.trim());
      btn.type = 'button';
      btn.dataset.id = id;
      btn.append(el('span', 'event-chip-label', label), el('span', 'event-chip-count', '0'));
      btn.addEventListener('click', () => {
        const set = group === 'category' ? state.categories : state.severities;
        if (set.has(id)) set.delete(id);
        else set.add(id);
        saveFilters();
        render();
      });
      return btn;
    };

    els.categoryChips.textContent = '';
    for (const c of state.meta.categories) els.categoryChips.appendChild(chip('category', c.id, c.label, `cat-${c.id}`));
    els.severityChips.textContent = '';
    for (const s of state.meta.severities) els.severityChips.appendChild(chip('severity', s, SEVERITY_LABELS[s] || s, `sev-${s}`));
  }

  /** The number on a chip counts log entries, never devices: say so. */
  function setCount(btn, n) {
    btn.lastChild.textContent = n;
    btn.title = `${n.toLocaleString()} ${btn.firstChild.textContent} event${n === 1 ? '' : 's'} in the log. Click to filter.`;
  }

  function updateChips() {
    const catCounts = {};
    const sevCounts = {};
    for (const e of state.events) {
      catCounts[e.category] = (catCounts[e.category] || 0) + 1;
      sevCounts[e.severity] = (sevCounts[e.severity] || 0) + 1;
    }
    for (const btn of els.categoryChips.children) {
      const on = state.categories.has(btn.dataset.id);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      setCount(btn, catCounts[btn.dataset.id] || 0);
    }
    for (const btn of els.severityChips.children) {
      const on = state.severities.has(btn.dataset.id);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      setCount(btn, sevCounts[btn.dataset.id] || 0);
    }
    els.showAll.disabled = !state.categories.size && !state.severities.size && !state.search;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function row(e, isNew) {
    const tr = el('tr', `event-row sev-${e.severity}${isNew ? ' event-new' : ''}`);
    tr.appendChild(el('td', 'event-time', formatTime(e.time)));
    const sev = el('td', 'event-sev');
    sev.appendChild(el('span', `event-sev-badge sev-${e.severity}`, SEVERITY_LABELS[e.severity] || e.severity));
    tr.appendChild(sev);
    const title = el('td', 'event-title', e.title);
    const controllerName = state.meta.types[e.type] && state.meta.types[e.type].controller;
    if (controllerName) title.title = `Dante Controller event: ${controllerName}`;
    tr.appendChild(title);
    const device = el('td', 'event-device');
    if (e.device) device.appendChild(el('span', 'event-device-name', e.device));
    if (e.ip && e.ip !== e.device) device.appendChild(el('span', 'event-device-ip', e.ip));
    tr.appendChild(device);
    tr.appendChild(el('td', 'event-message', e.message));
    return tr;
  }

  function render() {
    state.renderQueued = false;
    updateChips();
    if (!state.visible) return;

    const list = filtered();
    const shown = list.slice(-MAX_ROWS).reverse();
    const frag = document.createDocumentFragment();
    for (const e of shown) frag.appendChild(row(e, state.lastRenderedId && e.id > state.lastRenderedId));
    els.rows.textContent = '';
    els.rows.appendChild(frag);
    state.lastRenderedId = state.events.length ? state.events[state.events.length - 1].id : 0;

    els.empty.hidden = list.length > 0;
    els.empty.textContent = state.events.length ? 'No events match the selected filters.' : 'No events yet. Device changes will appear here as they happen.';

    const filters = [
      ...state.meta.categories.filter((c) => state.categories.has(c.id)).map((c) => c.label),
      ...[...state.severities].map((s) => SEVERITY_LABELS[s] || s)
    ];
    let text = filters.length || state.search
      ? `Showing ${list.length.toLocaleString()} of ${state.events.length.toLocaleString()} events`
      : `Showing all ${state.events.length.toLocaleString()} events`;
    if (filters.length) text += ` (${filters.join(', ')})`;
    if (list.length > MAX_ROWS) text += `. Newest ${MAX_ROWS.toLocaleString()} listed; export to see all.`;
    els.summary.textContent = text;
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  function updateBadge() {
    els.badge.hidden = state.unseenErrors === 0;
    els.badge.textContent = state.unseenErrors > 99 ? '99+' : String(state.unseenErrors);
  }

  function renderCoverage() {
    const covered = new Set();
    for (const t of Object.values(state.meta.types)) if (t.controller) covered.add(t.controller);
    els.coverage.textContent = '';
    els.coverage.append(
      el('p', null, 'Logged from Dante Controller’s event list:'),
      list([...covered]),
      el('p', null, 'Also logged (not in Dante Controller’s log): device online / offline, multiple clock leaders, other subscription errors, routing changes, secondary link down / up, late packets, renames and sample rate changes.'),
      el('p', null, 'Not visible on the network, so not logged:'),
      list(state.meta.notObservable)
    );
    function list(items) {
      const ul = el('ul');
      for (const item of items) ul.appendChild(el('li', null, item));
      return ul;
    }
  }

  // ---------------------------------------------------------------------------
  // Server messages and controls
  // ---------------------------------------------------------------------------

  function receive(msg) {
    switch (msg.type) {
      case 'events': {
        const firstLoad = !state.meta.categories.length;
        state.meta = msg.data;
        state.events = msg.data.events || [];
        state.lastRenderedId = state.events.length ? state.events[state.events.length - 1].id : 0;
        if (firstLoad) {
          buildChips();
          renderCoverage();
        }
        queueRender();
        break;
      }
      case 'event':
        state.events.push(msg.data);
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        if (!state.visible && msg.data.severity === 'error') {
          state.unseenErrors++;
          updateBadge();
        }
        queueRender();
        break;
      case 'events_cleared':
        state.events = [];
        state.lastRenderedId = 0;
        state.unseenErrors = 0;
        updateBadge();
        queueRender();
        break;
    }
  }

  function setVisible(visible) {
    state.visible = visible;
    els.view.hidden = !visible;
    if (visible) {
      state.unseenErrors = 0;
      updateBadge();
      state.lastRenderedId = 0; // don't flash everything on open
      render();
    }
  }

  function csvField(value) {
    const s = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const header = ['Time', 'Severity', 'Category', 'Event', 'Device', 'IP', 'Message'];
    const catLabel = Object.fromEntries(state.meta.categories.map((c) => [c.id, c.label]));
    const lines = [header.join(',')];
    for (const e of filtered()) {
      lines.push([formatTime(e.time), e.severity, catLabel[e.category] || e.category, e.title, e.device, e.ip, e.message].map(csvField).join(','));
    }
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    const now = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `dante-events-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  els.search.addEventListener('input', () => {
    state.search = els.search.value.trim().toLowerCase();
    queueRender();
  });
  els.showAll.addEventListener('click', () => {
    state.categories.clear();
    state.severities.clear();
    state.search = '';
    els.search.value = '';
    saveFilters();
    render();
  });
  els.exportCsv.addEventListener('click', exportCsv);
  els.clear.addEventListener('click', () => {
    const ok = window.confirm('Clear the event list for everyone viewing this bridge?\n\nSaved log files on the bridge computer are kept.');
    if (ok) fetch('/api/events/clear', { method: 'POST' }).catch(() => {});
  });

  loadFilters();
  window.DanteEventLog = { receive, setVisible };
})();
