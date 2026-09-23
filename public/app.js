/**
 * Dante Audio Meter Bridge — browser UI.
 *
 * Server messages (WebSocket /ws):
 *   hello   { version, boundIp, name, interfaces[] }
 *   devices [ device structure … ]            (sent when anything changes)
 *   meters  { t, d: { ip: { tx:[byte|null], rx:[byte|null], mirrored? } } }  (20 Hz)
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
    search: $('searchInput'),
    toggleAll: $('btnToggleAll'),
    toggleAllText: $('toggleAllText'),
    resetPeaks: $('btnResetPeaks'),
    refresh: $('btnRefresh'),
    fullscreen: $('btnFullscreen'),
    container: $('devicesContainer'),
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
        renderDevices();
        break;
      case 'meters':
        state.meters = msg.d || {};
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Header controls
  // ---------------------------------------------------------------------------

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

  function setDirection(dir) {
    if (state.direction === dir) return;
    state.direction = dir;
    els.tabTx.classList.toggle('active', dir === 'tx');
    els.tabTx.setAttribute('aria-selected', String(dir === 'tx'));
    els.tabRx.classList.toggle('active', dir === 'rx');
    els.tabRx.setAttribute('aria-selected', String(dir === 'rx'));
    els.statTab.textContent = dir === 'tx' ? 'TRANSMITTER' : 'RECEIVER';
    renderDevices();
  }

  els.search.addEventListener('input', () => {
    state.search = els.search.value.trim().toLowerCase();
    renderDevices();
  });

  els.toggleAll.addEventListener('click', () => {
    const devs = [...state.devices.values()];
    if (!devs.length) return;
    const collapse = devs.some((d) => !isCollapsed(d));
    for (const d of devs) state.collapsed[d.name] = collapse;
    saveCollapsed();
    renderDevices();
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

  function createCard(ip) {
    const root = el('section', 'device-card');
    root.dataset.ip = ip;

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
      const dev = state.devices.get(ip);
      if (!dev) return;
      state.collapsed[dev.name] = !isCollapsed(dev);
      saveCollapsed();
      root.classList.toggle('collapsed', isCollapsed(dev));
      updateStats();
    };
    collapseBtn.addEventListener('click', toggle);
    header.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      if (e.target.closest('a, input, select, .bank-btn')) return;
      toggle(e);
    });
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
    view.root.classList.toggle('offline', !dev.online);
    view.root.classList.toggle('clock-leader', Boolean(dev.isClockLeader));
    view.offlineBadge.hidden = dev.online;
    view.leaderBadge.hidden = !dev.isClockLeader;

    view.name.textContent = dev.name;
    const secondary = dev.secondaryIp || (dev.secondaryLinkUp === false ? 'link down' : null);
    view.ipBadge.textContent = secondary ? `${dev.ip} / ${secondary}` : dev.ip;
    view.ipBadge.title = `Primary: ${dev.ip}${dev.secondarySupported ? ` | Secondary: ${secondary || 'unknown'}` : ''}`;
    view.srBadge.textContent = formatSampleRate(dev.sampleRate);
    view.chBadge.textContent = `${count} ${dir.toUpperCase()} Ch`;

    view.primaryDot.className = `sync-dot ${dev.primarySync}`;
    view.primaryDot.title = `Primary network: ${SYNC_TITLES[dev.primarySync] || dev.primarySync}`;
    view.secondaryDot.className = `sync-dot ${dev.secondarySync}`;
    view.secondaryDot.title = `Secondary network: ${SYNC_TITLES[dev.secondarySync] || dev.secondarySync}`;

    updateIdentity(view, dev);
    updateBanks(view, dev, count);
    updateStrips(view, dev, block);
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

  function updateStrips(view, dev, block) {
    const dir = state.direction;
    const { start, end } = currentRange(dev.ip, block.count || 0);
    const gridKey = `${dir}|${start}|${end}`;

    if (gridKey !== view.gridKey) {
      view.gridKey = gridKey;
      view.grid.textContent = '';
      view.strips = [];
      const visible = end >= start ? end - start + 1 : 0;
      view.grid.classList.toggle('compact', visible > 0 && visible <= 8);
      view.grid.style.gridTemplateColumns = visible > 0 && visible <= 8 ? `repeat(${visible}, minmax(70px, 120px))` : '';
      view.grid.style.setProperty('--compact-count', String(visible));

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

  function createStrip(ip, dir, ch) {
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

    return { ip, dir, ch, root, name, rxBox, clipLed, canvas, ctx: canvas.getContext('2d'), readout, drawn: '' };
  }

  function updateStripLabels(strip, dev, chan) {
    const label = (chan && chan.name) || `${strip.dir.toUpperCase()} ${strip.ch}`;
    if (strip.name.textContent !== label) strip.name.textContent = label;
    strip.name.title = label;

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
  // Cross-navigation (Rx subscription -> Tx channel)
  // ---------------------------------------------------------------------------

  function navigateToTransmitter(deviceName, channelName) {
    const dev = findDeviceByName(deviceName);
    if (!dev) return;

    setDirection('tx');
    if (state.search && !matchesSearch(dev)) {
      state.search = '';
      els.search.value = '';
    }
    state.collapsed[dev.name] = false;
    saveCollapsed();

    let ch = null;
    const wanted = (channelName || '').trim().toLowerCase();
    for (const c of Object.values(dev.tx.channels || {})) {
      if (c.name && c.name.trim().toLowerCase() === wanted) ch = c.number;
    }
    if (ch === null) {
      const m = wanted.match(/^\d+/);
      if (m && Number(m[0]) <= dev.tx.count) ch = Number(m[0]);
    }
    if (ch !== null && dev.tx.count > BANK_SIZE) state.banks[dev.ip] = Math.ceil(ch / BANK_SIZE);

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
        for (const strip of view.strips) {
          const p = peaks[strip.ch - 1];
          const hasData = p !== null && p !== undefined;
          const key = `${ip}|${dir}|${strip.ch}`;
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
        }
      }

      view.miniBars.forEach((bar, i) => {
        const cls = `mini-bar${deviceClip ? ' clip' : maxNorm >= (i + 1) * 0.22 ? ' active' : ''}`;
        if (bar.className !== cls) bar.className = cls;
        bar.style.height = `${Math.max(3, Math.round(maxNorm * 12))}px`;
      });
      view.root.classList.toggle('clipped', deviceClip);
    }

    els.statClips.textContent = clips;
  }

  function updateStats() {
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
      renderMeters();
    } catch (err) {
      console.error('[meters]', err);
    }
    requestAnimationFrame(frame);
  }

  connect();
  requestAnimationFrame(frame);
})();
