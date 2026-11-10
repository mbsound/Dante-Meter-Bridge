'use strict';

/**
 * Engine behaviour with simulated device packets (no real sockets).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DanteEngine, TIMING } = require('../lib/dante/engine');
const { IdentityResolver, DanteDatabase } = require('../lib/dante/identity');
const { ARC_COMMANDS } = require('../lib/dante/constants');

function makeEngine({ overrides = {}, dbEntries = [] } = {}) {
  const database = new DanteDatabase([]);
  database.refresh = () => dbEntries;
  const engine = new DanteEngine({ identity: new IdentityResolver({ overrides, database }) });
  engine.sent = [];
  engine.send = (sock, buf, port, host) => engine.sent.push({ sock, port, host, buf });
  return engine;
}

const from = (address) => ({ address, port: 4440 });

function arcReply(commandId, size) {
  const buf = Buffer.alloc(size);
  buf.writeUInt16BE(0x2729, 0);
  buf.writeUInt16BE(commandId, 6);
  return buf;
}

function nameReply(name) {
  return Buffer.concat([arcReply(ARC_COMMANDS.DEVICE_NAME, 10), Buffer.from(name + '\0')]);
}

function countsReply(tx, rx) {
  const buf = arcReply(ARC_COMMANDS.CHANNEL_COUNTS, 16);
  buf[13] = tx;
  buf[15] = rx;
  return buf;
}

function txNamesReply(names) {
  const strings = [];
  const buf = arcReply(ARC_COMMANDS.TX_FRIENDLY_NAMES, 12 + 6 * names.length);
  buf[11] = names.length;
  let offset = buf.length;
  names.forEach((name, i) => {
    buf.writeUInt16BE(i + 1, 12 + 6 * i + 2);
    buf.writeUInt16BE(offset, 12 + 6 * i + 4);
    strings.push(Buffer.from(name + '\0'));
    offset += name.length + 1;
  });
  return Buffer.concat([buf, ...strings]);
}

function rxReply(subs) {
  const buf = arcReply(ARC_COMMANDS.RX_CHANNELS, 12 + 20 * subs.length);
  buf[11] = subs.length;
  const strings = [];
  let offset = buf.length;
  const str = (s) => {
    const at = offset;
    strings.push(Buffer.from(s + '\0'));
    offset += s.length + 1;
    return at;
  };
  subs.forEach((s, i) => {
    const rec = 12 + 20 * i;
    buf.writeUInt16BE(i + 1, rec);
    buf.writeUInt16BE(str(s.txChannel), rec + 6);
    buf.writeUInt16BE(str(s.txDevice), rec + 8);
    buf.writeUInt16BE(str(s.name), rec + 10);
    buf.writeUInt16BE(s.status, rec + 14);
  });
  return Buffer.concat([buf, ...strings]);
}

function meterPacket(tx, rx) {
  const buf = Buffer.concat([Buffer.alloc(16), Buffer.from('Audinate'), Buffer.from([2, tx.length, rx.length, ...tx, ...rx])]);
  buf.writeUInt16BE(0xffff, 0);
  buf.writeUInt16BE(buf.length, 2);
  return buf;
}

test('discovers a device over ARC and polls it', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.handleArc(countsReply(4, 2), from('169.254.1.10'));
  engine.handleArc(txNamesReply(['Kick', 'Snare', '', 'Hat']), from('169.254.1.10'));

  const [dev] = engine.getDevices();
  assert.equal(dev.name, 'Stagebox-1');
  assert.equal(dev.online, true);
  assert.equal(dev.tx.count, 4);
  assert.deepEqual(
    Object.values(dev.tx.channels).map((c) => c.name),
    ['Kick', 'Snare', 'Tx 3', 'Hat']
  );
});

test('subscribes to metering directly on the device (no Dante Controller needed)', () => {
  const engine = makeEngine();
  engine.iface = { name: 'en0', address: '169.254.9.1', netmask: '255.255.0.0' };
  engine.boundMac = Buffer.from('a1b2c3d4e5f6', 'hex');
  engine.meteringPort = 8751;
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));

  const req = engine.sent.find((s) => s.sock === 'CMC' && s.buf.readUInt16BE(6) === 0x3010);
  assert.ok(req, 'metering request sent');
  assert.equal(req.host, '169.254.1.10');
  assert.equal(req.port, 8800);
  assert.ok(req.buf.includes(Buffer.from('Stagebox-1\0')));
  assert.ok(req.buf.includes(Buffer.from([169, 254, 9, 1, 0x22, 0x2f])), 'destination is our IP:port');

  engine.sent = [];
  engine.stopAllMetering();
  const stop = engine.sent.find((s) => s.sock === 'CMC');
  assert.ok(stop.buf.subarray(-16).every((b) => b === 0), 'unsubscribe clears the destination');
});

test('clock leader is found from the grandmaster ID even if it never answers clock queries', () => {
  const engine = makeEngine();
  engine.handleArc(countsReply(1, 1), from('169.254.1.10'));
  engine.handleArc(countsReply(1, 1), from('169.254.1.11'));
  engine.devices.get('169.254.1.10').clock = { isMaster: false, uuid: 'bb00', grandmasterUuid: '000edd0000020000', servo: 3 };
  engine.devices.get('169.254.1.11').mac = '000edd000002';
  assert.deepEqual(engine.getDevices().map((d) => d.isClockLeader), [false, true]);
});

test('rejects implausible device names', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('<script>'), from('169.254.1.11'));
  assert.equal(engine.getDevices()[0].name, '169.254.1.11');
});

test('native meters are reported per channel and go stale', () => {
  const engine = makeEngine();
  engine.handleArc(countsReply(2, 1), from('169.254.1.10'));
  engine.handleMetering(meterPacket([10, 0], [254]), from('169.254.1.10'));

  const now = Date.now();
  assert.deepEqual(engine.getMeterFrame(now)['169.254.1.10'], { tx: [10, 0], rx: [254] });
  assert.deepEqual(engine.getMeterFrame(now + TIMING.METER_STALE_AFTER + 1)['169.254.1.10'], {
    tx: [null, null],
    rx: [null]
  });
});

test('receiver without its own meters mirrors the connected transmitter', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.handleArc(countsReply(2, 0), from('169.254.1.10'));
  engine.handleArc(txNamesReply(['Kick', 'Snare']), from('169.254.1.10'));
  engine.handleMetering(meterPacket([40, 60], []), from('169.254.1.10'));

  engine.handleArc(nameReply('Console'), from('169.254.1.20'));
  engine.handleArc(countsReply(0, 2), from('169.254.1.20'));
  engine.handleArc(
    rxReply([
      { name: 'In 1', txDevice: 'stagebox-1', txChannel: 'Snare', status: 9 },
      { name: 'In 2', txDevice: 'Stagebox-1', txChannel: 'Kick', status: 1 } // unresolved
    ]),
    from('169.254.1.20')
  );

  const frame = engine.getMeterFrame();
  assert.deepEqual(frame['169.254.1.20'], { tx: [], rx: [60, null], mirrored: { tx: [], rx: [1] } });
  const rx = engine.getDevices().find((d) => d.name === 'Console').rx.channels;
  assert.equal(rx[1].connected, true);
  assert.equal(rx[2].connected, false);
});

test('devices go offline, then are removed', () => {
  const engine = makeEngine();
  engine.handleArc(countsReply(1, 1), from('169.254.1.10'));
  const dev = engine.devices.get('169.254.1.10');

  dev.lastSeen = Date.now() - TIMING.OFFLINE_AFTER - 1;
  const [snap] = engine.getDevices();
  assert.equal(snap.online, false);
  assert.equal(snap.primarySync, 'error');
  assert.equal(engine.getMeterFrame()['169.254.1.10'], undefined);

  dev.lastSeen = Date.now() - TIMING.REMOVE_AFTER - 1;
  engine.iface = null;
  engine.discoveryTick();
  assert.equal(engine.devices.size, 0);
});

test('clock leader only comes from real clock data (no guessing)', () => {
  const engine = makeEngine();
  engine.handleArc(countsReply(1, 1), from('169.254.1.10'));
  engine.handleArc(countsReply(1, 1), from('169.254.1.11'));
  assert.deepEqual(engine.getDevices().map((d) => d.isClockLeader), [false, false]);
  assert.deepEqual(engine.getDevices().map((d) => d.primarySync), ['none', 'none']);

  engine.devices.get('169.254.1.11').clock = { isMaster: true, uuid: 'aa', grandmasterUuid: 'aa', servo: 3, numPorts: 2 };
  engine.devices.get('169.254.1.10').clock = { isMaster: false, uuid: 'bb', grandmasterUuid: 'aa', servo: 3, numPorts: 2 };
  const devs = engine.getDevices();
  assert.deepEqual(devs.map((d) => d.isClockLeader), [false, true]);
  assert.deepEqual(devs.map((d) => d.primarySync), ['good', 'good']);
});

test('secondary clock leaders come from the secondary port state, online devices only', () => {
  const engine = makeEngine();
  for (const ip of ['169.254.1.10', '169.254.1.11', '169.254.1.12']) engine.handleArc(countsReply(1, 1), from(ip));
  const clock = (uuid, portStates) => ({ isMaster: uuid === 'aa', uuid, grandmasterUuid: 'aa', servo: 3, numPorts: 2, portStates });
  engine.devices.get('169.254.1.10').clock = clock('aa', [6, 6]);
  engine.devices.get('169.254.1.11').clock = clock('bb', [9, 7]);
  engine.devices.get('169.254.1.12').clock = clock('cc', [9, 6]);
  let devs = engine.getDevices();
  assert.deepEqual(devs.map((d) => d.isClockLeader), [true, false, false]);
  assert.deepEqual(devs.map((d) => d.isSecondaryClockLeader), [true, false, true]);
  assert.deepEqual(engine.getMonitorSnapshot().secondaryLeaders.length, 2);

  engine.devices.get('169.254.1.12').secondaryLinkUp = false;
  assert.deepEqual(engine.getDevices().map((d) => d.isSecondaryClockLeader), [true, false, false], 'a port with no link is not a leader');
  engine.devices.get('169.254.1.12').secondaryLinkUp = null;
  engine.devices.get('169.254.1.12').lastSeen = Date.now() - 30000;
  assert.deepEqual(engine.getDevices().map((d) => d.isSecondaryClockLeader), [true, false, false], 'nor is an offline device');
});

test('identity comes from local overrides, then the Dante Controller database', () => {
  const engine = makeEngine({
    overrides: { 'stagebox-1': { manufacturer: 'Override Co', modelName: 'Custom' } },
    dbEntries: [
      {
        mf: 'acme',
        model: 'sb16',
        identity: { manufacturer: 'ACME', modelName: 'SB-16', productVersion: '1.2.3', softwareVersion: null, firmwareVersion: null }
      }
    ]
  });
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.handleArc(nameReply('Stagebox-2'), from('169.254.1.12'));
  engine.devices.get('169.254.1.12').mdnsMf = 'ACME';
  engine.devices.get('169.254.1.12').mdnsModel = 'SB16';
  engine.identity.resolve(engine.devices.get('169.254.1.12'));

  const [a, b] = engine.getDevices();
  assert.equal(a.manufacturer, 'Override Co');
  assert.equal(a.modelName, 'Custom');
  assert.equal(b.manufacturer, 'ACME');
  assert.equal(b.productVersion, '1.2.3');
});

test('a malformed packet never throws out of a handler', () => {
  const engine = makeEngine();
  for (const handler of ['handleArc', 'handleSettings', 'handleCmc', 'handleHeartbeat', 'handleMetering', 'handleMdns']) {
    for (const buf of [Buffer.alloc(0), Buffer.from([0x27, 0x29]), Buffer.alloc(200, 0xff)]) {
      assert.doesNotThrow(() => engine[handler](buf, from('169.254.9.9')), handler);
    }
  }
});

// ---------------------------------------------------------------------------
// mDNS: relayed answers (e.g. a PC's own responder caching other devices)
// ---------------------------------------------------------------------------

const mdnsLib = require('../lib/dante/mdns');

function mdnsRecord(name, type, rdata) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([mdnsLib.encodeName(name), fixed, rdata]);
}

/** A Dante ARC advertisement for `name`, with or without an address record. */
function advert(name, { port = 4440, address = null, model = 'SB16', txt = null } = {}) {
  const instance = `${name}._netaudio-arc._udp.local`;
  const host = `${name.toLowerCase()}.local`;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 0xff]), mdnsLib.encodeName(host)]);
  const txtData = Buffer.concat((txt || [`model=${model}`]).map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)])));
  const records = [
    mdnsRecord('_netaudio-arc._udp.local', mdnsLib.TYPE.PTR, mdnsLib.encodeName(instance)),
    mdnsRecord(instance, mdnsLib.TYPE.SRV, srv),
    mdnsRecord(instance, mdnsLib.TYPE.TXT, txtData)
  ];
  if (address) records.push(mdnsRecord(host, mdnsLib.TYPE.A, Buffer.from(address.split('.').map(Number))));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}

