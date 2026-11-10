'use strict';

/**
 * Custom tab layout: validation, persistence and sharing over the WebSocket.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { CustomLayout, validateLayout } = require('../lib/custom-layout');
const { createWebServer } = require('../lib/web/server');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-custom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('layouts are cleaned up: channels sorted and de-duplicated, empty devices and duplicates dropped', () => {
  const clean = validateLayout({
    devices: [
      { name: ' Stagebox-1 ', tx: [24, 1, 3, 3], rx: [] },
      { name: 'Empty', tx: [], rx: [] },
      { name: 'Stagebox-1', tx: [9] },
      { name: 'Desk', rx: [5, 2] }
    ]
  });
  assert.deepEqual(clean, {
    devices: [
      { name: 'Stagebox-1', tx: [1, 3, 24], rx: [] },
      { name: 'Desk', tx: [], rx: [2, 5] }
    ]
  });
});

test('invalid layouts are rejected', () => {
  for (const bad of [
    null,
    {},
    { devices: 'x' },
    { devices: [{ tx: [1] }] },
    { devices: [{ name: '', tx: [1] }] },
    { devices: [{ name: 'A', tx: [0] }] },
    { devices: [{ name: 'A', tx: [1.5] }] },
    { devices: [{ name: 'A', rx: ['1'] }] },
    { devices: [{ name: 'x'.repeat(65), tx: [1] }] }
  ]) {
    assert.throws(() => validateLayout(bad), JSON.stringify(bad));
  }
});

test('the layout is saved to disk and reloaded', (t) => {
  const file = path.join(tmpDir(t), 'nested', 'custom-layout.json');
  const a = new CustomLayout({ file });
  let changed = null;
  a.on('changed', (layout) => (changed = layout));
  a.set({ devices: [{ name: 'Stagebox-1', tx: [1, 3, 24], rx: [2] }] });
  assert.deepEqual(changed.devices[0].tx, [1, 3, 24]);

  const b = new CustomLayout({ file }).load();
  assert.deepEqual(b.get(), { devices: [{ name: 'Stagebox-1', tx: [1, 3, 24], rx: [2] }] });
});

test('a missing or corrupt file starts empty', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(new CustomLayout({ file: path.join(dir, 'none.json') }).load().get(), { devices: [] });
  const corrupt = path.join(dir, 'bad.json');
  fs.writeFileSync(corrupt, '{nope');
  const warnings = [];
  assert.deepEqual(new CustomLayout({ file: corrupt, log: { warn: (m) => warnings.push(m) } }).load().get(), { devices: [] });
  assert.equal(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Over the web server
// ---------------------------------------------------------------------------

function fakeEngine() {
  const engine = new EventEmitter();
  Object.assign(engine, {
    boundIp: null,
    getDevices: () => [],
    getSnapshot: () => ({ devices: [] }),
    getDiagnostics: () => ({}),
    getHealth: () => ({}),
    getMeterFrame: () => ({}),
    interfaceInfo: () => ({ boundIp: null, name: 'All Interfaces' }),
    selectInterface: () => ({}),
    refresh() {}
  });
  return engine;
}

/** Minimal WebSocket client: sends masked text frames, collects text messages. */
function wsClient(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const messages = [];
    const waiters = [];
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve(client);
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + len) return;
        if ((buf[0] & 0x0f) === 1) {
          const msg = JSON.parse(buf.subarray(offset, offset + len).toString());
          messages.push(msg);
          for (const w of [...waiters]) if (w.match(msg)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(msg);
        }
        buf = buf.subarray(offset + len);
      }
    });
    const client = {
      socket,
      messages,
      next: (match) =>
        new Promise((res) => {
          const found = messages.find(match);
          if (found) {
            messages.splice(messages.indexOf(found), 1);
            res(found);
          } else waiters.push({ match, resolve: res });
        }),
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj));
        const mask = Buffer.from([1, 2, 3, 4]);
        const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        socket.write(Buffer.concat([header, mask, masked]));
      }
    };
    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
    );
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

test('a layout set from one screen is saved and pushed to every screen', async (t) => {
  const file = path.join(tmpDir(t), 'custom-layout.json');
  const customLayout = new CustomLayout({ file });
  const web = createWebServer({ engine: fakeEngine(), customLayout, version: 'test', log: { info() {}, warn() {}, error() {} } });
  t.after(() => web.close());
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const port = web.server.address().port;

  const a = await wsClient(port);
  const b = await wsClient(port);
  t.after(() => {
    a.socket.destroy();
    b.socket.destroy();
  });
  // Each screen gets the current (empty) layout on connect.
  assert.deepEqual((await a.next((m) => m.type === 'custom_layout')).data, { devices: [] });
  await b.next((m) => m.type === 'custom_layout');

  a.send({ type: 'custom_layout_set', data: { devices: [{ name: 'Stagebox-1', tx: [24, 1, 3], rx: [2] }] } });
  const pushed = await b.next((m) => m.type === 'custom_layout');
  assert.deepEqual(pushed.data, { devices: [{ name: 'Stagebox-1', tx: [1, 3, 24], rx: [2] }] });
  assert.deepEqual(await getJson(port, '/api/custom-layout'), pushed.data);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), pushed.data);

  // An invalid layout is refused, and the sender gets the current one back.
  a.send({ type: 'custom_layout_set', data: { devices: [{ name: 'X', tx: [-1] }] } });
  assert.equal((await a.next((m) => m.type === 'custom_layout_error')).type, 'custom_layout_error');
  assert.deepEqual((await a.next((m) => m.type === 'custom_layout')).data, pushed.data);
});
