'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mdns = require('../lib/dante/mdns');
const { SERVICES } = require('../lib/dante/constants');

function record(name, type, rdata) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(0x8001, 2); // IN, cache-flush
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, fixed, rdata]);
}

function txt(entries) {
  return Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([e.length]), Buffer.from(e)])));
}

/** A response like a Dante device sends, using name compression. */
function danteResponse() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6); // answers
  header.writeUInt16BE(3, 10); // additional

  const serviceName = mdns.encodeName(SERVICES.ARC); // at offset 12
  const ptrRdata = Buffer.concat([Buffer.from([10]), Buffer.from('Stagebox-1'), Buffer.from([0xc0, 12])]);
  const ptr = record(serviceName, mdns.TYPE.PTR, ptrRdata);

  const instanceOffset = 12 + serviceName.length + 10; // PTR rdata start
  const instanceName = Buffer.from([0xc0, instanceOffset]);
  const srvRdata = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x11, 0x5c]), mdns.encodeName('stagebox-1.local')]);
  const srv = record(instanceName, mdns.TYPE.SRV, srvRdata);
  const txtRec = record(instanceName, mdns.TYPE.TXT, txt(['mf=ACME', 'model=SB16', 'arcp_vers=2.8.0']));
  const a = record(mdns.encodeName('stagebox-1.local'), mdns.TYPE.A, Buffer.from([169, 254, 1, 2]));

  return Buffer.concat([header, ptr, srv, txtRec, a]);
}

test('parses a Dante service advertisement', () => {
  const [inst] = mdns.parseServiceInstances(danteResponse(), Object.values(SERVICES));
  assert.equal(inst.name, 'Stagebox-1');
  assert.equal(inst.service, SERVICES.ARC);
  assert.equal(inst.port, 4444);
  assert.equal(inst.address, '169.254.1.2');
  assert.equal(inst.txt.mf, 'ACME');
  assert.equal(inst.txt.model, 'SB16');
});

test('ignores unrelated services and garbage', () => {
  assert.deepEqual(mdns.parseServiceInstances(mdns.buildQuery(['_http._tcp.local']), [SERVICES.ARC]), []);
  assert.deepEqual(mdns.parseServiceInstances(Buffer.from('not dns at all'), [SERVICES.ARC]), []);
});

test('compression pointer loops are rejected, not followed forever', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 6);
  const loop = Buffer.concat([header, Buffer.from([0xc0, 12])]);
  assert.deepEqual(mdns.parseServiceInstances(loop, [SERVICES.ARC]), []);
});
