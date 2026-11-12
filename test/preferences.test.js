'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Preferences, PreferenceError } = require('../lib/preferences');
const { createWebServer } = require('../lib/web/server');

const quiet = { info() {}, warn() {}, error() {} };
const fakeEngine = () => ({
  on() {},
  getDevices: () => [],
  getHealth: () => ({}),
  interfaceInfo: () => ({}),
  getNetworkStatus: () => ({ summary: { devices: 0, online: 0, offline: 0 }, devices: [] })
});

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'preferences.json');
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function start(t, preferences) {
  const web = createWebServer({ engine: fakeEngine(), preferences, host: '127.0.0.1', version: 'test', log: quiet });
  t.after(() => web.close());
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${web.server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/api/preferences`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { web, base, post };
}

test('preferences default to the feed on, are validated and survive a restart', (t) => {
  const file = tmpFile(t);
  const prefs = new Preferences({ file, log: quiet }).load();
  assert.deepEqual(prefs.get(), { statusApi: { enabled: true, port: null } });

  for (const bad of [{ statusApi: { port: 0 } }, { statusApi: { port: 70000 } }, { statusApi: { port: 'abc' } }, { statusApi: { enabled: 'yes' } }, { statusApi: 5 }, []]) {
    assert.throws(() => prefs.update(bad), PreferenceError);
  }
  assert.deepEqual(prefs.get(), { statusApi: { enabled: true, port: null } });

  let changes = 0;
  prefs.on('changed', () => changes++);
  prefs.update({ statusApi: { port: '8080' } });
  prefs.update({ statusApi: { port: 8080 } }); // no change, no event
  prefs.update({ statusApi: { enabled: false } });
  assert.equal(changes, 2);
  assert.deepEqual(new Preferences({ file, log: quiet }).load().get(), { statusApi: { enabled: false, port: 8080 } });

  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new Preferences({ file, log: quiet }).load().get(), { statusApi: { enabled: true, port: null } });
});

test('switching the status feed off makes it answer 404', async (t) => {
  const { base, post } = await start(t, new Preferences());
  assert.equal((await fetch(`${base}/api/network-status`)).status, 200);

  const off = await post({ statusApi: { enabled: false } });
  assert.equal(off.status, 200);
  assert.deepEqual((await off.json()).statusApi.urls, []);
  assert.equal((await fetch(`${base}/api/network-status`)).status, 404);

  await post({ statusApi: { enabled: true } });
  assert.equal((await fetch(`${base}/api/network-status`)).status, 200);
});

test('preferences cannot be changed by another website, and bad values are refused', async (t) => {
  const prefs = new Preferences();
  const { post } = await start(t, prefs);
  assert.equal((await post({ statusApi: { enabled: false } }, { Origin: 'https://example.com' })).status, 403);
  const bad = await post({ statusApi: { port: 99999 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /1 to 65535/);
  assert.deepEqual(prefs.get(), { statusApi: { enabled: true, port: null } });
});

test('a declared port serves only the status feed, and follows the setting', async (t) => {
  const { base, post } = await start(t, new Preferences());
  const port = await freePort();
  const own = `http://127.0.0.1:${port}`;
  const reachable = () => fetch(`${own}/api/network-status`).then((r) => r.status === 200, () => false);

  await post({ statusApi: { port } });
  assert.ok(await until(reachable), 'the extra port answers');
  assert.equal((await fetch(`${own}/api/devices`)).status, 404);
  assert.equal((await fetch(`${own}/`)).status, 404);
  assert.equal((await fetch(`${own}/api/preferences`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/network-status`)).status, 200, 'still on the web UI port');

  const state = await fetch(`${base}/api/preferences`).then((r) => r.json());
  assert.equal(state.statusApi.listeningPort, port);
  assert.ok(state.statusApi.urls.includes(`${own}/api/network-status`));

  await post({ statusApi: { enabled: false } });
  assert.ok(await until(async () => !(await reachable())), 'the extra port closes when the feed is off');

  await post({ statusApi: { enabled: true, port: null } });
  assert.equal(await reachable(), false);
  assert.equal((await fetch(`${base}/api/network-status`)).status, 200);
});

test('a port that is already taken is reported instead of crashing', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const { base, post } = await start(t, new Preferences());

  await post({ statusApi: { port: blocker.address().port } });
  let state;
  assert.ok(await until(async () => (state = await fetch(`${base}/api/preferences`).then((r) => r.json())).statusApi.error));
  assert.match(state.statusApi.error, /already used/);
  assert.equal(state.statusApi.listeningPort, null);
  assert.equal((await fetch(`${base}/api/network-status`)).status, 200);
});
