'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packets = require('../lib/dante/packets');
const mdns = require('../lib/dante/mdns');
const { ARC_COMMANDS, SERVICES } = require('../lib/dante/constants');

// Golden packets captured from the original (v1.0.0) implementation with
// MAC a1:b2:c3:d4:e5:f6, subscriber IP 169.254.10.20 and device "Test-Dev".
// The refactor must stay byte-for-byte compatible on the wire.
const MAC = Buffer.from('a1b2c3d4e5f6', 'hex');
const hex = (buf) => buf.toString('hex');

test('ARC queries match the original encoding', () => {
  assert.equal(hex(packets.arcCommand(1, ARC_COMMANDS.DEVICE_NAME)), '2729000d000110020000000000');
  assert.equal(hex(packets.arcCommand(2, ARC_COMMANDS.CHANNEL_COUNTS)), '2729000d000210000000000000');
  assert.equal(hex(packets.arcCommand(3, ARC_COMMANDS.DEVICE_SETTINGS)), '2729000d000311000000000000');
  assert.equal(
    hex(packets.arcCommand(4, ARC_COMMANDS.TX_FRIENDLY_NAMES, packets.txNamesArgs(0))),
    '27290010000420100000000100010000'
  );
  assert.equal(
    hex(packets.arcCommand(5, ARC_COMMANDS.TX_FRIENDLY_NAMES, packets.txNamesArgs(1))),
    '27290010000520100000000100210000'
  );
  // 20 Rx channels -> a full page of 16 then a page of 4.
  assert.equal(
    hex(packets.arcCommand(6, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(0, 20))),
    '27290010000630000000001000010000'
  );
  assert.equal(
    hex(packets.arcCommand(7, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(1, 20))),
    '27290010000730000000000400110000'
  );
});

test('page counts match the original', () => {
  assert.equal(packets.pageCount(40, 32), 2);
  assert.equal(packets.pageCount(16, 32), 1);
  assert.equal(packets.pageCount(20, 16), 2);
  assert.equal(packets.pageCount(0, 16), 1);
});

test('settings / CMC queries match the original encoding', () => {
  assert.equal(hex(packets.cmcSettingsPortQuery(8, MAC)), '120000140008100100003520a1b2c3d4e5f60000');
  assert.equal(
    hex(packets.clockingQuery(13, MAC)),
    'ffff0020000d2a84a1b2c3d4e5f60000417564696e6174650734002000000000'
  );
  assert.equal(
    hex(packets.interfaceControlQuery(14, MAC)),
    'ffff0028000e2a84a1b2c3d4e5f60000417564696e61746507340013000000640000000000000000'
  );
  assert.equal(
    hex(packets.interfaceStatusQuery(15, MAC)),
    'ffff0020000f2a84a1b2c3d4e5f60000417564696e6174650734001100000000'
  );
});

// Dante Controller's own metering request to a Shure AD4D, from the
// public-domain netaudio project's capture fixture (client identifier bytes
// 10-17 and one padding byte were anonymised in the fixture).
const CONTROLLER_METERING_START =
  '1200004225c730100000020000000000000100000004001000020012000a616434640030000100010016' +
  '0001222f00010000c000020a222f000000000000222f0000';

test('metering request matches Dante Controller byte-for-byte', () => {
  const generated = packets.cmcMeteringRequest(0x25c7, {
    deviceName: 'ad4d',
    subscriberIp: '192.0.2.10',
    mac: Buffer.from('020000000001', 'hex'),
    port: 8751
  });
  const captured = Buffer.from(CONTROLLER_METERING_START, 'hex');
  assert.equal(generated.length, captured.length);
  for (let i = 0; i < captured.length; i++) {
    if ((i >= 10 && i < 18) || i === 0x23) continue;
    assert.equal(generated[i], captured[i], `byte 0x${i.toString(16)}`);
  }
});

test('metering stop keeps the subscription identity and clears destinations', () => {
  const opts = { deviceName: 'Stagebox-1', subscriberIp: '169.254.1.1', mac: MAC, port: 8751 };
  const start = packets.cmcMeteringRequest(1, opts);
  const stop = packets.cmcMeteringStop(1, opts);
  assert.deepEqual(stop.subarray(0, -16), start.subarray(0, -16));
  assert.ok(stop.subarray(-16).every((b) => b === 0));
});

