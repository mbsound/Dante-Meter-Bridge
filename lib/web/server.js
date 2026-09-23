'use strict';

/**
 * HTTP API + static UI + WebSocket push for the meter bridge.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('./websocket');
const { listInterfaces } = require('../dante/network');

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
function createWebServer({ engine, version, log }) {
  const wss = new WebSocketServer({ path: '/ws' });
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

  async function handleApi(req, res, urlPath) {
    const route = `${req.method} ${urlPath}`;
    switch (route) {
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
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath).catch((err) => {
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
      }
    });
  });
  wss.on('disconnect', () => log.info(`[WebSocket] Client disconnected (${wss.clients.size} active)`));

  engine.on('interface', () => {
    wss.broadcast(helloMessage());
    wss.broadcast(devicesMessage());
  });

  const timers = [
    setInterval(() => {
      if (wss.clients.size === 0) return;
      const frame = JSON.stringify({ type: 'meters', t: Date.now(), d: engine.getMeterFrame() });
      wss.broadcast(frame, { droppable: true });
    }, METER_INTERVAL_MS),
    setInterval(() => {
      if (wss.clients.size === 0) return;
      if (JSON.stringify(engine.getDevices()) !== lastStructure) wss.broadcast(devicesMessage());
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