test('a device announcing itself (with its address) is registered with its name and ports', () => {
  const engine = makeEngine();
  engine.handleMdns(advert('Stagebox-1', { port: 4455, address: '169.254.1.10' }), { address: '169.254.1.10' });
  const dev = engine.devices.get('169.254.1.10');
  assert.equal(dev.name, 'Stagebox-1');
  assert.equal(dev.ports.ARC, 4455);
  assert.equal(dev.arcPortAdvertised, true);
});

test('relayed answers never rename the relaying PC or move ports onto it (DVS name swap)', () => {
  const engine = makeEngine();
  // Real hardware and a PC running Dante Virtual Soundcard, both named by their own ARC replies.
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.handleArc(nameReply('DVS-PC'), { address: '169.254.1.50', port: 14440 });
  const dvs = engine.devices.get('169.254.1.50');
  assert.equal(dvs.ports.ARC, 14440, 'port learned from the reply');

  // The PC's mDNS responder relays the hardware's advertisement (no address record).
  engine.handleMdns(advert('Stagebox-1', { port: 4440, model: 'SB16' }), { address: '169.254.1.50' });

  assert.equal(dvs.name, 'DVS-PC', 'not renamed');
  assert.equal(dvs.ports.ARC, 14440, 'ports untouched');
  const hw = engine.devices.get('169.254.1.10');
  assert.equal(hw.name, 'Stagebox-1');
  assert.equal(hw.mdnsModel, 'SB16', 'relayed data applied to the device it describes');
});

