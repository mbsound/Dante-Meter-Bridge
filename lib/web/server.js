'use strict';

/**
 * HTTP API + static UI + WebSocket push for the meter bridge.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('./websocket');
const { listInterfaces } = require('../dante/network');
const { EventLog } = require('../events/event-log');
const { CustomLayouts, LayoutError, parseExport, toExport } = require('../custom-layout');
const { CATEGORIES, SEVERITIES, EVENT_TYPES, NOT_OBSERVABLE } = require('../events/catalog');

const EVENTS_ON_CONNECT = 5000;

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const METER_INTERVAL_MS = 50; // 20 Hz
const STRUCTURE_INTERVAL_MS = 250;
const MAX_BODY_BYTES = 4096;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const HTML_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'"
};

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(json);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Map a URL path to a file inside PUBLIC_DIR, or null if it escapes it. */
function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  return filePath.startsWith(PUBLIC_DIR + path.sep) ? filePath : null;
}

function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const filePath = resolveStaticPath(urlPath);
  const notFound = () => {
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };
  if (!filePath) return notFound();

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound();
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...BASE_HEADERS,
      ...(ext === '.html' ? HTML_HEADERS : {}),
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function publicInterfaces() {
  return listInterfaces().map(({ name, address, isDanteLinkLocal }) => ({ name, address, isDanteLinkLocal }));
}

/**
 * @param {object} opts
 * @param {import('../dante/engine').DanteEngine} opts.engine
 * @param {string} opts.version
 * @param {object} opts.log
 */
