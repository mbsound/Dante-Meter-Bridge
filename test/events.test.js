'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NetworkMonitor } = require('../lib/events/monitor');
const { EventLog } = require('../lib/events/event-log');
const { CATEGORIES, EVENT_TYPES } = require('../lib/events/catalog');

const IFACE = { name: 'en6', address: '169.254.9.1', netmask: '255.255.0.0' };

function device(overrides = {}) {
  return {
    ip: '169.254.1.10',
    name: 'Stagebox-1',
    hasName: true,
    online: true,
    lastSeen: 0,
    lastArcReplyAt: null,
    sampleRate: 48000,
    clock: null,
    clockOffsetPpb: null,
    latePackets: null,
    numPorts: 2,
    secondaryLinkUp: true,
    secondaryIp: null,
    rx: [],
    ...overrides
  };
}

/** A monitor fed by a mutable fake snapshot. */
function harness(devices = [device()], leaders = []) {
  const snap = { iface: IFACE, leaders, devices };
  const eventLog = new EventLog({ dir: null });
  const monitor = new NetworkMonitor({ engine: { getMonitorSnapshot: () => snap }, eventLog });
  let t = 1000000;
  return {
    snap,
    eventLog,
    tick(ms = 1000) {
      t += ms;
      const before = eventLog.events.length;
      monitor.check(t);
      return eventLog.events.slice(before);
    },
    monitor
  };
}

const types = (events) => events.map((e) => e.type);

test('catalog: every event type belongs to a known category', () => {
  const ids = new Set(CATEGORIES.map((c) => c.id));
  for (const [type, def] of Object.entries(EVENT_TYPES)) assert.ok(ids.has(def.category), type);
});

test('a healthy device is announced once, with no other noise', () => {
  const h = harness();
  assert.deepEqual(types(h.tick()), ['device_online']);
  assert.equal(h.eventLog.events[0].message, 'Discovered on the network');
  assert.deepEqual(h.tick(), []);
  assert.deepEqual(h.tick(), []);
});

test('waits briefly for the device name before announcing it', () => {
  const dev = device({ name: '169.254.1.10', hasName: false });
  const h = harness([dev]);
  assert.deepEqual(h.tick(), []);
  dev.name = 'Stagebox-1';
  dev.hasName = true;
  const [online] = h.tick();
  assert.equal(online.device, 'Stagebox-1');
});

test('offline, then back online with the outage duration', () => {
  const dev = device();
  const h = harness([dev]);
  h.tick();
  dev.online = false;
  dev.lastSeen = 1000000;
  const [offline] = h.tick();
  assert.equal(offline.type, 'device_offline');
  assert.equal(offline.severity, 'error');

  // Removed from the engine while offline, then returns 2.5 minutes later.
  h.snap.devices = [];
  h.tick(60000);
  h.snap.devices = [device()];
  const [back] = h.tick(90000);
  assert.equal(back.type, 'device_online');
  assert.match(back.message, /Back online after 2 min 3\d s/);
});

test('an interface change does not log every device as offline', () => {
  const h = harness();
  h.tick();
  h.monitor.onInterface({ boundIp: '169.254.9.1', name: 'en6' });
  h.snap.devices = [];
  assert.deepEqual(types(h.tick()), []);
  assert.equal(h.eventLog.events.at(-1).type, 'monitoring_started');
});

test('clock: unlocked, syncing is not logged, locked again', () => {
  const dev = device({ clock: { servo: 3 } });
  const h = harness([dev]);
  h.tick();
  dev.clock = { servo: 1 };
  assert.deepEqual(types(h.tick()), ['clock_unlocked']);
  dev.clock = { servo: 2 };
  assert.deepEqual(h.tick(), []);
  dev.clock = { servo: 3 };
  assert.deepEqual(types(h.tick()), ['clock_locked']);
  assert.deepEqual(h.tick(), []);
});