test('an unknown relayed instance triggers a direct lookup instead of a registration', () => {
  const engine = makeEngine();
  engine.handleMdns(advert('Mystery-Box'), { address: '169.254.1.50' });
  assert.equal(engine.devices.size, 0);
  const lookup = engine.sent.find((s) => s.sock === 'MDNS');
  assert.ok(lookup.buf.includes(mdnsLib.encodeName('Mystery-Box._netaudio-arc._udp.local')));
  assert.equal(lookup.buf.readUInt16BE(12 + mdnsLib.encodeName('Mystery-Box._netaudio-arc._udp.local').length), mdnsLib.TYPE.SRV);
});

test("a device's own name wins over mDNS, and a name can't be claimed twice", () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.handleMdns(advert('Old-Name', { address: '169.254.1.10' }), { address: '169.254.1.10' });
  assert.equal(engine.devices.get('169.254.1.10').name, 'Stagebox-1');

  engine.handleMdns(advert('Stagebox-1', { address: '169.254.1.60' }), { address: '169.254.1.60' });
  assert.notEqual(engine.devices.get('169.254.1.60').name, 'Stagebox-1');
});

// ---------------------------------------------------------------------------
// Devices that only answer some ARC protocol IDs / ports (e.g. DVS)
// ---------------------------------------------------------------------------

