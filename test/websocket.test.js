'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { FrameParser, WebSocketServer, acceptKey, OPCODES, CLOSE_CODES } = require('../lib/web/websocket');

function clientFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const data = Buffer.from(payload);
  const len = data.length;
  const head = len < 126 ? Buffer.from([0, len]) : Buffer.from([0, 126, len >> 8, len & 0xff]);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, data]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(data.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([head, key, masked]);
}

test('handshake accept key matches RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('parser handles split chunks and multiple frames per chunk', () => {
  const parser = new FrameParser({ maxPayload: 1024 });
  const a = clientFrame(OPCODES.TEXT, 'hello');
  const b = clientFrame(OPCODES.TEXT, 'x'.repeat(300));
  const both = Buffer.concat([a, b]);

  let r = parser.push(both.subarray(0, 3));
  assert.equal(r.frames.length, 0);
  r = parser.push(both.subarray(3));
  assert.deepEqual(
    r.frames.map((f) => f.payload.toString()),
    ['hello', 'x'.repeat(300)]
  );
});

test('parser rejects unmasked and oversized client frames', () => {
  assert.equal(new FrameParser({ maxPayload: 1024 }).push(clientFrame(OPCODES.TEXT, 'hi', { mask: false })).error, CLOSE_CODES.PROTOCOL_ERROR);
  assert.equal(new FrameParser({ maxPayload: 10 }).push(clientFrame(OPCODES.TEXT, 'x'.repeat(20))).error, CLOSE_CODES.TOO_BIG);
});

function startServer(t) {
  const wss = new WebSocketServer({ path: '/ws' });
  const server = http.createServer();
  server.on('upgrade', (req, socket) => wss.handleUpgrade(req, socket));
  t.after(() => {
    wss.close();
    server.close();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ wss, port: server.address().port })));
}

function rawConnect(port, headers = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        ''
      ];
      socket.write(lines.join('\r\n'));
    });
    socket.once('data', (data) => resolve({ socket, response: data.toString() }));
  });
}

test('end to end: fragmented message delivered, ping answered', async (t) => {
  const { wss, port } = await startServer(t);
  const received = new Promise((resolve) => wss.on('connection', (client) => client.on('message', resolve)));
  const { socket, response } = await rawConnect(port);
  t.after(() => socket.destroy());
  assert.match(response, /^HTTP\/1\.1 101/);

  socket.write(clientFrame(OPCODES.TEXT, '{"type":', { fin: false }));
  socket.write(clientFrame(OPCODES.CONTINUATION, '"refresh"}'));
  assert.equal(await received, '{"type":"refresh"}');

  const pong = new Promise((resolve) => socket.once('data', resolve));
  socket.write(clientFrame(OPCODES.PING, 'abc'));
  const frame = await pong;
  assert.equal(frame[0], 0x80 | OPCODES.PONG);
  assert.equal(frame.subarray(2).toString(), 'abc');
});

test('cross-origin browser connections are refused', async (t) => {
  const { port } = await startServer(t);
  const { socket, response } = await rawConnect(port, { Origin: 'https://evil.example' });
  t.after(() => socket.destroy());
  assert.match(response, /^HTTP\/1\.1 403/);
});
