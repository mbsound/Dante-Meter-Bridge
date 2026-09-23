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

test('mDNS answers relayed by this machine are not mistaken for a device at our IP', () => {
  const mdns = require('../lib/dante/mdns');
  const engine = makeEngine();
  engine.localAddresses = new Set(['169.254.9.1']);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 6);
  const name = mdns.encodeName('Stagebox-1._netaudio-arc._udp.local');
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(mdns.TYPE.TXT, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt16BE(9, 8);
  const response = Buffer.concat([header, name, fixed, Buffer.from([8]), Buffer.from('mf=Shure')]);

  engine.handleMdns(response, { address: '169.254.9.1', port: 5353 });
  assert.equal(engine.devices.size, 0);

  engine.handleMdns(response, { address: '169.254.1.10', port: 5353 });
  assert.equal(engine.getDevices()[0].name, 'Stagebox-1');
});