test('until a device answers, polls cycle ARC protocol 0x2729/0x27FF/0x2809 and ports 4440/4455', () => {
  const engine = makeEngine();
  const dev = engine.register('169.254.1.50');
  engine.sent = [];
  const targets = [];
  for (let i = 0; i < 6; i++) {
    engine.sent = [];
    engine.pollDevice('169.254.1.50');
    const arc = engine.sent.find((s) => s.sock === 'ARC');
    targets.push(`${arc.buf.readUInt16BE(0).toString(16)}@${arc.port}`);
  }
  assert.deepEqual(new Set(targets), new Set(['2729@4440', '27ff@4440', '2809@4440', '2729@4455', '27ff@4455', '2809@4455']));

  // It answers on 4455 with 0x27FF: from then on, only that is used.
  const reply = nameReply('DVS-PC');
  reply.writeUInt16BE(0x27ff, 0);
  engine.handleArc(reply, { address: '169.254.1.50', port: 4455 });
  engine.sent = [];
  engine.pollDevice('169.254.1.50');
  const used = new Set(engine.sent.filter((s) => s.sock === 'ARC').map((s) => `${s.buf.readUInt16BE(0).toString(16)}@${s.port}`));
  assert.deepEqual([...used], ['27ff@4455']);
  assert.equal(dev.name, 'DVS-PC');
});

