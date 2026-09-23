'use strict';

const os = require('os');
const { execFile, execFileSync } = require('child_process');

const IPV4_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + (parseInt(octet, 10) & 0xff)) >>> 0, 0);
}

function sameSubnet(a, b, netmask) {
  const mask = ipToInt(netmask);
  return (ipToInt(a) & mask) === (ipToInt(b) & mask);
}

/** Non-internal IPv4 interfaces, link-local (Dante default) ones flagged. */
function listInterfaces() {
  const results = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const net of addrs || []) {
      const isV4 = net.family === 'IPv4' || net.family === 4;
      if (!isV4 || net.internal) continue;
      results.push({
        name,
        address: net.address,
        netmask: net.netmask,
        mac: net.mac,
        isDanteLinkLocal: net.address.startsWith('169.254.')
      });
    }
  }
  return results;
}

function pickDefaultInterface(interfaces) {
  return interfaces.find((i) => i.isDanteLinkLocal) || interfaces[0] || null;
}

/**
 * macOS can report a placeholder MAC for some adapters; ifconfig has the real
 * one. Only called when (re)binding, never on a hot path.
 */
function hardwareMac(iface) {
  if (process.platform === 'darwin' && /^[\w.-]+$/.test(iface.name)) {
    try {
      const out = execFileSync('ifconfig', [iface.name], { encoding: 'utf8', timeout: 1000 });
      const m = out.match(/ether\s+([0-9a-fA-F:]{17})/);
      if (m) return m[1].toLowerCase();
    } catch {
      // fall through to the OS-reported MAC
    }
  }
  return iface.mac || '00:00:00:00:00:00';
}

function macToBuffer(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 12 ? Buffer.from(hex, 'hex') : Buffer.alloc(6);
}

function run(cmd, args, timeout = 2000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** IPv4 addresses currently in the OS ARP cache. */
async function readArpTable() {
  const out = await run('arp', process.platform === 'win32' ? ['-a'] : ['-an']);
  const ips = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(IPV4_RE);
    if (m) ips.add(m[1]);
  }
  return [...ips];
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

module.exports = {
  listInterfaces,
  pickDefaultInterface,
  hardwareMac,
  macToBuffer,
  sameSubnet,
  readArpTable,
  openBrowser
};
