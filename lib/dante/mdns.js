'use strict';

/**
 * Minimal mDNS (RFC 6762) query builder and response parser — just enough to
 * discover Dante devices advertising _netaudio-arc / _netaudio-cmc services.
 */

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };
const MAX_NAME_JUMPS = 32;

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Build a single PTR query packet asking for every given service type. */
function buildQuery(services) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(services.length, 4); // QDCOUNT
  const questions = services.map((service) =>
    Buffer.concat([encodeName(service), Buffer.from([0x00, TYPE.PTR, 0x00, 0x01])])
  );
  return Buffer.concat([header, ...questions]);
}

/** Decode a (possibly compressed) domain name. Returns { name, next }. */
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length || ++jumps > MAX_NAME_JUMPS) throw new Error('bad name pointer');
      if (next === -1) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('label overflow');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

function parseTxt(buf, start, end) {
  const txt = {};
  let pos = start;
  while (pos < end) {
    const len = buf[pos];
    const entry = buf.toString('utf8', pos + 1, Math.min(end, pos + 1 + len));
    const eq = entry.indexOf('=');
    if (eq > 0) txt[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
    else if (entry) txt[entry.toLowerCase()] = true;
    pos += 1 + len;
  }
  return txt;
}

/** Parse every resource record (answers + authority + additional). */
function parseRecords(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;

  for (let i = 0; i < qd; i++) {
    pos = readName(buf, pos).next + 4;
  }

  const records = [];
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const { name, next } = readName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const rdLen = buf.readUInt16BE(pos + 8);
    const rdStart = pos + 10;
    const rdEnd = rdStart + rdLen;
    if (rdEnd > buf.length) break;

    const rec = { name: name.toLowerCase(), rawName: name, type };
    if (type === TYPE.PTR) {
      rec.target = readName(buf, rdStart).name;
    } else if (type === TYPE.SRV && rdLen >= 7) {
      rec.port = buf.readUInt16BE(rdStart + 4);
      rec.target = readName(buf, rdStart + 6).name.toLowerCase();
    } else if (type === TYPE.TXT) {
      rec.txt = parseTxt(buf, rdStart, rdEnd);
    } else if (type === TYPE.A && rdLen === 4) {
      rec.address = Array.from(buf.subarray(rdStart, rdEnd)).join('.');
    }
    records.push(rec);
    pos = rdEnd;
  }
  return records;
}

/**
 * Extract advertised service instances for the given service types.
 * Returns [{ name, service, port, txt, address }] — `address` is only set when
 * the response carried a matching A record.
 */
function parseServiceInstances(buf, services) {
  let records;
  try {
    records = parseRecords(buf);
  } catch {
    return [];
  }

  const wanted = services.map((s) => s.toLowerCase());
  const addresses = new Map();
  for (const r of records) if (r.type === TYPE.A && r.address) addresses.set(r.name, r.address);

  const instances = new Map();
  const instanceFor = (fullName, rawFullName) => {
    const lower = fullName.toLowerCase();
    const service = wanted.find((s) => lower.endsWith('.' + s));
    if (!service) return null;
    if (!instances.has(lower)) {
      const raw = rawFullName || fullName;
      instances.set(lower, { name: raw.slice(0, raw.length - service.length - 1), service, port: null, txt: {}, address: null });
    }
    return instances.get(lower);
  };

  for (const r of records) {
    if (r.type === TYPE.PTR && r.target) instanceFor(r.target, r.target);
    else if (r.type === TYPE.SRV) {
      const inst = instanceFor(r.name, r.rawName);
      if (inst) {
        inst.port = r.port;
        inst.address = addresses.get(r.target) || inst.address;
      }
    } else if (r.type === TYPE.TXT) {
      const inst = instanceFor(r.name, r.rawName);
      if (inst) Object.assign(inst.txt, r.txt);
    }
  }
  return [...instances.values()];
}

module.exports = { buildQuery, parseRecords, parseServiceInstances, encodeName, TYPE };
