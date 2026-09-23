'use strict';

/**
 * Pure builders and parsers for the Dante UDP protocols used by the bridge.
 * Nothing in here touches sockets or engine state, so it can be unit tested
 * byte-for-byte.
 */

const {
  PORTS,
  PROTOCOL,
  ARC_COMMANDS,
  SETTINGS_MESSAGES,
  HEARTBEAT_RECORDS,
  AUDINATE_MAGIC,
  DEVICE_SETTINGS_SAMPLE_RATE,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
} = require('./constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value & 0xffff);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0);
  return buf;
}

function readU16(buf, offset) {
  return offset + 2 <= buf.length ? buf.readUInt16BE(offset) : 0;
}

function readU32(buf, offset) {
  return offset + 4 <= buf.length ? buf.readUInt32BE(offset) : 0;
}

/** Read a NUL-terminated string starting at `start` (0 means "absent"). */
function readCString(buf, start) {
  if (!start || start <= 0 || start >= buf.length) return '';
  const end = buf.indexOf(0x00, start);
  return buf.toString('utf8', start, end === -1 ? buf.length : end);
}

function ipv4ToBuffer(ip) {
  if (!ip || ip.startsWith('127.')) return Buffer.alloc(4);
  const parts = ip.split('.').map((x) => parseInt(x, 10) & 0xff);
  return parts.length === 4 ? Buffer.from(parts) : Buffer.alloc(4);
}

function nameBuffer(name) {
  return Buffer.from(name + '\0', 'ascii');
}

// ---------------------------------------------------------------------------
// ARC (device control, UDP 4440)
// ---------------------------------------------------------------------------

function arcCommand(seq, commandType, args = Buffer.alloc(2)) {
  return Buffer.concat([
    u16(PROTOCOL.ARC),
    u16(args.length + 11),
    u16(seq),
    u16(commandType),
    Buffer.from([0x00, 0x00]),
    args,
    Buffer.from([0x00])
  ]);
}

function txNamesArgs(page) {
  const args = Buffer.from('0001000100', 'hex');
  args.writeUInt16BE(page * TX_PAGE_SIZE + 1, 2);
  return args;
}

function rxChannelsArgs(page, rxCount) {
  const args = Buffer.alloc(5);
  args.writeUInt16BE(Math.min(RX_PAGE_SIZE, Math.max(1, rxCount - page * RX_PAGE_SIZE)), 0);
  args.writeUInt16BE(page * RX_PAGE_SIZE + 1, 2);
  return args;
}

function pageCount(channelCount, pageSize) {
  return Math.max(1, Math.ceil(channelCount / pageSize));
}

function parseArcReply(buf) {
  if (buf.length < 10 || readU16(buf, 0) !== PROTOCOL.ARC) return null;
  const commandId = readU16(buf, 6);

  switch (commandId) {
    case ARC_COMMANDS.CHANNEL_COUNTS:
      if (buf.length < 16) return null;
      return { commandId, txCount: buf[13], rxCount: buf[15] };

    case ARC_COMMANDS.DEVICE_NAME:
      return { commandId, name: readCString(buf, 10) };

    case ARC_COMMANDS.TX_FRIENDLY_NAMES: {
      const count = Math.min(buf[11] || 0, TX_PAGE_SIZE);
      const channels = [];
      for (let i = 0; i < count; i++) {
        const rec = 12 + 6 * i;
        const number = readU16(buf, rec + 2);
        if (number > 0) channels.push({ number, name: readCString(buf, readU16(buf, rec + 4)) });
      }
      return { commandId, channels };
    }

    case ARC_COMMANDS.RX_CHANNELS: {
      const count = Math.min(buf[11] || 0, RX_PAGE_SIZE);
      const channels = [];
      for (let i = 0; i < count; i++) {
        const rec = 12 + 20 * i;
        const number = readU16(buf, rec);
        if (number <= 0) continue;
        channels.push({
          number,
          txChannel: readCString(buf, readU16(buf, rec + 6)) || null,
          txDevice: readCString(buf, readU16(buf, rec + 8)) || null,
          name: readCString(buf, readU16(buf, rec + 10)),
          status: readU16(buf, rec + 14)
        });
      }
      return { commandId, channels };
    }

    case ARC_COMMANDS.DEVICE_SETTINGS: {
      // Body (after the 10-byte header): [?, count, (infoCode u16, pointer u16) x count].
      // Codes with the high bit set point at a u32 value elsewhere in the reply.
      const count = buf[11] || 0;
      let sampleRate = null;
      for (let i = 0; i < count; i++) {
        const rec = 12 + 4 * i;
        if (rec + 4 > buf.length) break;
        if (buf.readUInt16BE(rec) === DEVICE_SETTINGS_SAMPLE_RATE) sampleRate = readU32(buf, buf.readUInt16BE(rec + 2));
      }
      return { commandId, sampleRate };
    }

    default:
      return { commandId };
  }
}

