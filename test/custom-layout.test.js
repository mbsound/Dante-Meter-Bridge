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
const { CustomLayouts, validateLayout, validateLibrary, parseExport, toExport } = require('../lib/custom-layout');
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

test('layouts are saved to disk and reloaded', (t) => {
  const file = path.join(tmpDir(t), 'nested', 'custom-layout.json');
  const a = new CustomLayouts({ file });
  let changes = 0;
  a.on('changed', () => changes++);
  a.save('FOH', [{ name: 'Stagebox-1', tx: [24, 1, 3], rx: [2] }]);
  a.save('Monitors', [{ name: 'Desk', rx: [5] }]);
  assert.equal(changes, 2);

  const b = new CustomLayouts({ file }).load();
  assert.deepEqual(b.get(), {
    layouts: [
      { name: 'FOH', devices: [{ name: 'Stagebox-1', tx: [1, 3, 24], rx: [2] }] },
      { name: 'Monitors', devices: [{ name: 'Desk', tx: [], rx: [5] }] }
    ]
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('a v2.2.0 single-layout file becomes "Layout 1"', (t) => {
  const file = path.join(tmpDir(t), 'custom-layout.json');
  fs.writeFileSync(file, JSON.stringify({ devices: [{ name: 'Stagebox-1', tx: [1, 3] }] }));
  assert.deepEqual(new CustomLayouts({ file }).load().get(), {
    layouts: [{ name: 'Layout 1', devices: [{ name: 'Stagebox-1', tx: [1, 3], rx: [] }] }]
  });
  assert.deepEqual(validateLibrary({ devices: [] }), { layouts: [] });
});

test('create picks a free name; rename and delete; names are unique ignoring case', () => {
  const lib = new CustomLayouts();
  assert.equal(lib.create('FOH'), 'FOH');
  assert.equal(lib.create('foh'), 'foh (2)');
  assert.equal(lib.create('FOH'), 'FOH (3)');
  assert.equal(lib.rename('foh (2)', 'Monitors'), 'Monitors');
  assert.throws(() => lib.rename('Monitors', 'fOh'), /already exists/);
  assert.equal(lib.rename('FOH', 'foh'), 'foh', 'changing only the case is allowed');
  lib.remove('FOH (3)');
  assert.deepEqual(lib.get().layouts.map((l) => l.name), ['foh', 'Monitors']);
  assert.throws(() => lib.remove('nope'), /no layout/);
  assert.throws(() => lib.save('   ', []), /empty/);
  assert.throws(() => lib.save('x'.repeat(49), []), /longer/);
  // Saving under an existing name (any case) updates that layout.
  lib.save('MONITORS', [{ name: 'Desk', tx: [1] }]);
  assert.deepEqual(lib.get().layouts.map((l) => [l.name, l.devices.length]), [['foh', 0], ['Monitors', 1]]);
});

test('export files round-trip, and foreign files are refused', () => {
  const exported = toExport({ name: 'FOH', devices: [{ name: 'Stagebox-1', tx: [1], rx: [] }] });
  assert.equal(exported.format, 'dante-meter-bridge-layout');
  assert.deepEqual(parseExport(JSON.parse(JSON.stringify(exported))), { name: 'FOH', devices: [{ name: 'Stagebox-1', tx: [1], rx: [] }] });
  assert.deepEqual(parseExport({ devices: [{ name: 'A', rx: [2] }] }).name, 'Imported layout');
  assert.throws(() => parseExport({ format: 'something-else', devices: [] }), /not a Dante Meter Bridge/);
  assert.throws(() => parseExport({ hello: 1 }), /no "devices"/);
  assert.throws(() => parseExport(null), /not a layout/);
});

test('a missing or corrupt file starts empty', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(new CustomLayouts({ file: path.join(dir, 'none.json') }).load().get(), { layouts: [] });
  const corrupt = path.join(dir, 'bad.json');
  fs.writeFileSync(corrupt, '{nope');
  const warnings = [];
  assert.deepEqual(new CustomLayouts({ file: corrupt, log: { warn: (m) => warnings.push(m) } }).load().get(), { layouts: [] });
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
          const waiter = waiters.find((w) => w.match(msg));
          if (waiter) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(msg);
          } else {
            messages.push(msg);
          }
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

function getRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('saved layouts: changes from one screen are stored and pushed to every screen', async (t) => {
  const file = path.join(tmpDir(t), 'custom-layout.json');
  const customLayouts = new CustomLayouts({ file });
  const web = createWebServer({ engine: fakeEngine(), customLayouts, version: 'test', log: { info() {}, warn() {}, error() {} } });
  t.after(() => web.close());
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const port = web.server.address().port;

  const a = await wsClient(port);
  const b = await wsClient(port);
  t.after(() => {
    a.socket.destroy();
    b.socket.destroy();
  });
  const library = (c) => c.next((m) => m.type === 'custom_layouts').then((m) => m.data);
  assert.deepEqual(await library(a), { layouts: [] });
  await library(b);

  a.send({ type: 'layout_save', requestId: 1, name: 'FOH', devices: [{ name: 'Stagebox-1', tx: [24, 1, 3], rx: [2] }] });
  assert.deepEqual(await a.next((m) => m.type === 'layout_result'), { type: 'layout_result', data: { requestId: 1, name: 'FOH' } });
  const pushed = await library(b);
  assert.deepEqual(pushed, { layouts: [{ name: 'FOH', devices: [{ name: 'Stagebox-1', tx: [1, 3, 24], rx: [2] }] }] });
  assert.deepEqual(await getJson(port, '/api/custom-layouts'), pushed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).layouts, pushed.layouts);
  await library(a);

  // Save As / New pick a free name and report it back.
  a.send({ type: 'layout_create', requestId: 2, name: 'foh', devices: [] });
  assert.equal((await a.next((m) => m.type === 'layout_result')).data.name, 'foh (2)');
  await library(a);

  // Export downloads a file that Import turns back into a layout.
  const exported = await getRaw(port, '/api/custom-layouts/export?name=FOH');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment; filename="FOH\.dante-layout\.json"/);
  a.send({ type: 'layout_import', requestId: 3, data: JSON.parse(exported.body) });
  assert.equal((await a.next((m) => m.type === 'layout_result')).data.name, 'FOH (3)', '"foh (2)" is taken (names ignore case)');
  const afterImport = await library(a);
  assert.deepEqual(afterImport.layouts.find((l) => l.name === 'FOH (3)').devices, pushed.layouts[0].devices);
  assert.equal((await getRaw(port, '/api/custom-layouts/export?name=nope')).status, 404);

  a.send({ type: 'layout_rename', requestId: 4, from: 'foh (2)', to: 'Monitors' });
  assert.equal((await a.next((m) => m.type === 'layout_result')).data.name, 'Monitors');
  await library(a);
  a.send({ type: 'layout_delete', requestId: 5, name: 'FOH (3)' });
  await a.next((m) => m.type === 'layout_result');
  assert.deepEqual((await library(a)).layouts.map((l) => l.name), ['FOH', 'Monitors']);

  // Bad requests get an error and the current library back.
  a.send({ type: 'layout_save', requestId: 6, name: 'X', devices: [{ name: 'X', tx: [-1] }] });
  const error = await a.next((m) => m.type === 'custom_layout_error');
  assert.equal(error.data.requestId, 6);
  assert.deepEqual((await library(a)).layouts.map((l) => l.name), ['FOH', 'Monitors']);
});

test('long names: create never returns a name that does not exist or overwrites another layout', () => {
  const lib = new CustomLayouts();
  const long = `${'a'.repeat(42)} bcdef`; // a space lands where the name is cut
  const names = [lib.create(long, [{ name: 'A', tx: [1] }]), lib.create(long, [{ name: 'B', tx: [1] }]), lib.create(long, [{ name: 'C', tx: [1] }])];
  assert.equal(new Set(names).size, 3);
  assert.equal(lib.get().layouts.length, 3);
  for (const n of names) assert.ok(lib.find(n), n);
  assert.deepEqual(names.map((n) => lib.find(n).devices[0].name), ['A', 'B', 'C']);
});

test('one invalid layout in the file does not cost the others, and an unreadable file is kept as a copy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'custom-layout.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, layouts: [{ name: 'Good', devices: [{ name: 'A', tx: [1] }] }, { name: 'Bad', devices: [{ name: 'A', tx: ['x'] }] }] }));
  const warnings = [];
  const lib = new CustomLayouts({ file, log: { warn: (m) => warnings.push(m) } }).load();
  assert.deepEqual(lib.get().layouts.map((l) => l.name), ['Good']);
  assert.equal(warnings.length, 1);

  fs.writeFileSync(file, '{ not json');
  new CustomLayouts({ file, log: { warn() {} } }).load();
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{ not json');
});