test('clock: a device already out of sync is reported on first sight', () => {
  const h = harness([device({ clock: { servo: 0 } })]);
  assert.deepEqual(types(h.tick()), ['device_online', 'clock_unlocked']);
});

test('clock warning when the frequency offset nears the device limit', () => {
  const dev = device({ clock: { servo: 3, maxDriftPpb: 100000 }, clockOffsetPpb: 10000 });
  const h = harness([dev]);
  h.tick();
  dev.clockOffsetPpb = -85000;
  const [warn] = h.tick();
  assert.equal(warn.type, 'clock_warning');
  assert.match(warn.message, /-85\.0 ppm, 85% of its 100 ppm limit/);
  dev.clockOffsetPpb = -70000; // above the clear threshold: no repeat
  assert.deepEqual(h.tick(), []);
});

test('audio mute and unmute, with reasons', () => {
  const dev = device({ clock: { servo: 3, muteFlags: 0 } });
  const h = harness([dev]);
  h.tick();
  dev.clock = { servo: 3, muteFlags: 1 | 16 };
  const [mute] = h.tick();
  assert.equal(mute.type, 'audio_mute');
  assert.equal(mute.message, 'Muted: synchronization loss, user mute');
  dev.clock = { servo: 3, muteFlags: 0 };
  assert.deepEqual(types(h.tick()), ['audio_unmute']);
});

test('clock leader: first sight, change, and multiple leaders', () => {
  const h = harness([device()], ['Stagebox-1']);
  const first = h.tick().find((e) => e.type === 'leader_elevated');
  assert.equal(first.severity, 'info');
  h.snap.leaders = ['Console'];
  assert.deepEqual(types(h.tick()), ['leader_elevated', 'leader_demoted']);
  h.snap.leaders = ['Console', 'Stagebox-1'];
  assert.deepEqual(types(h.tick()), ['leader_elevated', 'multiple_leaders']);
  assert.deepEqual(h.tick(), []);
});

function rx(number, overrides) {
  return { number, name: `In ${number}`, subscribedDevice: 'Mic-Rx', subscribedChannel: `0${number}`, status: 9, rxStatus: 0, ...overrides };
}

test('subscriptions: grouped failure, restoration and routing change', () => {
  const dev = device({ rx: [rx(1), rx(2), rx(3)] });
  const h = harness([dev]);
  h.tick();

  // The transmitter disappears: all three channels go unresolved at once.
  dev.rx = [rx(1, { status: 1 }), rx(2, { status: 1 }), rx(3, { status: 1 })];
  const [failed] = h.tick();
  assert.equal(failed.type, 'subscription_unresolved');
  assert.equal(failed.title, 'Resolution failed');
  assert.equal(failed.message, 'channels 1 (In 1), 2 (In 2), 3 (In 3): Unresolved (Mic-Rx / 01, 02, 03)');
  assert.deepEqual(failed.details.channels.map((c) => c.number), [1, 2, 3]);

  // In progress while re-resolving: nothing logged; then restored.
  dev.rx = [rx(1, { status: 8 }), rx(2, { status: 8 }), rx(3, { status: 8 })];
  assert.deepEqual(h.tick(), []);
  dev.rx = [rx(1), rx(2), rx(3)];
  assert.deepEqual(types(h.tick()), ['subscription_restored']);

  // Someone re-patches channel 2.
  dev.rx = [rx(1), rx(2, { subscribedDevice: 'Console', subscribedChannel: '07' }), rx(3)];
  const [changed] = h.tick();
  assert.equal(changed.type, 'routing_changed');
  assert.equal(changed.message, 'channel 2 (In 2): now Console / 07 (was Mic-Rx / 02)');
});

test('subscriptions: status 1 with a live flow counts as connected', () => {
  const h = harness([device({ rx: [rx(1, { status: 1, rxStatus: 0x0101 })] })]);
  assert.deepEqual(types(h.tick()), ['device_online']);
});

