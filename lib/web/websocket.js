'use strict';

/**
 * Minimal, dependency-free WebSocket server (RFC 6455): text messages,
 * fragmentation, ping/pong keepalive, close handshake and send backpressure.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const CLOSE_CODES = { NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL_ERROR: 1002, TOO_BIG: 1009 };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame decoder. Feed it raw socket chunks; it yields complete
 * frames and keeps partial data buffered.
 */
class FrameParser {
  constructor({ maxPayload }) {
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
  }

  /** Returns { frames, error } where error is a close code on protocol failure. */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];

    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) break;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return { frames, error: CLOSE_CODES.TOO_BIG };
        len = Number(big);
        offset = 10;
      }

      if (!masked) return { frames, error: CLOSE_CODES.PROTOCOL_ERROR };
      if (len > this.maxPayload) return { frames, error: CLOSE_CODES.TOO_BIG };
      if (buf.length < offset + 4 + len) break;

      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      frames.push({ fin, opcode, payload });
      this.buffer = buf.subarray(offset + 4 + len);
    }
    return { frames, error: null };
  }
}

class WebSocketClient extends EventEmitter {
  constructor(socket, { maxPayload }) {
    super();
    this.socket = socket;
    this.parser = new FrameParser({ maxPayload });
    this.maxPayload = maxPayload;
    this.fragments = null;
    this.fragmentOpcode = null;
    this.alive = true;
    this.closed = false;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  onData(chunk) {
    const { frames, error } = this.parser.push(chunk);
    for (const frame of frames) {
      if (this.closed) return;
      this.onFrame(frame);
    }
    if (error) this.close(error);
  }

  onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODES.PING:
        this.write(encodeFrame(OPCODES.PONG, payload));
        return;
      case OPCODES.PONG:
        this.alive = true;
        return;
      case OPCODES.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_CODES.NORMAL;
        this.close(code);
        return;
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY:
        if (this.fragments) return this.close(CLOSE_CODES.PROTOCOL_ERROR);
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        break;
      case OPCODES.CONTINUATION:
        if (!this.fragments) return this.close(CLOSE_CODES.PROTOCOL_ERROR);
        this.fragments.push(payload);
        break;
      default:
        return this.close(CLOSE_CODES.PROTOCOL_ERROR);
    }

    const size = this.fragments.reduce((n, b) => n + b.length, 0);
    if (size > this.maxPayload) return this.close(CLOSE_CODES.TOO_BIG);
    if (!fin) return;

    const message = Buffer.concat(this.fragments);
    const wasText = this.fragmentOpcode === OPCODES.TEXT;
    this.fragments = null;
    this.fragmentOpcode = null;
    if (wasText) this.emit('message', message.toString('utf8'));
  }

  write(frame) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(frame);
      return true;
    } catch {
      this.finish();
      return false;
    }
  }

  send(text) {
    return this.write(encodeFrame(OPCODES.TEXT, Buffer.from(text, 'utf8')));
  }

  sendFrame(frame) {
    return this.write(frame);
  }

  ping() {
    this.write(encodeFrame(OPCODES.PING));
  }

  close(code = CLOSE_CODES.NORMAL) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.write(encodeFrame(OPCODES.CLOSE, payload));
    this.finish();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  terminate() {
    this.finish();
    this.socket.destroy();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.path            URL path to accept upgrades on.
   * @param {number} [opts.maxPayload]    Largest accepted client message.
   * @param {number} [opts.heartbeatMs]   Ping interval; silent clients are dropped.
   * @param {number} [opts.highWaterMark] Skip droppable sends above this many buffered bytes.
   */
  constructor({ path = '/ws', maxPayload = 64 * 1024, heartbeatMs = 15000, highWaterMark = 1024 * 1024 } = {}) {
    super();
    this.path = path;
    this.maxPayload = maxPayload;
    this.highWaterMark = highWaterMark;
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.checkAlive(), heartbeatMs);
    this.heartbeat.unref();
  }

  handleUpgrade(req, socket) {
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== this.path) return reject(404, 'Not Found');
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || Buffer.from(key, 'base64').length !== 16) {
      return reject(400, 'Bad Request');
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!isSameOrigin(req)) return reject(403, 'Forbidden');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        ''
      ].join('\r\n')
    );

    const client = new WebSocketClient(socket, { maxPayload: this.maxPayload });
    this.clients.add(client);
    client.on('close', () => {
      this.clients.delete(client);
      this.emit('disconnect', client);
    });
    this.emit('connection', client, req);
  }

  /** Send to every client. Droppable messages skip clients that are backed up. */
  broadcast(text, { droppable = false } = {}) {
    if (this.clients.size === 0) return;
    const frame = encodeFrame(OPCODES.TEXT, Buffer.from(text, 'utf8'));
    for (const client of this.clients) {
      if (droppable && client.bufferedAmount > this.highWaterMark) continue;
      client.sendFrame(frame);
    }
  }

  checkAlive() {
    for (const client of this.clients) {
      if (!client.alive) {
        client.terminate();
        continue;
      }
      client.alive = false;
      client.ping();
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.close(CLOSE_CODES.GOING_AWAY);
  }
}

/** Reject cross-site pages trying to drive the bridge from a visitor's browser. */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = { WebSocketServer, FrameParser, encodeFrame, acceptKey, OPCODES, CLOSE_CODES };