// ---------------------------------------------------------------------------
// Settings / info (UDP 8700 + 8702, multicast 224.0.0.231)
// ---------------------------------------------------------------------------

function settingsCommand(seq, mac, commandType, args = Buffer.alloc(2)) {
  return Buffer.concat([
    u16(PROTOCOL.SETTINGS),
    u16(args.length + 28),
    u16(seq),
    Buffer.from('2a84', 'hex'),
    mac,
    Buffer.from('0000', 'hex'),
    AUDINATE_MAGIC,
    u16(commandType),
    args
  ]);
}

function clockingQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.CLOCKING_STATUS, u32(0));
}

function interfaceControlQuery(seq, mac) {
  const args = Buffer.alloc(12);
  args.writeUInt32BE(100, 0);
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.INTERFACE_CONTROL, args);
}

function interfaceStatusQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.INTERFACE_STATUS, Buffer.alloc(4));
}

/** Sender MAC carried in settings / heartbeat / metering headers (bytes 8-13). */
function headerMac(buf) {
  const mac = buf.subarray(8, 14);
  if (mac.length < 6 || mac.every((b) => b === 0) || mac.every((b) => b === 0xff)) return null;
  return mac.toString('hex');
}

function parseSettingsReply(buf) {
  if (buf.length < 28 || readU16(buf, 0) !== PROTOCOL.SETTINGS) return null;
  const payload = buf.subarray(24);
  const commandId = readU16(payload, 2);
  const mac = headerMac(buf);

  switch (commandId) {
    case SETTINGS_MESSAGES.CLOCKING_STATUS:
    case SETTINGS_MESSAGES.CLOCKING_CONTROL: {
      if (payload.length < 16) return { commandId };
      const hex = (from, to) => (payload.length >= to ? payload.subarray(from, to).toString('hex') : '');
      const state = readU16(payload, 8);
      const uuid = hex(20, 28);
      const grandmasterUuid = hex(36, 44);
      return {
        commandId,
        mac,
        clock: {
          state,
          servo: readU16(payload, 10),
          source: readU16(payload, 12),
          isPreferred: payload[14] !== 0,
          stratum: payload[15],
          drift: payload.length >= 20 ? readU32(payload, 16) : 0,
          uuid,
          masterUuid: hex(28, 36),
          grandmasterUuid,
          isMaster: state === 5 || (Boolean(uuid) && uuid === grandmasterUuid),
          numPorts: payload.length >= 48 ? payload[44] || 2 : 2
        }
      };
    }

    case SETTINGS_MESSAGES.INTERFACE_STATUS:
    case SETTINGS_MESSAGES.INTERFACE_CONTROL: {
      if (payload.length < 40) return { commandId };
      const numInterfaces = readU16(payload, 8);
      let secondaryIp = null;
      // Interface records are 28 bytes starting at offset 12; the second
      // (secondary network) record's IPv4 address sits at offset 52.
      if (numInterfaces >= 2 && payload.length >= 68) {
        const ip = Array.from(payload.subarray(52, 56)).join('.');
        if (!ip.startsWith('0.')) secondaryIp = ip;
      }
      return { commandId, mac, numInterfaces, secondaryIp };
    }

    default:
      return { commandId, mac };
  }
}

// ---------------------------------------------------------------------------
// CMC (UDP 8800)
// ---------------------------------------------------------------------------

function cmcSettingsPortQuery(seq, mac) {
  return Buffer.concat([u16(PROTOCOL.CMC), u16(20), u16(seq), u16(0x1001), u16(0x0000), u16(0x3520), mac, u16(0x0000)]);
}

function parseCmcReply(buf) {
  if (readU16(buf, 0) !== PROTOCOL.CMC) return null;
  const commandId = readU16(buf, 6);
  if (commandId === 0x1001 && buf.length >= 30) return { commandId, settingsPort: readU16(buf, 28) };
  return { commandId };
}

/**
 * Ask a device to stream its meters to `subscriberIp:port` (CMC 0x3010).
 * Layout matches Dante Controller's own request (as documented by the
 * public-domain netaudio project). Each subscriber is keyed by its MAC, so
 * this coexists with any number of Dante Controller instances.
 */