test('CMC requests go to both the standard and DVS ports until one answers', () => {
  const engine = makeEngine();
  engine.register('169.254.1.50');
  engine.sent = [];
  engine.querySettingsPort('169.254.1.50');
  assert.deepEqual(engine.sent.filter((s) => s.sock === 'CMC').map((s) => s.port), [8800, 38800]);

  const cmc = Buffer.alloc(30);
  cmc.writeUInt16BE(0x1200, 0);
  cmc.writeUInt16BE(0x1001, 6);
  cmc.writeUInt16BE(38700, 28);
  engine.handleCmc(cmc, { address: '169.254.1.50', port: 38800 });
  engine.sent = [];
  engine.querySettingsPort('169.254.1.50');
  assert.deepEqual(engine.sent.filter((s) => s.sock === 'CMC').map((s) => s.port), [38800]);
  assert.equal(engine.devices.get('169.254.1.50').ports.SETTINGS, 38700);
});

test('health: devices answering but no heartbeats is reported as blocked multicast', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  const now = Date.now();
  assert.equal(engine.getHealth(now).multicastBlocked, false, 'grace period');
  assert.equal(engine.getHealth(now + 25000).multicastBlocked, false, 'device itself is offline by then');
  engine.devices.get('169.254.1.10').lastSeen = now + 25000;
  assert.equal(engine.getHealth(now + 25000).multicastBlocked, true);
  engine.stats.lastHeartbeatAt = now + 24000;
  assert.equal(engine.getHealth(now + 25000).multicastBlocked, false);
});

// ---------------------------------------------------------------------------
// Modern ARC devices (e.g. Dante Virtual Soundcard 4.x, arcp_vers=2.8.9)
// ---------------------------------------------------------------------------

/** Build a 0x2400 / 0x3400 page the way a modern device lays it out. */
function statusPage({ rx = false, result = 1, channels }) {
  const recSize = rx ? 56 : 40;
  const table = 18 + channels.length * 2;
  const recordsAt = table;
  const fmtAt = recordsAt + channels.length * recSize;
  const parts = [];
  let strAt = fmtAt + 16;
  const strings = [];
  const str = (v) => {
    if (!v) return 0;
    const at = strAt;
    strings.push(Buffer.from(v + '\0'));
    strAt += v.length + 1;
    return at;
  };
  const head = Buffer.alloc(table);
  head.writeUInt16BE(0x2809, 0);
  head.writeUInt16BE(rx ? 0x3400 : 0x2400, 6);
  head.writeUInt16BE(result, 8);
  head[16] = 32;
  head[17] = channels.length;
  channels.forEach((ch, i) => {
    const rec = Buffer.alloc(recSize);
    rec.writeUInt16BE(rx ? 0x141c : 0x1414, 0);
    rec.writeUInt16BE(ch.number, 2);
    rec.writeUInt16BE(3, 6);
    rec.writeUInt16BE(ch.number, 8);
    rec.writeUInt16BE(str(ch.name), 20);
    rec.writeUInt16BE(fmtAt, 22);
    rec.writeUInt16BE(str(`${rx ? 'Rx' : 'Tx'}-${ch.number}`), 30);
    if (rx) {
      rec.writeUInt16BE(str(ch.txChannel), 44);
      rec.writeUInt16BE(str(ch.txDevice), 46);
      rec.writeUInt16BE(ch.status || 0, 48);
    }
    head.writeUInt16BE(recordsAt + i * recSize, 18 + i * 2);
    parts.push(rec);
  });
  const fmt = Buffer.alloc(16);
  fmt.writeUInt32BE(48000, 0);
  fmt.writeUInt16BE(0x18, 6);
  const buf = Buffer.concat([head, ...parts, fmt, ...strings]);
  buf.writeUInt16BE(buf.length, 2);
  return buf;
}

function modernAdvert(name, address, version = '2.8.9') {
  return advert(name, { address, txt: [`arcp_vers=${version}`, 'mf=Audinate', 'model=DvsMacOs'] });
}

