/**
 * Dante Audio Meter Bridge — browser UI.
 *
 * Server messages (WebSocket /ws):
 *   hello   { version, boundIp, name, interfaces[] }
 *   devices [ device structure … ]            (sent when anything changes)
 *   meters  { t, d: { ip: { tx:[byte|null], rx:[byte|null], mirrored? } } }  (20 Hz)
 *   custom_layout { devices: [{ name, tx:[ch], rx:[ch] }] }  (the Custom tab, shared by all screens)
 */
(function () {
  'use strict';

  const { byteToDbfs, dbfsToNormalized, isClipByte } = window.DanteLevels;

  const CLIP_LATCH_MS = 1500;
  const PEAK_HOLD_MS = 1000;
  const PEAK_DECAY_PER_SEC = 0.5; // normalized meter height per second
  const BANK_SIZE = 16;
  const SEGMENTS = 36;
  const SCALE_MARKS = [0, -6, -12, -18, -24, -36, -48, -60];
  const COLLAPSED_KEY = 'dmb.collapsed.v2';

  const COLORS = {
    track: '#0a0c10',
    off: '#161922',
    offEdge: '#11131a',
    red: '#ff1744',
    amber: '#ff9100',
    yellow: '#ffd600',
    green: '#00e676',
    holdRed: '#ff5252',
    holdAmber: '#ffb74d',
    holdYellow: '#fff59d',
    holdGreen: '#b9f6ca'
  };

  const state = {
    direction: 'tx',
    view: 'meters', // 'meters' | 'custom' | 'log'
    customLayout: { devices: [] },
    selection: new Set(), // strip keys `${ip}|${dir}|${ch}` selected for the context menu
    selectionAnchor: null, // last clicked strip, for Shift-click ranges
    devices: new Map(), // ip -> device structure
    meters: {}, // ip -> { tx, rx, mirrored }
    collapsed: loadCollapsed(), // device name -> bool
    banks: {}, // ip -> bank number | 'all'
    search: '',
    activeIp: null,
    interfaces: [],
    holds: new Map(), // key -> { norm, at }
    clipUntil: new Map(), // key -> timestamp
    highlightTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    nicSelect: $('nicSelect'),
    tabTx: $('tabTx'),
    tabRx: $('tabRx'),
    tabLog: $('tabLog'),
    tabCustom: $('tabCustom'),
    tabCustomCount: $('tabCustomCount'),
    customContainer: $('customContainer'),
    customEmpty: $('customEmpty'),
    customEmptyText: $('customEmptyText'),
    clearCustom: $('btnClearCustom'),
    menu: $('channelMenu'),
    toast: $('toast'),
    search: $('searchInput'),
    toggleAll: $('btnToggleAll'),
    toggleAllText: $('toggleAllText'),
    resetPeaks: $('btnResetPeaks'),
    refresh: $('btnRefresh'),
    fullscreen: $('btnFullscreen'),
    container: $('devicesContainer'),
    devicesContainer: $('devicesContainer'),
    empty: $('emptyState'),
    emptyText: $('emptyStateText'),
    statDevices: $('statDeviceCount'),
    statTab: $('statActiveTab'),
    statChannels: $('statChannelCount'),
    statClips: $('statClipCount'),
    modulesSummary: $('modulesSummary'),
    version: $('appVersion')
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function loadCollapsed() {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state.collapsed));
    } catch {
      // storage unavailable (private mode); layout just won't persist
    }
  }

  function isCollapsed(dev) {
    return state.collapsed[dev.name] === true;
  }

  // Custom-tab cards collapse independently of the same device's normal card.
  const customCollapseKey = (name) => `custom:${name}`;

  function formatSampleRate(sr) {
    if (!sr) return '— kHz';
    return `${(sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1)} kHz`;
  }

  function formatDbfs(dbfs, clip, hasData) {
    if (!hasData) return '—';
    if (clip) return 'CLIP';
    if (!isFinite(dbfs) || dbfs <= -60) return '-∞ dB';
    return `${dbfs.toFixed(1)} dB`;
  }

  function sortedDevices() {
    return [...state.devices.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
  }

  function matchesSearch(dev) {
    const q = state.search;
    if (!q) return true;
    const fields = [dev.name, dev.ip, dev.manufacturer, dev.modelName];
    const channels = dev[state.direction] && dev[state.direction].channels;
    if (channels) {
      for (const ch of Object.values(channels)) fields.push(ch.name, ch.subscribedDevice, ch.subscribedChannel);
    }
    return fields.some((f) => f && String(f).toLowerCase().includes(q));
  }

  function findDeviceByName(name) {
    if (!name) return null;
    const wanted = name.trim().toLowerCase();
    for (const dev of state.devices.values()) {
      if (dev.name.toLowerCase() === wanted || dev.ip === name) return dev;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  let ws = null;
  let reconnectDelay = 1000;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      setStatus('live', 'Live');
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };
    ws.onclose = () => {
      setStatus('warning', 'Disconnected — reconnecting…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function setStatus(kind, text) {
    els.statusDot.className = `status-dot ${kind}`;
    els.statusText.textContent = text;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello':
        state.activeIp = msg.data.boundIp;
        state.interfaces = msg.data.interfaces || [];
        if (els.version) els.version.textContent = `v${msg.data.version}`;
        populateNicSelect();
        if (ws && ws.readyState === WebSocket.OPEN) setStatus('live', 'Live');
        break;
      case 'devices':
        state.devices = new Map(msg.data.map((d) => [d.ip, d]));
        if (state.view === 'custom') renderCustom();
        else renderDevices();
        break;
      case 'custom_layout':
        state.customLayout = msg.data && Array.isArray(msg.data.devices) ? msg.data : { devices: [] };
        onCustomLayoutChanged();
        break;
      case 'custom_layout_error':
        showToast(`Custom view not saved: ${msg.data && msg.data.message}`);
        break;
      case 'meters':
        state.meters = msg.d || {};
        break;
      case 'health':
        renderHealth(msg.data);
        break;
      case 'events':
      case 'event':
      case 'events_cleared':
        window.DanteEventLog.receive(msg);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Header controls
  // ---------------------------------------------------------------------------

  function renderHealth(health) {
    const banner = $('healthBanner');
    const problems = [];
    if (health.multicastBlocked) problems.push('no Dante heartbeats (sync and secondary-network status)');
    if (health.meteringBlocked) problems.push('no meter streams');
    banner.hidden = problems.length === 0;
    if (!problems.length) return;
    const fix =
      health.platform === 'win32'
        ? 'Allow Node.js through Windows Defender Firewall on Public networks; Windows usually treats a Dante network as an "Unidentified network".'
        : 'Check that a firewall allows incoming UDP for Node.js on the Dante interface.';
    banner.textContent = `Devices are answering, but this computer is receiving ${problems.join(' or ')}. ${fix}`;
  }

  function populateNicSelect() {
    const select = els.nicSelect;
    select.textContent = '';
    const all = el('option', null, 'All Interfaces (Wildcard)');
    all.value = 'all';
    select.appendChild(all);

    for (const nic of state.interfaces) {
      const opt = el('option', null, `${nic.name} - ${nic.address}${nic.isDanteLinkLocal ? ' [Dante]' : ''}`);
      opt.value = nic.address;
      select.appendChild(opt);
    }
    select.value = state.activeIp && state.interfaces.some((i) => i.address === state.activeIp) ? state.activeIp : 'all';
  }

  els.nicSelect.addEventListener('change', () => {
    setStatus('warning', 'Switching interface…');
    const ip = els.nicSelect.value;
    if (!send({ type: 'select_interface', ip })) {
      fetch('/api/interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      }).catch(() => {});
    }
  });

  els.tabTx.addEventListener('click', () => setDirection('tx'));
  els.tabRx.addEventListener('click', () => setDirection('rx'));
  els.tabLog.addEventListener('click', () => setView('log'));
  els.tabCustom.addEventListener('click', () => setView('custom'));

  function updateTabs() {
    const active = state.view === 'meters' ? state.direction : state.view;
    for (const [tab, id] of [[els.tabTx, 'tx'], [els.tabRx, 'rx'], [els.tabCustom, 'custom'], [els.tabLog, 'log']]) {
      tab.classList.toggle('active', active === id);
      tab.setAttribute('aria-selected', String(active === id));
    }
    els.statTab.textContent = { tx: 'TRANSMITTER', rx: 'RECEIVER', custom: 'CUSTOM', log: 'EVENT LOG' }[active];
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    closeMenu();
    clearSelection();
    document.body.classList.toggle('view-log', view === 'log');
    document.body.classList.toggle('view-custom', view === 'custom');
    els.devicesContainer.hidden = view !== 'meters';
    els.customContainer.hidden = view !== 'custom';
    els.clearCustom.hidden = view !== 'custom';
    window.DanteEventLog.setVisible(view === 'log');
    updateTabs();
    if (view === 'meters') renderDevices();
    if (view === 'custom') renderCustom();
  }

  function setDirection(dir) {
    const changed = state.direction !== dir;
    state.direction = dir;
    if (state.view !== 'meters') setView('meters');
    else if (changed) renderDevices();
    updateTabs();
  }

  els.search.addEventListener('input', () => {
    state.search = els.search.value.trim().toLowerCase();
    if (state.view === 'custom') renderCustom();
    else renderDevices();
  });

  els.toggleAll.addEventListener('click', () => {
    if (state.view === 'custom') {
      const keys = state.customLayout.devices.map((d) => customCollapseKey(d.name));
      if (!keys.length) return;
      const collapse = keys.some((k) => state.collapsed[k] !== true);
      for (const k of keys) state.collapsed[k] = collapse;
      saveCollapsed();
      renderCustom();
      return;
    }
    const devs = [...state.devices.values()];
    if (!devs.length) return;
    const collapse = devs.some((d) => !isCollapsed(d));
    for (const d of devs) state.collapsed[d.name] = collapse;
    saveCollapsed();
    renderDevices();
  });

  els.clearCustom.addEventListener('click', () => {
    const count = customChannelCount();
    if (!count) return;
    if (!window.confirm(`Remove all ${count} channels from the Custom view? This affects every screen showing this bridge.`)) return;
    setCustomLayout({ devices: [] });
    showToast('Custom view cleared');
  });

  els.resetPeaks.addEventListener('click', () => {
    state.holds.clear();
    state.clipUntil.clear();
  });

  els.refresh.addEventListener('click', () => {
    els.refresh.disabled = true;
    const done = () => setTimeout(() => (els.refresh.disabled = false), 800);
    if (send({ type: 'refresh' })) {
      done();
    } else {
      fetch('/api/refresh', { method: 'POST' }).catch(() => {}).finally(done);
    }
  });

  els.fullscreen.addEventListener('click', () => {
    const doc = document;
    const root = doc.documentElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    } else {
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (request) Promise.resolve(request.call(root)).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------------
  // Device cards (structure — rebuilt only when the server says it changed)
  // ---------------------------------------------------------------------------

  const cards = new Map(); // ip -> card view

  function renderDevices() {
    const visible = sortedDevices().filter(matchesSearch);
    const visibleIps = new Set(visible.map((d) => d.ip));

    for (const [ip, view] of cards) {
      if (!visibleIps.has(ip)) {
        view.root.remove();
        cards.delete(ip);
      }
    }

    els.empty.hidden = visible.length > 0;
    if (!visible.length) {
      els.emptyText.textContent = state.devices.size
        ? 'No devices match your filter.'
        : 'Discovering Dante devices on the network…';
    }

    let previous = els.empty;
    for (const dev of visible) {
      let view = cards.get(dev.ip);
      if (!view) {
        view = createCard(dev.ip);
        cards.set(dev.ip, view);
      }
      updateCard(view, dev);
      if (previous.nextSibling !== view.root) previous.after(view.root);
      previous = view.root;
    }
    updateStats();
  }

  /**
   * A device card. Normal cards are keyed by IP; Custom-tab cards pass
   * `collapseKey` (keyed by device name, since the device may be offline).
   */
  function createCard(ip, { collapseKey = null } = {}) {
    const root = el('section', 'device-card');
    root.dataset.ip = ip || '';

    const header = el('div', 'device-header');
    const left = el('div', 'device-header-left');
    const collapseBtn = el('button', 'collapse-icon-btn');
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-label', 'Collapse or expand meters');
    collapseBtn.innerHTML =
      '<svg class="chevron-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';

    const dots = el('div', 'sync-dots-group');
    dots.title = 'Network sync: left = primary, right = secondary';
    const primaryDot = el('span', 'sync-dot none');
    const secondaryDot = el('span', 'sync-dot none');
    dots.append(primaryDot, secondaryDot);

    const name = el('span', 'device-name');
    const ipBadge = el('span', 'device-badge device-ip-badge');
    const srBadge = el('span', 'device-badge sr');
    const chBadge = el('span', 'device-badge channels');
    const offlineBadge = el('span', 'device-badge offline', 'OFFLINE');
    const leaderBadge = el('span', 'device-badge leader', '★ CLOCK LEADER');
    leaderBadge.title = 'Dante clock leader (PTP grandmaster)';
    left.append(collapseBtn, dots, name, ipBadge, srBadge, chBadge, offlineBadge, leaderBadge);

    const right = el('div', 'device-header-right');
    const identity = el('div', 'device-identity-container');
    const mini = el('div', 'mini-activity-preview');
    mini.title = 'Signal activity';
    const miniBars = [];
    for (let i = 0; i < 4; i++) miniBars.push(mini.appendChild(el('span', 'mini-bar')));
    right.append(identity, mini);
    header.append(left, right);

    const body = el('div', 'device-body');
    const bankBar = el('div', 'bank-selector-container');
    const grid = el('div', 'meters-grid-16');
    body.append(bankBar, grid);
    root.append(header, body);

    const view = {
      ip,
      root,
      name,
      ipBadge,
      srBadge,
      chBadge,
      offlineBadge,
      leaderBadge,
      primaryDot,
      secondaryDot,
      identity,
      identityKey: '',
      miniBars,
      bankBar,
      bankKey: '',
      grid,
      gridKey: '',
      strips: []
    };

    const toggle = (e) => {
      e.stopPropagation();
      let key = collapseKey;
      if (!key) {
        const dev = state.devices.get(ip);
        if (!dev) return;
        key = dev.name;
      }
      state.collapsed[key] = state.collapsed[key] !== true;
      saveCollapsed();
      root.classList.toggle('collapsed', state.collapsed[key] === true);
      updateStats();
    };
    collapseBtn.addEventListener('click', toggle);
    header.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      if (e.target.closest('a, input, select, .bank-btn, .card-action')) return;
      toggle(e);
    });
    view.header = header;
    view.headerRight = right;
    view.body = body;
    return view;
  }

  const SYNC_TITLES = {
    good: 'locked',
    syncing: 'syncing',
    error: 'error / no sync',
    unsupported: 'not supported by this device',
    none: 'no status reported'
  };

  function updateCard(view, dev) {
    const dir = state.direction;
    const block = dev[dir] || { count: 0, channels: {} };
    const count = block.count || 0;

    view.root.classList.toggle('collapsed', isCollapsed(dev));
    updateCardHeader(view, dev);
    view.chBadge.textContent = `${count} ${dir.toUpperCase()} Ch`;
    updateBanks(view, dev, count);
    updateStrips(view, dev, block);
  }

  /** Name, badges, sync dots and identity: shared by normal and Custom cards. */
  function updateCardHeader(view, dev) {
    view.root.classList.toggle('offline', !dev.online);
    view.root.classList.toggle('clock-leader', Boolean(dev.isClockLeader));
    view.offlineBadge.hidden = dev.online;
    view.leaderBadge.hidden = !dev.isClockLeader;

    view.name.textContent = dev.name;
    const secondary = dev.secondaryIp || (dev.secondaryLinkUp === false ? 'link down' : null);
    view.ipBadge.textContent = secondary ? `${dev.ip} / ${secondary}` : dev.ip;
    view.ipBadge.title = `Primary: ${dev.ip}${dev.secondarySupported ? ` | Secondary: ${secondary || 'unknown'}` : ''}`;
    view.srBadge.textContent = formatSampleRate(dev.sampleRate);

    view.primaryDot.className = `sync-dot ${dev.primarySync}`;
    view.primaryDot.title = `Primary network: ${SYNC_TITLES[dev.primarySync] || dev.primarySync}`;
    view.secondaryDot.className = `sync-dot ${dev.secondarySync}`;
    view.secondaryDot.title = `Secondary network: ${SYNC_TITLES[dev.secondarySync] || dev.secondarySync}`;

    updateIdentity(view, dev);
  }

  function updateIdentity(view, dev) {
    const key = [dev.manufacturer, dev.modelName, dev.productVersion, dev.softwareVersion, dev.firmwareVersion].join('|');
    if (key === view.identityKey) return;
    view.identityKey = key;
    view.identity.textContent = '';

    if (dev.manufacturer || dev.modelName) {
      const primary = el('div', 'device-id-primary');
      if (dev.manufacturer) primary.appendChild(el('span', 'device-manufacturer', dev.manufacturer));
      if (dev.manufacturer && dev.modelName) primary.appendChild(el('span', 'device-id-sep', '•'));
      if (dev.modelName) primary.appendChild(el('span', 'device-model', dev.modelName));
      view.identity.appendChild(primary);
    }

    const versions = [
      ['prod', 'Prod:', dev.productVersion, 'Product version'],
      ['sw', 'Soft:', dev.softwareVersion, 'Software version'],
      ['fw', 'Firm:', dev.firmwareVersion, 'Firmware version']
    ].filter((v) => v[2]);
    if (versions.length) {
      const row = el('div', 'device-id-versions');
      for (const [cls, label, value, title] of versions) {
        const tag = el('span', `ver-tag ${cls}`);
        tag.title = `${title}: ${value}`;
        tag.append(el('span', 'ver-label', label), ' ', el('span', 'ver-val', value));
        row.appendChild(tag);
      }
      view.identity.appendChild(row);
    }
  }

  function currentRange(ip, count) {
    if (count <= BANK_SIZE) return { start: 1, end: count, bank: 'all' };
    const banks = Math.ceil(count / BANK_SIZE);
    let bank = state.banks[ip];
    if (bank !== 'all' && !(bank >= 1 && bank <= banks)) bank = state.banks[ip] = 1;
    if (bank === 'all') return { start: 1, end: count, bank };
    return { start: (bank - 1) * BANK_SIZE + 1, end: Math.min(count, bank * BANK_SIZE), bank };
  }

  function updateBanks(view, dev, count) {
    const { bank } = currentRange(dev.ip, count);
    const key = `${count}|${bank}`;
    if (key === view.bankKey) return;
    view.bankKey = key;
    view.bankBar.textContent = '';
    if (count <= BANK_SIZE) return;

    const bar = el('div', 'bank-selector-bar');
    bar.appendChild(el('span', 'bank-label', 'Banks (16-ch):'));
    const addButton = (value, label) => {
      const btn = el('button', `bank-btn${bank === value ? ' active' : ''}`, label);
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.banks[dev.ip] = value;
        const current = state.devices.get(dev.ip);
        if (current) updateCard(view, current);
      });
      bar.appendChild(btn);
    };
    for (let b = 1; b <= Math.ceil(count / BANK_SIZE); b++) {
      addButton(b, `Ch ${(b - 1) * BANK_SIZE + 1}–${Math.min(count, b * BANK_SIZE)}`);
    }
    addButton('all', `All (${count} Ch)`);
    view.bankBar.appendChild(bar);
  }

  /**
   * Up to 8 strips get fixed-width columns instead of stretching 16-across.
   * Column counts live in CSS (style.css) so narrow screens can wrap rows.
   */
  function setGridColumns(grid, count) {
    const compact = count > 0 && count <= 8;
    grid.classList.toggle('compact', compact);
    grid.style.setProperty('--compact-count', String(count));
    grid.style.setProperty('--compact-count-narrow', String(Math.min(count, 4)));
  }

  function updateStrips(view, dev, block) {
    const dir = state.direction;
    const { start, end } = currentRange(dev.ip, block.count || 0);
    const gridKey = `${dir}|${start}|${end}`;

    if (gridKey !== view.gridKey) {
      view.gridKey = gridKey;
      view.grid.textContent = '';
      view.strips = [];
      const visible = end >= start ? end - start + 1 : 0;
      setGridColumns(view.grid, visible);

      if (!visible) {
        view.grid.appendChild(el('div', 'no-channels-notice', `No ${dir.toUpperCase()} channels on this device`));
        return;
      }
      for (let ch = start; ch <= end; ch++) {
        const strip = createStrip(dev.ip, dir, ch);
        view.strips.push(strip);
        view.grid.appendChild(strip.root);
      }
    }

    for (const strip of view.strips) updateStripLabels(strip, dev, block.channels[strip.ch]);
  }

  function createStrip(ip, dir, ch, context = 'meters') {
    const root = el('div', 'meter-strip');
    root.dataset.ch = ch;
    root.dataset.dir = dir;

    const header = el('div', 'strip-header');
    header.append(el('div', 'ch-number', String(ch).padStart(2, '0')));
    const name = header.appendChild(el('div', 'ch-name'));
    root.appendChild(header);

    let rxBox = null;
    if (dir === 'rx') {
      rxBox = el('button', 'rx-source-box empty');
      rxBox.type = 'button';
      rxBox.append(el('span', 'rx-source-dev'), el('span', 'rx-source-chan'));
      rxBox.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rxBox.dataset.dev) navigateToTransmitter(rxBox.dataset.dev, rxBox.dataset.chan);
      });
      root.appendChild(rxBox);
    }

    const clipLed = root.appendChild(el('div', 'clip-led'));
    clipLed.title = 'Clip indicator';

    const bar = el('div', 'meter-bar-container');
    const canvas = bar.appendChild(el('canvas', 'meter-canvas'));
    const scale = bar.appendChild(el('div', 'meter-scale'));
    for (const mark of SCALE_MARKS) {
      const tick = scale.appendChild(el('span', null, String(mark)));
      tick.style.bottom = `${dbfsToNormalized(mark) * 100}%`;
    }
    root.appendChild(bar);
    const readout = root.appendChild(el('div', 'numeric-readout', '—'));

    const strip = { ip, dir, ch, context, root, name, rxBox, clipLed, canvas, ctx: canvas.getContext('2d'), readout, drawn: '' };
    attachStripInteractions(strip);
    return strip;
  }

  function updateStripLabels(strip, dev, chan) {
    const label = (chan && chan.name) || `${strip.dir.toUpperCase()} ${strip.ch}`;
    if (strip.name.textContent !== label) strip.name.textContent = label;
    strip.name.title = label;
    strip.root.classList.toggle('in-custom', strip.context === 'meters' && Boolean(dev) && isInCustom(dev.name, strip.dir, strip.ch));
    strip.root.classList.toggle('selected', state.selection.has(stripKey(strip)));

    if (!strip.rxBox) return;
    const box = strip.rxBox;
    const subDev = chan && chan.subscribedDevice;
    const subChan = (chan && chan.subscribedChannel) || '';
    if (!subDev) {
      box.className = 'rx-source-box empty';
      box.dataset.dev = '';
      box.removeAttribute('title');
      box.tabIndex = -1;
      box.children[0].textContent = '';
      box.children[1].textContent = '';
      return;
    }
    box.className = `rx-source-box ${chan.connected ? 'connected' : 'unresolved'}`;
    box.dataset.dev = subDev;
    box.dataset.chan = subChan;
    box.tabIndex = 0;
    box.title = `${chan.connected ? 'Connected' : 'Subscribed but not connected'} — ${subDev} / ${subChan}\nClick to show the transmitter`;
    box.children[0].textContent = subDev;
    box.children[1].textContent = subChan;
  }

  // ---------------------------------------------------------------------------
  // Custom tab: hand-picked channels, grouped by device (layout kept on the bridge)
  // ---------------------------------------------------------------------------

  const DIR_LABELS = { tx: 'Tx', rx: 'Rx' };
  const customCards = new Map(); // device name -> card view
  const stripKey = (strip) => `${strip.context}|${strip.ip}|${strip.dir}|${strip.ch}`;

  function customEntry(name) {
    return state.customLayout.devices.find((d) => d.name === name) || null;
  }

  function isInCustom(name, dir, ch) {
    const entry = customEntry(name);
    return Boolean(entry && entry[dir] && entry[dir].includes(ch));
  }

  function customChannelCount() {
    return state.customLayout.devices.reduce((n, d) => n + d.tx.length + d.rx.length, 0);
  }

  /** Apply a layout locally right away and send it to the bridge to save and share. */
  function setCustomLayout(layout) {
    layout.devices = layout.devices.filter((d) => d.tx.length || d.rx.length);
    state.customLayout = layout;
    if (!send({ type: 'custom_layout_set', data: layout })) showToast('Not connected to the bridge; the change will be lost');
    onCustomLayoutChanged();
  }

  function changeCustomChannels(name, dir, channels, add) {
    const layout = { devices: state.customLayout.devices.map((d) => ({ name: d.name, tx: [...d.tx], rx: [...d.rx] })) };
    let entry = layout.devices.find((d) => d.name === name);
    if (!entry) {
      if (!add) return 0;
      entry = { name, tx: [], rx: [] };
      layout.devices.push(entry);
    }
    const set = new Set(entry[dir]);
    let changed = 0;
    for (const ch of channels) {
      if (add && !set.has(ch)) {
        set.add(ch);
        changed++;
      } else if (!add && set.delete(ch)) {
        changed++;
      }
    }
    entry[dir] = [...set].sort((a, b) => a - b);
    if (changed) setCustomLayout(layout);
    return changed;
  }

  function removeCustomDevice(name) {
    setCustomLayout({ devices: state.customLayout.devices.filter((d) => d.name !== name).map((d) => ({ ...d })) });
  }

  function onCustomLayoutChanged() {
    const count = customChannelCount();
    els.tabCustomCount.hidden = count === 0;
    els.tabCustomCount.textContent = String(count);
    els.tabCustom.title = `Custom: ${count} channel${count === 1 ? '' : 's'}. Right-click (or long-press) any meter to add it.`;
    if (state.view === 'custom') renderCustom();
    else if (state.view === 'meters') refreshStripMarks();
  }

  /** Re-apply the in-Custom and selected markers on the visible normal strips. */
  function refreshStripMarks() {
    for (const view of cards.values()) {
      const dev = state.devices.get(view.ip);
      for (const strip of view.strips) {
        strip.root.classList.toggle('in-custom', Boolean(dev) && isInCustom(dev.name, strip.dir, strip.ch));
        strip.root.classList.toggle('selected', state.selection.has(stripKey(strip)));
      }
    }
    for (const view of customCards.values()) {
      for (const strip of view.strips) strip.root.classList.toggle('selected', state.selection.has(stripKey(strip)));
    }
  }

  // --- Selection ------------------------------------------------------------

  function visibleStrips(context) {
    const views = context === 'custom' ? customCards.values() : cards.values();
    const out = [];
    for (const view of views) for (const strip of view.strips) out.push(strip);
    return out;
  }

  function stripsByKey(keys) {
    return visibleStrips(state.view === 'custom' ? 'custom' : 'meters').filter((s) => keys.has(stripKey(s)));
  }

  function clearSelection() {
    if (!state.selection.size) return;
    state.selection.clear();
    state.selectionAnchor = null;
    refreshStripMarks();
  }

  function selectStrip(strip, { toggle = false, range = false } = {}) {
    const key = stripKey(strip);
    if (range && state.selectionAnchor) {
      // Shift-click: every strip between the anchor and this one on the same card row.
      const all = visibleStrips(strip.context).filter((s) => s.ip === strip.ip && s.dir === strip.dir);
      const a = all.findIndex((s) => stripKey(s) === state.selectionAnchor);
      const b = all.indexOf(strip);
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a];
        for (let i = from; i <= to; i++) state.selection.add(stripKey(all[i]));
        refreshStripMarks();
        return;
      }
    }
    if (toggle) {
      if (state.selection.has(key)) state.selection.delete(key);
      else state.selection.add(key);
    } else {
      state.selection.clear();
      state.selection.add(key);
    }
    state.selectionAnchor = key;
    refreshStripMarks();
  }

  function attachStripInteractions(strip) {
    const root = strip.root;
    let pressTimer = null;
    let pressStart = null;
    let suppressClickUntil = 0;
    let lastLongPress = 0;

    root.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('.rx-source-box')) return;
      if (e.metaKey || e.ctrlKey) selectStrip(strip, { toggle: true });
      else if (e.shiftKey) selectStrip(strip, { range: true, toggle: true });
      else if (state.selection.size === 1 && state.selection.has(stripKey(strip))) clearSelection();
      else selectStrip(strip); // plain click: select just this one (and anchor Shift-click ranges)
    });

    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (Date.now() - lastLongPress < 800) return; // Android also fires contextmenu after a long-press
      if (!state.selection.has(stripKey(strip))) selectStrip(strip);
      openMenu(strip, e.clientX, e.clientY);
    });

    // Long-press on touch screens (iPad Safari has no contextmenu event).
    const cancel = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
    };
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      pressStart = { x: e.clientX, y: e.clientY };
      cancel();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        lastLongPress = Date.now();
        suppressClickUntil = Date.now() + 600;
        if (!state.selection.has(stripKey(strip))) selectStrip(strip);
        openMenu(strip, pressStart.x, pressStart.y);
      }, 550);
    });
    root.addEventListener('pointermove', (e) => {
      if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancel();
    });
    root.addEventListener('pointerup', cancel);
    root.addEventListener('pointercancel', cancel);
    root.addEventListener('pointerleave', cancel);
  }

  /** Selected strips grouped as [{ name, dir, channels }]. */
  function selectionGroups(strips) {
    const groups = new Map();
    for (const s of strips) {
      const name = s.deviceName || (state.devices.get(s.ip) || {}).name;
      if (!name) continue;
      const id = `${name}|${s.dir}`;
      if (!groups.has(id)) groups.set(id, { name, dir: s.dir, channels: [] });
      groups.get(id).channels.push(s.ch);
    }
    return [...groups.values()];
  }

  const channelWord = (n) => `${n} channel${n === 1 ? '' : 's'}`;

  // --- Context menu ---------------------------------------------------------

  function openMenu(strip, x, y) {
    const menu = els.menu;
    menu.textContent = '';
    const selected = stripsByKey(state.selection);
    const strips = selected.length ? selected : [strip];
    const groups = selectionGroups(strips);
    const dev = strip.ip ? state.devices.get(strip.ip) : null;
    const devName = strip.deviceName || (dev && dev.name);
    const chan = dev && dev[strip.dir] && dev[strip.dir].channels[strip.ch];
    const number = String(strip.ch).padStart(2, '0');
    const named = chan && chan.name && chan.name !== number && chan.name !== String(strip.ch);
    const chLabel = `${DIR_LABELS[strip.dir]} ${number}${named ? ` · ${chan.name}` : ''}`;

    const title =
      strips.length === 1
        ? `${chLabel} — ${devName || 'unknown device'}`
        : `${channelWord(strips.length)} selected${groups.length > 1 ? ` on ${new Set(groups.map((g) => g.name)).size} devices` : ` — ${devName}`}`;
    menu.appendChild(el('div', 'context-menu-title', title));

    const item = (label, action, { danger = false, disabled = false } = {}) => {
      const btn = el('button', `context-menu-item${danger ? ' danger' : ''}`, label);
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.disabled = disabled;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        action();
      });
      menu.appendChild(btn);
      return btn;
    };
    const separator = () => menu.appendChild(el('div', 'context-menu-sep'));

    const inCustom = strips.filter((s) => isInCustom(s.deviceName || (state.devices.get(s.ip) || {}).name, s.dir, s.ch));
    const notInCustom = strips.length - inCustom.length;

    if (strip.context === 'meters') {
      if (notInCustom) {
        item(strips.length === 1 ? 'Add to Custom' : `Add ${channelWord(notInCustom)} to Custom`, () => {
          let added = 0;
          for (const g of groups) added += changeCustomChannels(g.name, g.dir, g.channels, true);
          clearSelection();
          showToast(`Added ${channelWord(added)} to Custom`, { action: 'Open Custom', onAction: () => setView('custom') });
        });
      }
      if (inCustom.length) {
        item(strips.length === 1 ? 'Remove from Custom' : `Remove ${channelWord(inCustom.length)} from Custom`, () => {
          let removed = 0;
          for (const g of groups) removed += changeCustomChannels(g.name, g.dir, g.channels, false);
          clearSelection();
          showToast(`Removed ${channelWord(removed)} from Custom`);
        }, { danger: true });
      }
      if (dev) {
        const block = dev[strip.dir] || { count: 0 };
        separator();
        item(`Add all ${block.count} ${DIR_LABELS[strip.dir]} channels of ${dev.name}`, () => {
          const all = Array.from({ length: block.count }, (_, i) => i + 1);
          const added = changeCustomChannels(dev.name, strip.dir, all, true);
          clearSelection();
          showToast(added ? `Added ${channelWord(added)} to Custom` : 'Already in Custom', { action: 'Open Custom', onAction: () => setView('custom') });
        }, { disabled: !block.count });
      }
      if (customChannelCount()) item('Open Custom tab', () => setView('custom'));
    } else {
      item(strips.length === 1 ? 'Remove from Custom' : `Remove ${channelWord(strips.length)} from Custom`, () => {
        let removed = 0;
        for (const g of groups) removed += changeCustomChannels(g.name, g.dir, g.channels, false);
        clearSelection();
        showToast(`Removed ${channelWord(removed)} from Custom`);
      }, { danger: true });
      if (devName) {
        item(`Remove ${devName} from Custom`, () => {
          removeCustomDevice(devName);
          clearSelection();
          showToast(`Removed ${devName} from Custom`);
        }, { danger: true });
      }
      if (dev && strips.length === 1) {
        separator();
        item(`Show in ${strip.dir === 'tx' ? 'Transmitter' : 'Receiver'} tab`, () => revealChannel(dev, strip.dir, strip.ch));
      }
    }
    if (state.selection.size > 1) {
      separator();
      item('Clear selection', clearSelection);
    }

    menu.hidden = false;
    // Keep the menu on screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const first = menu.querySelector('.context-menu-item:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  function closeMenu() {
    els.menu.hidden = true;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!els.menu.hidden && !els.menu.contains(e.target)) closeMenu();
  });
  // Clicking anywhere other than a meter (or the menu) clears the selection.
  document.addEventListener('click', (e) => {
    if (state.selection.size && !e.target.closest('.meter-strip, .context-menu, .toast')) clearSelection();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.menu.hidden) closeMenu();
      else clearSelection();
      return;
    }
    if (els.menu.hidden || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = [...els.menu.querySelectorAll('.context-menu-item:not(:disabled)')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('scroll', closeMenu, true);

  // --- Toast ----------------------------------------------------------------

  let toastTimer = null;
  function showToast(text, { action = null, onAction = null } = {}) {
    const toast = els.toast;
    toast.textContent = '';
    toast.appendChild(el('span', null, text));
    if (action && onAction) {
      const btn = el('button', 'toast-action', action);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        toast.hidden = true;
        onAction();
      });
      toast.appendChild(btn);
    }
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), action ? 5000 : 2500);
  }

  // --- Rendering ------------------------------------------------------------

  function customMatchesSearch(entry, dev) {
    const q = state.search;
    if (!q) return true;
    const fields = [entry.name, dev && dev.ip, dev && dev.manufacturer, dev && dev.modelName];
    for (const dir of ['tx', 'rx']) {
      const channels = (dev && dev[dir] && dev[dir].channels) || {};
      for (const ch of entry[dir]) {
        const c = channels[ch];
        if (c) fields.push(c.name, c.subscribedDevice, c.subscribedChannel);
      }
    }
    return fields.some((f) => f && String(f).toLowerCase().includes(q));
  }

  function renderCustom() {
    const entries = state.customLayout.devices
      .map((entry) => ({ entry, dev: findDeviceByName(entry.name) }))
      .filter(({ entry, dev }) => customMatchesSearch(entry, dev));
    const names = new Set(entries.map((e) => e.entry.name));

    for (const [name, view] of customCards) {
      if (!names.has(name)) {
        view.root.remove();
        customCards.delete(name);
      }
    }

    els.customEmpty.hidden = entries.length > 0;
    if (!entries.length) {
      els.customEmptyText.textContent = state.customLayout.devices.length
        ? 'No Custom channels match your filter.'
        : 'No channels in your Custom view yet.';
    }

    let previous = els.customEmpty;
    for (const { entry, dev } of entries) {
      let view = customCards.get(entry.name);
      if (!view) {
        view = createCard(null, { collapseKey: customCollapseKey(entry.name) });
        view.root.classList.add('custom-card');
        view.bankBar.remove();
        view.grid.remove();
        const remove = el('button', 'card-action', '✕');
        remove.type = 'button';
        remove.title = `Remove ${entry.name} from Custom`;
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          removeCustomDevice(entry.name);
          showToast(`Removed ${entry.name} from Custom`);
        });
        view.headerRight.appendChild(remove);
        customCards.set(entry.name, view);
      }
      updateCustomCard(view, entry, dev);
      if (previous.nextSibling !== view.root) previous.after(view.root);
      previous = view.root;
    }
    updateStats();
  }

  function updateCustomCard(view, entry, dev) {
    const shown = dev || { name: entry.name, ip: 'not on network', online: false, primarySync: 'none', secondarySync: 'none' };
    updateCardHeader(view, shown);
    view.root.classList.toggle('collapsed', state.collapsed[customCollapseKey(entry.name)] === true);
    view.root.classList.toggle('missing', !dev);
    const parts = [];
    if (entry.tx.length) parts.push(`${entry.tx.length} TX`);
    if (entry.rx.length) parts.push(`${entry.rx.length} RX`);
    view.chBadge.textContent = `${parts.join(' + ')} Ch`;

    const ip = dev ? dev.ip : null;
    const key = `${ip}|${entry.tx.join(',')}|${entry.rx.join(',')}`;
    if (key !== view.customKey) {
      view.customKey = key;
      view.body.textContent = '';
      view.strips = [];
      for (const dir of ['tx', 'rx']) {
        const channels = entry[dir];
        if (!channels.length) continue;
        const group = el('div', `custom-group custom-group-${dir}`);
        group.appendChild(
          el('div', 'custom-group-label', `${dir === 'tx' ? '▲ TRANSMIT (TX)' : '▼ RECEIVE (RX)'} · ${channelWord(channels.length)}`)
        );
        const grid = el('div', 'meters-grid-16');
        setGridColumns(grid, channels.length);
        for (const ch of channels) {
          const strip = createStrip(ip, dir, ch, 'custom');
          strip.deviceName = entry.name;
          view.strips.push(strip);
          grid.appendChild(strip.root);
        }
        group.appendChild(grid);
        view.body.appendChild(group);
      }
    }
    for (const strip of view.strips) {
      const chan = dev && dev[strip.dir] ? dev[strip.dir].channels[strip.ch] : null;
      updateStripLabels(strip, dev, chan);
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-navigation (Rx subscription -> Tx channel)
  // ---------------------------------------------------------------------------

  function navigateToTransmitter(deviceName, channelName) {
    const dev = findDeviceByName(deviceName);
    if (!dev) return;

    let ch = null;
    const wanted = (channelName || '').trim().toLowerCase();
    for (const c of Object.values(dev.tx.channels || {})) {
      if (c.name && c.name.trim().toLowerCase() === wanted) ch = c.number;
    }
    if (ch === null) {
      const m = wanted.match(/^\d+/);
      if (m && Number(m[0]) <= dev.tx.count) ch = Number(m[0]);
    }
    revealChannel(dev, 'tx', ch);
  }

  /** Switch to the Tx or Rx tab and highlight a channel (or the whole device when ch is null). */
  function revealChannel(dev, dir, ch) {
    setDirection(dir);
    if (state.search && !matchesSearch(dev)) {
      state.search = '';
      els.search.value = '';
    }
    state.collapsed[dev.name] = false;
    saveCollapsed();
    const count = (dev[dir] && dev[dir].count) || 0;
    if (ch !== null && count > BANK_SIZE) state.banks[dev.ip] = Math.ceil(ch / BANK_SIZE);

    renderDevices();

    const view = cards.get(dev.ip);
    if (!view) return;
    clearTimeout(state.highlightTimer);
    document.querySelectorAll('.highlight-orange-outline, .highlight-device-active').forEach((n) => {
      n.classList.remove('highlight-orange-outline', 'highlight-device-active');
    });
    const strip = ch !== null ? view.strips.find((s) => s.ch === ch) : null;
    const target = strip ? strip.root : view.root;
    target.classList.add('highlight-orange-outline');
    if (strip) view.root.classList.add('highlight-device-active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlightTimer = setTimeout(() => {
      target.classList.remove('highlight-orange-outline');
      view.root.classList.remove('highlight-device-active');
    }, 5000);
  }

  // ---------------------------------------------------------------------------
  // Meter rendering (every animation frame)
  // ---------------------------------------------------------------------------

  function segmentColor(ratio, hold) {
    if (ratio >= 0.94) return hold ? COLORS.holdRed : COLORS.red;
    if (ratio >= 0.82) return hold ? COLORS.holdAmber : COLORS.amber;
    if (ratio >= 0.55) return hold ? COLORS.holdYellow : COLORS.yellow;
    return hold ? COLORS.holdGreen : COLORS.green;
  }

  function sizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return false;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return true;
  }

  function drawMeter(strip, norm, holdNorm, clip) {
    const key = `${Math.round(norm * SEGMENTS)}|${Math.round(holdNorm * SEGMENTS)}|${clip}`;
    const canvas = strip.canvas;
    if (!sizeCanvas(canvas)) return;
    const sizeKey = `${key}|${canvas.width}x${canvas.height}`;
    if (sizeKey === strip.drawn) return;
    strip.drawn = sizeKey;

    const ctx = strip.ctx;
    const w = canvas.width;
    const h = canvas.height;
    const scale = h / 280;
    const gap = Math.max(1, Math.round(2 * scale));
    const padX = Math.max(1, Math.round(2 * scale));
    const segH = (h - (SEGMENTS - 1) * gap) / SEGMENTS;
    const lit = Math.round(norm * SEGMENTS);

    ctx.fillStyle = COLORS.track;
    ctx.fillRect(0, 0, w, h);
    for (let s = 0; s < SEGMENTS; s++) {
      const y = h - (s + 1) * (segH + gap) + gap;
      const ratio = s / (SEGMENTS - 1);
      if (s < lit) {
        ctx.fillStyle = clip && s === SEGMENTS - 1 ? COLORS.red : segmentColor(ratio, false);
        ctx.fillRect(padX, y, w - padX * 2, segH);
      } else {
        ctx.fillStyle = COLORS.off;
        ctx.fillRect(padX, y, w - padX * 2, segH);
        ctx.fillStyle = COLORS.offEdge;
        ctx.fillRect(padX, y, w - padX * 2, Math.max(1, scale));
      }
    }

    if (holdNorm > norm && holdNorm > 0.04) {
      const seg = Math.min(SEGMENTS - 1, Math.floor(holdNorm * SEGMENTS));
      const y = h - (seg + 1) * (segH + gap) + gap;
      ctx.fillStyle = segmentColor(seg / (SEGMENTS - 1), true);
      ctx.fillRect(padX, y, w - padX * 2, segH);
    }
  }

  function peakHold(key, norm, now) {
    const hold = state.holds.get(key);
    if (!hold || norm >= hold.norm) {
      state.holds.set(key, { norm, at: now });
      return norm;
    }
    const age = now - hold.at;
    if (age <= PEAK_HOLD_MS) return hold.norm;
    return Math.max(norm, hold.norm - ((age - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_PER_SEC);
  }

  function renderMeters() {
    const now = performance.now();
    const dir = state.direction;
    let clips = 0;

    for (const [ip, view] of cards) {
      const frame = state.meters[ip];
      const peaks = (frame && frame[dir]) || [];
      const mirrored = frame && frame.mirrored && frame.mirrored[dir];
      let maxNorm = 0;
      let deviceClip = false;

      // Clip latching and the header activity preview cover every channel,
      // including banks that aren't on screen.
      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        if (p === null) continue;
        const key = `${ip}|${dir}|${i + 1}`;
        if (isClipByte(p)) state.clipUntil.set(key, now + CLIP_LATCH_MS);
        if ((state.clipUntil.get(key) || 0) > now) {
          deviceClip = true;
          clips++;
        }
        const norm = dbfsToNormalized(byteToDbfs(p));
        if (norm > maxNorm) maxNorm = norm;
      }

      if (!view.root.classList.contains('collapsed')) {
        for (const strip of view.strips) renderStrip(strip, now, mirrored);
      }
      updateMiniBars(view, maxNorm, deviceClip);
    }

    els.statClips.textContent = clips;
  }

  /** Draw one strip from the latest meter frame. Returns { norm, clip }. */
  function renderStrip(strip, now, mirrored) {
    const frame = strip.ip ? state.meters[strip.ip] : null;
    const peaks = (frame && frame[strip.dir]) || [];
    if (mirrored === undefined) mirrored = frame && frame.mirrored && frame.mirrored[strip.dir];
    const p = peaks[strip.ch - 1];
    const hasData = p !== null && p !== undefined;
    const key = `${strip.ip}|${strip.dir}|${strip.ch}`;
    if (hasData && isClipByte(p)) state.clipUntil.set(key, now + CLIP_LATCH_MS);
    const dbfs = hasData ? byteToDbfs(p) : -Infinity;
    const norm = dbfsToNormalized(dbfs);
    const clip = (state.clipUntil.get(key) || 0) > now;

    drawMeter(strip, norm, peakHold(key, norm, now), clip);
    strip.clipLed.classList.toggle('active', clip);
    strip.root.classList.toggle('no-data', !hasData);
    strip.root.classList.toggle('mirrored', Boolean(mirrored && mirrored.includes(strip.ch)));

    const text = formatDbfs(dbfs, clip, hasData);
    if (strip.readout.textContent !== text) strip.readout.textContent = text;
    const cls = `numeric-readout ${clip ? 'clip' : norm > 0.05 ? 'active' : 'mute'}`;
    if (strip.readout.className !== cls) strip.readout.className = cls;
    return { norm, clip };
  }

  function updateMiniBars(view, maxNorm, deviceClip) {
    view.miniBars.forEach((bar, i) => {
      const cls = `mini-bar${deviceClip ? ' clip' : maxNorm >= (i + 1) * 0.22 ? ' active' : ''}`;
      if (bar.className !== cls) bar.className = cls;
      bar.style.height = `${Math.max(3, Math.round(maxNorm * 12))}px`;
    });
    view.root.classList.toggle('clipped', deviceClip);
  }

  /** Custom tab: every strip carries its own device and direction. */
  function renderCustomMeters() {
    const now = performance.now();
    let clips = 0;
    for (const view of customCards.values()) {
      let maxNorm = 0;
      let deviceClip = false;
      const collapsed = view.root.classList.contains('collapsed');
      for (const strip of view.strips) {
        if (collapsed) {
          // Still latch clips and drive the header preview while collapsed.
          const frame = strip.ip ? state.meters[strip.ip] : null;
          const p = frame && frame[strip.dir] ? frame[strip.dir][strip.ch - 1] : null;
          const key = `${strip.ip}|${strip.dir}|${strip.ch}`;
          if (p !== null && p !== undefined) {
            if (isClipByte(p)) state.clipUntil.set(key, now + CLIP_LATCH_MS);
            maxNorm = Math.max(maxNorm, dbfsToNormalized(byteToDbfs(p)));
          }
          if ((state.clipUntil.get(key) || 0) > now) {
            deviceClip = true;
            clips++;
          }
          continue;
        }
        const { norm, clip } = renderStrip(strip, now);
        maxNorm = Math.max(maxNorm, norm);
        if (clip) {
          deviceClip = true;
          clips++;
        }
      }
      updateMiniBars(view, maxNorm, deviceClip);
    }
    els.statClips.textContent = clips;
  }

  function updateStats() {
    if (state.view === 'custom') {
      const entries = state.customLayout.devices;
      const online = entries.filter((e) => {
        const d = findDeviceByName(e.name);
        return d && d.online;
      }).length;
      const expanded = entries.filter((e) => state.collapsed[customCollapseKey(e.name)] !== true).length;
      els.statDevices.textContent = online;
      els.statChannels.textContent = customChannelCount();
      els.modulesSummary.textContent = '';
      els.modulesSummary.append('Custom: ', el('strong', null, `${entries.length} Device${entries.length === 1 ? '' : 's'}`), ` (${online} online)`);
      els.toggleAllText.textContent = expanded > 0 ? 'Collapse All Modules' : 'Expand All Modules';
      return;
    }
    const devs = [...state.devices.values()];
    const online = devs.filter((d) => d.online);
    const expanded = devs.filter((d) => !isCollapsed(d)).length;
    els.statDevices.textContent = online.length;
    els.statChannels.textContent = online.reduce((n, d) => n + ((d[state.direction] && d[state.direction].count) || 0), 0);
    els.modulesSummary.textContent = '';
    els.modulesSummary.append('Modules: ', el('strong', null, `${online.length} Online`), ` (${expanded} Expanded)`);
    els.toggleAllText.textContent = expanded > 0 ? 'Collapse All Modules' : 'Expand All Modules';
  }

  function frame() {
    try {
      if (state.view === 'meters') renderMeters();
      else if (state.view === 'custom') renderCustomMeters();
    } catch (err) {
      console.error('[meters]', err);
    }
    requestAnimationFrame(frame);
  }

  connect();
  requestAnimationFrame(frame);
})();