test('mDNS queries match the original encoding', () => {
  assert.equal(
    hex(mdns.buildQuery([SERVICES.ARC])),
    '0000000000010000000000000d5f6e6574617564696f2d617263045f756470056c6f63616c00000c0001'
  );
  assert.equal(
    hex(mdns.buildQuery([SERVICES.CMC])),
    '0000000000010000000000000d5f6e6574617564696f2d636d63045f756470056c6f63616c00000c0001'
  );
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function arcReply(commandId, size) {
  const buf = Buffer.alloc(size);
  buf.writeUInt16BE(0x2729, 0);
  buf.writeUInt16BE(size, 2);
  buf.writeUInt16BE(commandId, 6);
  return buf;
}

test('parses channel counts and device name', () => {
  const counts = arcReply(ARC_COMMANDS.CHANNEL_COUNTS, 16);
  counts[13] = 32;
  counts[15] = 8;
  assert.deepEqual(packets.parseArcReply(counts), { commandId: ARC_COMMANDS.CHANNEL_COUNTS, txCount: 32, rxCount: 8 });

  const name = Buffer.concat([arcReply(ARC_COMMANDS.DEVICE_NAME, 10), Buffer.from('Stagebox-1\0')]);
  assert.equal(packets.parseArcReply(name).name, 'Stagebox-1');
});

test('parses Rx channel subscriptions', () => {
  const buf = arcReply(ARC_COMMANDS.RX_CHANNELS, 64);
  buf[11] = 1;
  const strings = Buffer.from('Vox\0Mic-Rx\0Lead\0');
  buf.writeUInt16BE(1, 12); // channel number
  buf.writeUInt16BE(32, 18); // tx channel name offset
  buf.writeUInt16BE(36, 20); // tx device name offset
  buf.writeUInt16BE(43, 22); // rx channel name offset
  buf.writeUInt16BE(9, 26); // status
  strings.copy(buf, 32);
  const reply = packets.parseArcReply(buf);
  assert.deepEqual(reply.channels, [{ number: 1, txChannel: 'Vox', txDevice: 'Mic-Rx', name: 'Lead', status: 9 }]);
});

test('ignores replies from other protocols', () => {
  assert.equal(packets.parseArcReply(Buffer.from('hello world!')), null);
  assert.equal(packets.parseSettingsReply(Buffer.alloc(40)), null);
});

function meteringFrame(version, tx, rx) {
  const counts = version === 3 ? Buffer.from([0, 0, tx.length, 0, rx.length]) : Buffer.from([tx.length, rx.length]);
  const body = Buffer.concat([Buffer.from([version]), counts, Buffer.from(tx), Buffer.from(rx)]);
  const buf = Buffer.concat([Buffer.alloc(16), Buffer.from('Audinate'), body]);
  buf.writeUInt16BE(0xffff, 0);
  buf.writeUInt16BE(buf.length, 2);
  Buffer.from('000edd123456', 'hex').copy(buf, 8);
  return buf;
}

test('parses v2 and v3 metering frames', () => {
  assert.deepEqual(packets.parseMeteringPacket(meteringFrame(2, [10, 254], [0])), { mac: '000edd123456', tx: [10, 254], rx: [0] });
  assert.deepEqual(packets.parseMeteringPacket(meteringFrame(3, [5, 6], [7])), { mac: '000edd123456', tx: [5, 6], rx: [7] });
});

test('parses a real AD4Q metering frame', () => {
  // Real AD4Q frame layout (MAC anonymised): 64 Tx + 1 Rx, all muted (0xfe), one trailing byte.
  const frame = Buffer.from('ffff005db6600000000edd0000010000417564696e617465024001' + 'fe'.repeat(65) + '00', 'hex');
  const parsed = packets.parseMeteringPacket(frame);
  assert.equal(parsed.mac, '000edd000001');
  assert.equal(parsed.tx.length, 64);
  assert.deepEqual(parsed.rx, [254]);
});

test('rejects malformed metering frames', () => {
  const good = meteringFrame(2, [1, 2], [3]);
  const badLength = Buffer.from(good);
  badLength.writeUInt16BE(good.length + 1, 2);
  assert.equal(packets.parseMeteringPacket(badLength), null);
  assert.equal(packets.parseMeteringPacket(good.subarray(0, 28)), null);
  assert.equal(packets.parseMeteringPacket(Buffer.concat([Buffer.from('xxAudinate'), Buffer.from([1, 1, 1, 5, 5])])), null);
});

test('reads the sample rate from device settings records', () => {
  const buf = arcReply(ARC_COMMANDS.DEVICE_SETTINGS, 32);
  buf[11] = 2; // two records
  buf.writeUInt16BE(0x8204, 12); // default latency (ignored)
  buf.writeUInt16BE(20, 14);
  buf.writeUInt16BE(0x8020, 16); // sample rate
  buf.writeUInt16BE(24, 18);
  buf.writeUInt32BE(1000000, 20);
  buf.writeUInt32BE(96000, 24);
  assert.equal(packets.parseArcReply(buf).sampleRate, 96000);
});

function heartbeat(records) {
  const header = Buffer.alloc(32);
  header.writeUInt16BE(0xfffe, 0);
  header.write('Audinate', 16, 'ascii');
  return Buffer.concat([header, ...records]);
}

test('parses heartbeat port status and signal presence', () => {
  const ports = Buffer.alloc(52);
  ports.writeUInt16BE(52, 0);
  ports.writeUInt16BE(0x8000, 2);
  ports.writeUInt16BE(2, 16);
  ports.writeUInt32BE(0x01020304, 36);

  const levels = Buffer.alloc(26);
  levels.writeUInt16BE(26, 0);
  levels.writeUInt16BE(0x8002, 2);
  levels.writeUInt16BE(2, 12); // tx count
  levels.writeUInt16BE(0, 14); // first tx
  levels.writeUInt16BE(2, 16); // rx count
  levels.writeUInt16BE(0, 18); // first rx
  levels.writeUInt16BE(22, 20); // vector offset
  Buffer.from([10, 20, 30, 40]).copy(levels, 22);

  const hb = packets.parseHeartbeat(heartbeat([ports, levels]));
  assert.equal(hb.mac, null);
  assert.deepEqual(hb.ports, { numPorts: 2, secondaryLinkUp: true });
  assert.deepEqual(hb.levels, { txFirst: 1, tx: [10, 20], rxFirst: 1, rx: [30, 40] });
});

test('a zero-length heartbeat record does not hang the parser', () => {
  const bad = Buffer.alloc(8); // recLen = 0
  assert.deepEqual(packets.parseHeartbeat(heartbeat([bad])), { mac: null, ports: null, levels: null });
});