test('a device advertising arcp_vers 2.8.9 is queried with modern ARC 0x2809 and the paged inventory', () => {
  const engine = makeEngine();
  engine.handleMdns(modernAdvert('DVS-Mac', '169.254.1.70'), { address: '169.254.1.70' });
  const dev = engine.devices.get('169.254.1.70');
  assert.equal(dev.arcAdvertised, 0x2809);

  engine.sent = [];
  engine.pollDevice('169.254.1.70');
  const arc = engine.sent.filter((s) => s.sock === 'ARC');
  const opcodes = arc.map((s) => `${s.buf.readUInt16BE(0).toString(16)}:${s.buf.readUInt16BE(6).toString(16)}`);
  assert.ok(opcodes.includes('2809:2400'), opcodes.join(' '));
  assert.ok(opcodes.includes('2809:3400'));
  assert.ok(opcodes.includes('27ff:1002'), 'name also asked with the default ID');
  assert.ok(!opcodes.some((o) => o.endsWith(':2010') || o.endsWith(':3000') || o.endsWith(':1100')), 'no legacy channel queries');
  // netaudio framing: the length field equals the packet length, no padding
  for (const s of arc) assert.equal(s.buf.readUInt16BE(2), s.buf.length);
});

test('modern Tx inventory pages are merged into the channel list', () => {
  const engine = makeEngine();
  engine.handleMdns(modernAdvert('DVS-Mac', '169.254.1.70'), { address: '169.254.1.70' });
  const dev = engine.devices.get('169.254.1.70');

  engine.sent = [];
  const first = statusPage({ result: 0x8112, channels: [1, 2].map((n) => ({ number: n, name: `Playback ${n}` })) });
  engine.handleArc(first, { address: '169.254.1.70', port: 4440 });
  // Asked for the next page, continuing at channel 3
  const next = engine.sent.find((s) => s.sock === 'ARC' && s.buf.readUInt16BE(6) === 0x2400);
  assert.ok(next);
  assert.equal(next.buf.readUInt16BE(8 + 2 + 8), 3, 'media selector = audio');
  assert.equal(next.buf.readUInt16BE(8 + 2 + 10), 3, 'start channel');

  engine.handleArc(statusPage({ channels: [{ number: 3, name: 'Playback 3' }] }), { address: '169.254.1.70', port: 4440 });
  assert.equal(dev.tx.count, 3);
  assert.deepEqual(Object.values(dev.tx.channels).map((c) => c.name), ['Playback 1', 'Playback 2', 'Playback 3']);
  assert.equal(dev.sampleRate, 48000);
  assert.equal(dev.arcProtocol, 0x2809);
});

test('modern Rx inventory carries subscriptions', () => {
  const engine = makeEngine();
  engine.handleMdns(modernAdvert('DVS-Mac', '169.254.1.70'), { address: '169.254.1.70' });
  const dev = engine.devices.get('169.254.1.70');
  engine.handleArc(
    statusPage({ rx: true, channels: [{ number: 1, name: 'In 1', txDevice: 'Stagebox-1', txChannel: 'Mic 1', status: 9 }, { number: 2, name: 'In 2' }] }),
    { address: '169.254.1.70', port: 4440 }
  );
  assert.equal(dev.rx.count, 2);
  assert.equal(dev.rx.channels[1].subscribedDevice, 'Stagebox-1');
  assert.equal(dev.rx.channels[1].subscribedChannel, 'Mic 1');
  assert.equal(dev.rx.channels[1].connected, true);
  assert.equal(dev.rx.channels[2].subscribedDevice, null);
});

test('a modern device answering a default-ID name query stays modern; ARC errors show in diagnostics', () => {
  const engine = makeEngine();
  engine.handleMdns(modernAdvert('DVS-Mac', '169.254.1.70'), { address: '169.254.1.70' });
  engine.handleArc(statusPage({ channels: [{ number: 1, name: 'A' }] }), { address: '169.254.1.70', port: 4440 });
  const reply = nameReply('DVS-Mac');
  reply.writeUInt16BE(0x27ff, 0);
  engine.handleArc(reply, { address: '169.254.1.70', port: 4440 });
  const dev = engine.devices.get('169.254.1.70');
  assert.equal(engine.modernArcProtocol(dev), 0x2809);

  const rejected = Buffer.alloc(10);
  rejected.writeUInt16BE(0x2809, 0);
  rejected.writeUInt16BE(10, 2);
  rejected.writeUInt16BE(0x3400, 6);
  rejected.writeUInt16BE(0x0022, 8);
  engine.handleArc(rejected, { address: '169.254.1.70', port: 4440 });
  const diag = engine.getDiagnostics().devices.find((d) => d.ip === '169.254.1.70');
  assert.equal(diag.arcAdvertised, '2.8.9 (0x2809)');
  assert.equal(diag.lastArcError.opcode, '0x3400');
  assert.equal(diag.lastArcError.result, '0x22');
  assert.equal(diag.channelInventory, 'modern (0x2400/0x3400)');
});

