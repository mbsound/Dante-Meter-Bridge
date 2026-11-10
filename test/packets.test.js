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
  // 20 Rx channels -> pages starting at channel 1 and 17 (netaudio's layout:
  // 0000 0001 <start> 0000; verified against Yamaha and Audinate hardware).
  assert.equal(
    hex(packets.arcCommand(6, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(0, 20))),
    '27290010000630000000000100010000'
  );
  assert.equal(
    hex(packets.arcCommand(7, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(1, 20))),
    '27290010000730000000000100110000'
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
  assert.deepEqual(packets.parseArcReply(counts), { protocolId: 0x2729, resultCode: 0, commandId: ARC_COMMANDS.CHANNEL_COUNTS, txCount: 32, rxCount: 8 });

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
  assert.deepEqual(reply.channels, [{ number: 1, txChannel: 'Vox', txDevice: 'Mic-Rx', name: 'Lead', rxStatus: 0, status: 9 }]);
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
  assert.deepEqual(packets.parseHeartbeat(heartbeat([bad])), { mac: null, ports: null, levels: null, clockOffsetPpb: null, latePackets: null });
});

test('heartbeat clock offset and late packet counters', () => {
  // 0x8001: [len 16, type, extLen 4, payloadLen 4, seq, ?, int32 ppb]
  const offset = Buffer.alloc(16);
  offset.writeUInt16BE(16, 0);
  offset.writeUInt16BE(0x8001, 2);
  offset.writeUInt16BE(4, 4);
  offset.writeUInt16BE(4, 6);
  offset.writeInt32BE(-222222, 12);

  // 0x8004: subheader 4 bytes, payload = count, first, countersAt; then u32 counters
  const late = Buffer.alloc(28);
  late.writeUInt16BE(28, 0);
  late.writeUInt16BE(0x8004, 2);
  late.writeUInt16BE(4, 4); // subheader length -> payload at 12
  late.writeUInt16BE(16, 6); // payload length
  late.writeUInt16BE(2, 12); // two flows
  late.writeUInt16BE(0, 14); // first index
  late.writeUInt16BE(20, 16); // counters at 20
  late.writeUInt32BE(3, 20);
  late.writeUInt32BE(4, 24);

  const hb = packets.parseHeartbeat(heartbeat([offset, late]));
  assert.equal(hb.clockOffsetPpb, -222222);
  assert.equal(hb.latePackets, 7);
});

function clockReply({ revision = 0x0726, state = 3, servo = 3, uuid = '000edd0000010000', gm = '000edd0000020000', ports = 2, maxDrift = 100000, mute = 0 } = {}) {
  const payload = Buffer.alloc(0x30 + 32);
  payload.writeUInt16BE(revision, 0);
  payload.writeUInt16BE(32, 2); // clocking status message
  payload.writeUInt16BE(state, 8);
  payload.writeUInt16BE(servo, 10);
  payload.writeInt32BE(-1500, 16);
  Buffer.from(uuid, 'hex').copy(payload, 20);
  Buffer.from(gm, 'hex').copy(payload, 36);
  payload.writeUInt16BE(ports, 0x2c);
  payload.writeUInt16BE(0x30, 0x2e); // extension offset
  payload.writeInt32BE(maxDrift, 0x30 + 4);
  payload.writeUInt16BE(mute, 0x30 + 28);
  const header = Buffer.alloc(24);
  header.writeUInt16BE(0xffff, 0);
  header.writeUInt16BE(24 + payload.length, 2);
  Buffer.from('000edd000001', 'hex').copy(header, 8);
  return Buffer.concat([header, payload]);
}