function createWebServer({ engine, eventLog = new EventLog(), customLayouts = new CustomLayouts(), version, log }) {
  const wss = new WebSocketServer({ path: '/ws', maxPayload: 1024 * 1024 }); // room for imported layouts
  const startedAt = Date.now();
  let lastStructure = '';

  const devicesMessage = () => {
    lastStructure = JSON.stringify(engine.getDevices());
    return `{"type":"devices","data":${lastStructure}}`;
  };

  const helloMessage = () =>
    JSON.stringify({ type: 'hello', data: { version, ...engine.interfaceInfo(), interfaces: publicInterfaces() } });

  const refresh = () =>
    new Promise((resolve) => {
      engine.refresh();
      // Give devices a moment to answer before reporting back.
      setTimeout(() => {
        wss.broadcast(devicesMessage());
        resolve();
      }, 300);
    });

  const eventsMessage = () =>
    JSON.stringify({
      type: 'events',
      data: {
        categories: CATEGORIES,
        severities: SEVERITIES,
        types: EVENT_TYPES,
        notObservable: NOT_OBSERVABLE,
        events: eventLog.recent(EVENTS_ON_CONNECT)
      }
    });

  const customLayoutsMessage = () => JSON.stringify({ type: 'custom_layouts', data: customLayouts.get() });

  /**
   * Saved-layout operations from a browser. Each may carry a requestId; the
   * sender gets { requestId, name } back (the name actually used, e.g. after
   * de-duplication), and every screen gets the updated library.
   */
  function handleLayoutMessage(client, msg) {
    const reply = (name) => client.send(JSON.stringify({ type: 'layout_result', data: { requestId: msg.requestId ?? null, name } }));
    try {
      switch (msg.type) {
        case 'layout_save':
          return reply(customLayouts.save(msg.name, msg.devices));
        case 'layout_create':
          return reply(customLayouts.create(msg.name, msg.devices || []));
        case 'layout_rename':
          return reply(customLayouts.rename(msg.from, msg.to));
        case 'layout_delete':
          customLayouts.remove(msg.name);
          return reply(null);
        case 'layout_import': {
          const imported = parseExport(msg.data);
          return reply(customLayouts.create(imported.name, imported.devices));
        }
      }
    } catch (err) {
      if (!(err instanceof LayoutError)) log.error('[Custom]', err);
      client.send(JSON.stringify({ type: 'custom_layout_error', data: { requestId: msg.requestId ?? null, message: err.message } }));
      client.send(customLayoutsMessage());
    }
  }

  async function handleApi(req, res, urlPath, query) {
    const route = `${req.method} ${urlPath}`;
    const list = (name) => (query.get(name) || '').split(',').filter(Boolean);
    switch (route) {
      case 'GET /api/events':
        return sendJson(res, 200, {
          events: eventLog.query({
            categories: list('category'),
            severities: list('severity'),
            limit: Math.min(Number(query.get('limit')) || 2000, 20000)
          })
        });
      case 'GET /api/events.csv': {
        const csv = EventLog.toCsv(eventLog.query({ categories: list('category'), severities: list('severity'), limit: 20000 }));
        res.writeHead(200, {
          ...BASE_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="dante-events.csv"',
          'Cache-Control': 'no-store'
        });
        return res.end(csv);
      }
      case 'GET /api/diagnostics':
        return sendJson(res, 200, { version, ...engine.getDiagnostics() });
      case 'POST /api/events/clear':
        eventLog.clear();
        return sendJson(res, 200, { success: true });
      case 'GET /api/devices':
        return sendJson(res, 200, engine.getSnapshot());
      case 'GET /api/status': {
        const devices = engine.getDevices();
        return sendJson(res, 200, {
          status: 'ok',
          version,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          boundIp: engine.boundIp,
          deviceCount: devices.length,
          onlineCount: devices.filter((d) => d.online).length,
          wsClients: wss.clients.size
        });
      }
      case 'GET /api/custom-layouts':
        return sendJson(res, 200, customLayouts.get());
      case 'GET /api/custom-layouts/export': {
        const layout = customLayouts.find(query.get('name') || '');
        if (!layout) return sendJson(res, 404, { error: 'No such layout' });
        const filename = `${layout.name.replace(/[^\w.-]+/g, '_') || 'layout'}.dante-layout.json`;
        res.writeHead(200, {
          ...BASE_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify(toExport(layout), null, 2) + '\n');
      }
      case 'GET /api/interfaces':
        return sendJson(res, 200, { activeIp: engine.boundIp, interfaces: publicInterfaces() });
      case 'POST /api/interface': {
        const body = await readJsonBody(req);
        const result = engine.selectInterface(typeof body.ip === 'string' ? body.ip : 'all');
        return sendJson(res, 200, result);
      }
      case 'GET /api/refresh': // kept for backwards compatibility
      case 'POST /api/refresh':
        await refresh();
        return sendJson(res, 200, { success: true, snapshot: engine.getSnapshot() });
      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  }

  const server = http.createServer((req, res) => {
    const [urlPath, search = ''] = (req.url || '/').split('?');
    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath, new URLSearchParams(search)).catch((err) => {
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
        if (!err.status) log.error('[HTTP]', err);
      });
      return;
    }
    serveStatic(req, res, urlPath);
  });

  server.on('upgrade', (req, socket) => wss.handleUpgrade(req, socket));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  wss.on('connection', (client, req) => {
    log.info(`[WebSocket] Client connected from ${req.socket.remoteAddress} (${wss.clients.size} active)`);
    client.send(helloMessage());
    client.send(devicesMessage());
    client.send(eventsMessage());
    client.send(healthMessage());
    client.send(customLayoutsMessage());

    client.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'select_interface') {
        engine.selectInterface(typeof msg.ip === 'string' ? msg.ip : 'all');
      } else if (msg.type === 'refresh') {
        refresh();
      } else if (typeof msg.type === 'string' && msg.type.startsWith('layout_')) {
        handleLayoutMessage(client, msg);
      }
    });
  });
  wss.on('disconnect', () => log.info(`[WebSocket] Client disconnected (${wss.clients.size} active)`));

  eventLog.on('event', (event) => wss.broadcast(JSON.stringify({ type: 'event', data: event })));
  customLayouts.on('changed', () => wss.broadcast(customLayoutsMessage()));
  eventLog.on('cleared', () => wss.broadcast(JSON.stringify({ type: 'events_cleared' })));

  engine.on('interface', () => {
    wss.broadcast(helloMessage());
    wss.broadcast(devicesMessage());
  });
  // An adapter gained or lost an address: refresh the NIC menu.
  engine.on('interfaces-changed', () => wss.broadcast(helloMessage()));

  let lastHealth = '';
  const healthMessage = () => {
    lastHealth = JSON.stringify(engine.getHealth());
    return `{"type":"health","data":${lastHealth}}`;
  };

  const timers = [
    setInterval(() => {
      if (wss.clients.size === 0) return;
      const frame = JSON.stringify({ type: 'meters', t: Date.now(), d: engine.getMeterFrame() });
      wss.broadcast(frame, { droppable: true });
    }, METER_INTERVAL_MS),
    setInterval(() => {
      if (wss.clients.size === 0) return;
      if (JSON.stringify(engine.getDevices()) !== lastStructure) wss.broadcast(devicesMessage());
      if (JSON.stringify(engine.getHealth()) !== lastHealth) wss.broadcast(healthMessage());
    }, STRUCTURE_INTERVAL_MS)
  ];

  function close() {
    for (const t of timers) clearInterval(t);
    wss.close();
    server.close();
    server.closeAllConnections?.();
  }

  return { server, wss, close };
}

module.exports = { createWebServer, resolveStaticPath, PUBLIC_DIR };