test('a device advertising an older protocol that answers a 0x2809 probe stays on the legacy queries', () => {
  const engine = makeEngine();
  const dev = engine.register('169.254.1.80');
  const probe = nameReply('Wall-Plate');
  probe.writeUInt16BE(0x2809, 0);
  engine.handleArc(probe, { address: '169.254.1.80', port: 4440 });
  // Its mDNS then says arcp_vers 2.7.13 (0x27FF)
  engine.handleMdns(advert('Wall-Plate', { address: '169.254.1.80', txt: ['arcp_vers=2.7.13'] }), { address: '169.254.1.80' });
  assert.equal(engine.modernArcProtocol(dev), null);
  engine.sent = [];
  engine.pollDevice('169.254.1.80');
  const opcodes = engine.sent.filter((s) => s.sock === 'ARC').map((s) => s.buf.readUInt16BE(6));
  assert.ok(opcodes.includes(0x3000) && !opcodes.includes(0x3400));
});

test('without mDNS, a device that rejects the modern inventory falls back to the legacy queries', () => {
  const engine = makeEngine();
  const dev = engine.register('169.254.1.81');
  const probe = nameReply('Wall-Plate');
  probe.writeUInt16BE(0x2809, 0);
  engine.handleArc(probe, { address: '169.254.1.81', port: 4440 });
  assert.equal(engine.modernArcProtocol(dev), 0x2809);
  const rejected = Buffer.alloc(10);
  rejected.writeUInt16BE(0x2809, 0);
  rejected.writeUInt16BE(10, 2);
  rejected.writeUInt16BE(0x2400, 6);
  rejected.writeUInt16BE(0x0030, 8);
  engine.handleArc(rejected, { address: '169.254.1.81', port: 4440 });
  assert.equal(engine.modernArcProtocol(dev), null);
  for (let i = 0; i < 6; i++) {
    engine.sent = [];
    engine.pollDevice('169.254.1.81');
    const ids = engine.sent.filter((s) => s.sock === 'ARC').map((s) => s.buf.readUInt16BE(0));
    assert.ok(!ids.includes(0x2809), 'stops probing 0x2809');
  }
});

// ---------------------------------------------------------------------------
// Losing and regaining the Dante interface
// ---------------------------------------------------------------------------

function nicHarness(initial) {
  const network = require('../lib/dante/network');
  const original = network.listInterfaces;
  let current = initial;
  network.listInterfaces = () => current;
  const engine = makeEngine();
  const bound = [];
  engine.bind = (iface) => {
    engine.iface = iface;
    bound.push(iface && iface.name);
  };
  const events = [];
  for (const e of ['interface-lost', 'interface-restored', 'interfaces-changed']) engine.on(e, () => events.push(e));
  engine.sendMdnsQueries = () => {};
  engine.probeArpTable = async () => {};
  return {
    engine,
    bound,
    events,
    set: (list) => (current = list),
    restore: () => (network.listInterfaces = original)
  };
}

const nic = (name, address) => ({ name, address, netmask: '255.255.0.0', mac: '', isDanteLinkLocal: address.startsWith('169.254.') });
const office = nic('en5', '10.0.0.5');

test('when the Dante NIC drops and comes back (even with a new address) the bridge switches back to it', () => {
  const h = nicHarness([office, nic('en7', '169.254.1.44')]);
  try {
    h.engine.autoSelected = true;
    h.engine.iface = nic('en7', '169.254.1.44');
    h.set([office]); // cable pulled
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5']);
    h.engine.discoveryTick(); // still gone: stays put
    assert.deepEqual(h.bound, ['en5']);
    h.set([office, nic('en7', '169.254.10.20')]); // macOS self-assigns a new link-local address
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5', 'en7']);
    assert.equal(h.engine.iface.address, '169.254.10.20');
    assert.ok(h.events.includes('interface-lost') && h.events.includes('interface-restored'));
  } finally {
    h.restore();
  }
});