test('subscriptions: other errors are logged as subscription errors', () => {
  const h = harness([device({ rx: [rx(1, { status: 37 })] })]);
  const failed = h.tick().find((e) => e.type === 'subscription_failed');
  assert.match(failed.message, /Fanout Limit Reached/);
});

test('network: subnet mismatch and conflict, secondary link', () => {
  const dev = device({ ip: '10.0.0.5', secondaryIp: '172.31.0.6' });
  const h = harness([dev]);
  assert.deepEqual(types(h.tick()), ['device_online', 'subnet_mismatch']);

  const h2 = harness([device({ secondaryIp: '169.254.1.11' })]);
  assert.ok(types(h2.tick()).includes('subnet_conflict'));

  const d3 = device();
  const h3 = harness([d3]);
  h3.tick();
  d3.secondaryLinkUp = false;
  assert.deepEqual(types(h3.tick()), ['secondary_link_down']);
  d3.secondaryLinkUp = true;
  assert.deepEqual(types(h3.tick()), ['secondary_link_up']);
});

test('late packets are accumulated and logged at most every 30 s', () => {
  const dev = device({ latePackets: 100 });
  const h = harness([dev]);
  h.tick(); // baseline, nothing logged
  dev.latePackets = 103;
  const [late] = h.tick();
  assert.equal(late.message, '3 late packets received');
  dev.latePackets = 110;
  assert.deepEqual(h.tick(), [], 'throttled');
  dev.latePackets = 111;
  const [next] = h.tick(30000);
  assert.equal(next.message, '8 late packets received');
});

test('response timeout while still on the network, then recovery', () => {
  const dev = device({ lastArcReplyAt: 1000000 });
  const h = harness([dev]);
  h.tick();
  assert.deepEqual(types(h.tick(11000)), ['response_timeout']);
  dev.lastArcReplyAt = 1013000;
  assert.deepEqual(types(h.tick()), ['response_restored']);
});

test('rename and sample rate change', () => {
  const dev = device();
  const h = harness([dev]);
  h.tick();
  dev.name = 'Stagebox-A';
  dev.sampleRate = 96000;
  const events = h.tick();
  assert.deepEqual(types(events), ['device_renamed', 'sample_rate_changed']);
  assert.equal(events[0].message, 'Renamed from "Stagebox-1" to "Stagebox-A"');
  assert.equal(events[1].message, '48 kHz -> 96 kHz');
});

test('event log: persistence, reload, query, retention and CSV', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();

  // An expired file is pruned on load.
  fs.writeFileSync(path.join(dir, 'dante-events-2000-01-01.jsonl'), '{"id":1,"time":1,"type":"device_online"}\n');

  const log = new EventLog({ dir, retentionDays: 30 });
  log.load(now);
  assert.ok(!fs.existsSync(path.join(dir, 'dante-events-2000-01-01.jsonl')));

  log.add('device_online', { device: 'Box', ip: '169.254.1.1', message: 'Discovered on the network', time: now });
  log.add('device_offline', { device: 'Box', ip: '169.254.1.1', message: 'No response for 7 s', time: now + 1 });
  log.add('clock_unlocked', { device: 'Mic, "A"', message: 'Lost sync', time: now + 2 });
  await log.flush();

  const reloaded = new EventLog({ dir });
  reloaded.load(now);
  assert.equal(reloaded.events.length, 3);
  assert.equal(reloaded.nextId, 4);

  assert.deepEqual(reloaded.query({ categories: ['online', 'offline'] }).map((e) => e.type), ['device_online', 'device_offline']);
  assert.deepEqual(reloaded.query({ severities: ['error'] }).map((e) => e.type), ['device_offline', 'clock_unlocked']);

  const csv = EventLog.toCsv(reloaded.events);
  assert.match(csv, /^Time,Severity,Category,Event,Device,IP,Message\r\n/);
  assert.match(csv, /"Mic, ""A"""/);
});