function cmcMeteringRequest(seq, { deviceName, subscriberIp, mac, port }) {
  let name = nameBuffer(deviceName);
  if (name.length % 2) name = Buffer.concat([name, Buffer.alloc(1)]);
  const nameField = name.length + 0x0a;
  const channelField = name.length + 0x0c;

  const body = Buffer.concat([
    u16(0x3010),
    u16(0),
    u16(0),
    mac,
    u16(0),
    u16(4),
    u16(nameField),
    u16(2),
    u16(channelField),
    u16(0x000a),
    name,
    u16(1),
    u16(1),
    u16(channelField + 4),
    u16(1),
    u16(port),
    // destinations (16 bytes) — all zero means "stop"
    u16(1),
    u16(0),
    ipv4ToBuffer(subscriberIp),
    u16(port),
    Buffer.alloc(6),
    u16(port),
    Buffer.alloc(2)
  ]);
  return Buffer.concat([u16(PROTOCOL.CMC), u16(body.length + 6), u16(seq), body]);
}

function cmcMeteringStop(seq, { deviceName, mac, port }) {
  const pkt = cmcMeteringRequest(seq, { deviceName, subscriberIp: null, mac, port });
  pkt.fill(0, pkt.length - 16);
  return pkt;
}

// ---------------------------------------------------------------------------
// Heartbeats (multicast 224.0.0.233:8708)
// ---------------------------------------------------------------------------

function parseHeartbeat(buf) {
  if (readU16(buf, 0) !== PROTOCOL.HEARTBEAT || readCString(buf, 16) !== 'Audinate') return null;

  const result = { mac: headerMac(buf), ports: null, levels: null };
  let offset = 32;
  while (offset + 4 <= buf.length) {
    const recLen = buf.readUInt16BE(offset);
    const recType = buf.readUInt16BE(offset + 2);
    if (recLen < 4 || offset + recLen > buf.length) break;

    if (recType === HEARTBEAT_RECORDS.PORT_STATUS && recLen >= 52) {
      const numPorts = buf.readUInt16BE(offset + 16);
      const p2 = offset + 36;
      result.ports = {
        numPorts,
        secondaryLinkUp: numPorts >= 2 ? buf.readUInt32BE(p2) !== 0 || buf.readUInt32BE(p2 + 4) !== 0 : null
      };
    } else if (recType === HEARTBEAT_RECORDS.SIGNAL_PRESENCE && recLen >= 22) {
      const txCount = buf.readUInt16BE(offset + 12);
      const txFirst = buf.readUInt16BE(offset + 14);
      const rxCount = buf.readUInt16BE(offset + 16);
      const rxFirst = buf.readUInt16BE(offset + 18);
      const vecStart = offset + buf.readUInt16BE(offset + 20);
      if (vecStart + txCount + rxCount <= offset + recLen) {
        result.levels = {
          txFirst: txFirst + 1,
          tx: Array.from(buf.subarray(vecStart, vecStart + txCount)),
          rxFirst: rxFirst + 1,
          rx: Array.from(buf.subarray(vecStart + txCount, vecStart + txCount + rxCount))
        };
      }
    }
    offset += recLen;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metering stream (UDP 8751)
// ---------------------------------------------------------------------------

/**
 * Metering frame: 0xFFFF, length, seq, 0, sender EUI-64 (8), "Audinate",
 * then version (1-2: u8 counts at 25/26, levels at 27; 3: u16 counts at
 * 26/28, levels at 30), Tx levels, Rx levels.
 */
function parseMeteringPacket(buf) {
  if (buf.length < 27 || readU16(buf, 0) !== 0xffff || readU16(buf, 2) !== buf.length) return null;
  if (buf.toString('latin1', 16, 24) !== 'Audinate') return null;

  const version = buf[24];
  let numTx;
  let numRx;
  let start;
  if (version === 1 || version === 2) {
    numTx = buf[25];
    numRx = buf[26];
    start = 27;
  } else if (version === 3 && buf.length >= 30) {
    numTx = readU16(buf, 26);
    numRx = readU16(buf, 28);
    start = 30;
  } else {
    return null;
  }
  if (start + numTx + numRx > buf.length) return null;
  return {
    mac: headerMac(buf),
    tx: Array.from(buf.subarray(start, start + numTx)),
    rx: Array.from(buf.subarray(start + numTx, start + numTx + numRx))
  };
}

module.exports = {
  readCString,
  pageCount,
  arcCommand,
  txNamesArgs,
  rxChannelsArgs,
  parseArcReply,
  settingsCommand,
  clockingQuery,
  interfaceControlQuery,
  interfaceStatusQuery,
  parseSettingsReply,
  cmcSettingsPortQuery,
  parseCmcReply,
  cmcMeteringRequest,
  cmcMeteringStop,
  parseHeartbeat,
  parseMeteringPacket
};