test('an interface chosen in the UI is kept even when a Dante interface appears', () => {
  const h = nicHarness([office]);
  try {
    h.engine.selectInterface('10.0.0.5');
    h.engine.discoveryTick();
    h.set([office, nic('en7', '169.254.1.1')]);
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5'], 'no automatic switch');
    assert.ok(h.events.includes('interfaces-changed'), 'NIC menu refreshed');
  } finally {
    h.restore();
  }
});

test('auto-selected non-Dante interface switches to a link-local one that appears later', () => {
  const h = nicHarness([office]);
  try {
    h.engine.autoSelected = true;
    h.engine.iface = office;
    h.set([office, nic('en7', '169.254.1.1')]);
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en7']);
  } finally {
    h.restore();
  }
});

test('an interface the user chose is kept after it drops and returns, even with a Dante interface present', () => {
  const dante = nic('en7', '169.254.1.1');
  const h = nicHarness([office, dante]);
  try {
    h.engine.selectInterface('10.0.0.5');
    h.set([dante]); // chosen interface unplugged
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5', 'en7']);
    h.set([office, dante]);
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5', 'en7', 'en5'], 'back to the chosen interface');
    h.engine.discoveryTick();
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5', 'en7', 'en5'], 'and it stays there');
  } finally {
    h.restore();
  }
});

test('started with no network: binds to the first interface that comes up, whatever its addressing', () => {
  const h = nicHarness([]);
  try {
    h.engine.autoSelected = true;
    h.engine.iface = null;
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, []);
    h.set([office]);
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, ['en5']);
  } finally {
    h.restore();
  }
});

test('"All Interfaces" chosen in the UI is not replaced when an interface appears', () => {
  const h = nicHarness([]);
  try {
    h.engine.selectInterface('all');
    h.set([office]);
    h.engine.discoveryTick();
    assert.deepEqual(h.bound, [null], 'only the explicit choice, no automatic switch');
  } finally {
    h.restore();
  }
});

test('a device that comes back on a new address replaces its old record instead of being shadowed by it', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('Stagebox-1'), from('169.254.1.10'));
  engine.devices.get('169.254.1.10').lastSeen = Date.now() - TIMING.OFFLINE_AFTER - 1;
  engine.handleMdns(advert('Stagebox-1', { address: '169.254.1.60' }), { address: '169.254.1.60' });
  assert.equal(engine.devices.get('169.254.1.60').name, 'Stagebox-1');
  assert.equal(engine.devices.has('169.254.1.10'), false);
  assert.deepEqual(engine.getDevices().map((d) => [d.name, d.online]), [['Stagebox-1', true]]);
});

test('identity from an override is dropped when the device is renamed away from it', () => {
  const engine = makeEngine({ overrides: { 'Old-Name': { manufacturer: 'ACME', modelName: 'Box 8' } } });
  engine.handleArc(nameReply('Old-Name'), from('169.254.1.10'));
  const dev = engine.devices.get('169.254.1.10');
  assert.equal(dev.modelName, 'Box 8');
  engine.handleArc(nameReply('New-Name'), from('169.254.1.10'));
  assert.equal(dev.name, 'New-Name');
  assert.equal(dev.modelName, null);
  assert.equal(dev.manufacturer, null);
});

test('modern inventory paging continues past pages that hold no audio channels', () => {
  const engine = makeEngine();
  engine.handleMdns(modernAdvert('AV-Box', '169.254.1.70'), { address: '169.254.1.70' });
  const dev = engine.devices.get('169.254.1.70');
  const sent = [];
  engine.sendChannelStatusQuery = (d, rx, media, start) => sent.push([media, start]);
  const page = (ids) => ({ commandId: 0x2400, ok: true, morePages: true, channels: ids.map((id) => ({ number: 100 + id, mediaType: 1, localId: id })) });
  engine.handleChannelStatusPage(dev, page([1, 2]));
  engine.handleChannelStatusPage(dev, page([3, 4]));
  engine.handleChannelStatusPage(dev, page([5, 6]));
  assert.deepEqual(sent, [[1, 3], [1, 5], [1, 7]]);
});