test('a layout that cannot be written to disk is reported, not shown as saved', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, '');
  const lib = new CustomLayouts({ file: path.join(blocker, 'custom-layout.json'), log: { warn() {} } });
  assert.throws(() => lib.save('FOH', [{ name: 'A', tx: [1] }]), /could not be written to disk/);
  assert.ok(lib.find('FOH'), 'still usable until the bridge restarts');
});

test('renames are announced so other screens follow; state changes from another website are refused', async (t) => {
  const customLayouts = new CustomLayouts();
  const web = createWebServer({ engine: fakeEngine(), customLayouts, version: 'test', log: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  t.after(() => web.close());
  const { port } = web.server.address();

  const renamed = [];
  customLayouts.on('renamed', (from, to) => renamed.push([from, to]));
  customLayouts.create('FOH', []);
  customLayouts.rename('FOH', 'FOH v2');
  assert.deepEqual(renamed, [['FOH', 'FOH v2']]);

  const post = (headers) => fetch(`http://127.0.0.1:${port}/api/events/clear`, { method: 'POST', headers }).then((r) => r.status);
  assert.equal(await post({}), 200, 'non-browser clients (e.g. Companion)');
  assert.equal(await post({ Origin: `http://127.0.0.1:${port}` }), 200, 'the bridge\'s own pages');
  assert.equal(await post({ Origin: 'http://evil.example' }), 403);
  const get = (headers) => fetch(`http://127.0.0.1:${port}/api/refresh`, { headers }).then((r) => r.status);
  assert.equal(await get({ 'Sec-Fetch-Site': 'cross-site' }), 403, 'an <img> on another site');
  assert.equal(await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: 'http://evil.example' } }).then((r) => r.status), 200, 'reads stay open');

  const bad = await fetch(`http://127.0.0.1:${port}/api/interface`, { method: 'POST', body: 'null' });
  assert.equal(bad.status, 400);
});

test('a rejected WebSocket upgrade that is then reset does not crash the bridge', async (t) => {
  const web = createWebServer({ engine: fakeEngine(), customLayouts: new CustomLayouts(), version: 'test', log: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  t.after(() => web.close());
  const { port } = web.server.address();
  let serverSocket;
  web.server.prependListener('upgrade', (req, socket) => (serverSocket = socket));
  const net = require('net');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => sock.once('connect', resolve));
  sock.write('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await new Promise((resolve) => sock.once('data', resolve));
  assert.ok(serverSocket.listenerCount('error') > 0, 'an error on the rejected socket is handled');
  serverSocket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  sock.destroy();
});