test('clock status: identities, port count, drift limit and mute flags', () => {
  const { clock } = packets.parseSettingsReply(clockReply({ mute: 1 | 16 }));
  assert.equal(clock.revision, 0x0726);
  assert.equal(clock.servo, 3);
  assert.equal(clock.uuid, '000edd0000010000');
  assert.equal(clock.grandmasterUuid, '000edd0000020000');
  assert.equal(clock.isMaster, false);
  assert.equal(clock.numPorts, 2);
  assert.equal(clock.frequencyOffsetPpb, -1500);
  assert.equal(clock.maxDriftPpb, 100000);
  assert.equal(clock.muteFlags, 17);

  const leader = packets.parseSettingsReply(clockReply({ gm: '000edd0000010000' })).clock;
  assert.equal(leader.isMaster, true);

  // Before 0x0704 there are no mute flags.
  assert.equal(packets.parseSettingsReply(clockReply({ revision: 0x0600, mute: 1 })).clock.muteFlags, null);
});

test('ARC replies with any Dante ARC protocol ID are accepted (e.g. Dante Virtual Soundcard)', () => {
  for (const protocolId of [0x27ff, 0x2729, 0x2809, 0x280c]) {
    const counts = arcReply(ARC_COMMANDS.CHANNEL_COUNTS, 16);
    counts.writeUInt16BE(protocolId, 0);
    counts[13] = 64;
    counts[15] = 64;
    const reply = packets.parseArcReply(counts);
    assert.equal(reply.protocolId, protocolId);
    assert.equal(reply.txCount, 64);
  }
  const other = arcReply(ARC_COMMANDS.CHANNEL_COUNTS, 16);
  other.writeUInt16BE(0x1234, 0);
  assert.equal(packets.parseArcReply(other), null);
});

test('ARC requests can be sent with the alternative protocol ID', () => {
  assert.equal(hex(packets.arcCommand(1, ARC_COMMANDS.DEVICE_NAME, undefined, 0x27ff)), '27ff000d000110020000000000');
});

test('clock refresh is a pure clock-control query (revision 0x0734, no change flags)', () => {
  const pkt = packets.clockRefreshQuery(5, MAC);
  // header(8) + 2a84 + mac + 0000 + "Audinate" + record(40)
  assert.equal(pkt.length, 24 + 40);
  const record = pkt.subarray(24);
  assert.equal(record.readUInt16BE(0), 0x0734);
  assert.equal(record.readUInt16BE(2), 0x0021);
  assert.equal(record.readUInt32BE(4), 100);
  assert.ok(record.subarray(8).every((b) => b === 0), 'all change flags and values zero');
});

test('arcp_vers maps to an ARC protocol ID the way netaudio does', () => {
  assert.equal(packets.arcProtocolFromVersion('2.8.9'), 0x2809);
  assert.equal(packets.arcProtocolFromVersion('2.8.0'), 0x27ff);
  assert.equal(packets.arcProtocolFromVersion('2.7.41'), 0x2729);
  assert.equal(packets.arcProtocolFromVersion('2.8.15'), 0x280f);
  assert.equal(packets.arcProtocolFromVersion('3.0'), 0x280f);
  assert.equal(packets.arcProtocolFromVersion('1.0'), 0x27ff);
  assert.equal(packets.arcProtocolFromVersion('junk'), null);
  assert.equal(packets.isModernArc(0x2809), true);
  assert.equal(packets.isModernArc(0x27ff), false);
});

test('modern ARC requests use netaudio framing', () => {
  assert.equal(hex(packets.arcRequest(1, ARC_COMMANDS.DEVICE_NAME, undefined, 0x27ff)), '27ff000a000110020000');
  assert.equal(
    hex(packets.channelStatusQuery(2, { protocolId: 0x2809 })),
    '28090022000224000000' + '000000000000' + '0001' + '0001' + '0001' + '0000' + '00000000' + '830283060310'
  );
  // 0x280F has no trailer; Rx uses 0x3400
  const rx = packets.channelStatusQuery(3, { protocolId: 0x280f, rx: true, mediaSelector: 3, start: 9 });
  assert.equal(rx.readUInt16BE(6), 0x3400);
  assert.equal(hex(rx.subarray(28)), '000000000000');
});
