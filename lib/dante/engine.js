'use strict';

/**
 * Dante discovery + metering engine.
 *
 * Discovers devices (mDNS, heartbeats, settings multicast, ARP probing), polls
 * them for names / channels / routing / clock status over ARC and the settings
 * protocol, subscribes to their metering streams, and exposes snapshots for
 * the web layer.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');

const {
  SERVICES,
  MULTICAST,
  PORTS,
  ARC_COMMANDS,
  SETTINGS_MESSAGES,
  RX_CONNECTED_STATUSES,
  VALID_SAMPLE_RATES,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
} = require('./constants');
const packets = require('./packets');
const mdns = require('./mdns');
const network = require('./network');
const { IdentityResolver, applyQuirks } = require('./identity');
const { byteToDbfs } = require('../../public/levels');

const TIMING = {
  DISCOVERY_INTERVAL: 3000,
  SUBSCRIPTION_INTERVAL: 2500,
  OFFLINE_AFTER: 7000,
  REMOVE_AFTER: 60000,
  METER_STALE_AFTER: 1500,
  ARP_REPROBE_AFTER: 30000
};

// Dante device names: letters, digits and hyphens (a little looser to be safe).
const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\- ]{0,62}$/;
const LINK_LOCAL = { address: '169.254.0.0', netmask: '255.255.0.0' };

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

class DanteEngine extends EventEmitter {
  constructor({ nic = null, log = noopLog, identity = new IdentityResolver() } = {}) {
    super();
    this.log = log;
    this.identity = identity;
    this.requestedNic = nic;

    this.devices = new Map(); // ip -> device record
    this.sockets = {};
    this.timers = [];
    this.iface = null;
    this.boundMac = Buffer.alloc(6);

    this.seq = 1;
    this.meteringPort = null; // actual UDP port devices stream meters to
    this.arpProbes = new Map(); // ip -> last probe time
    this.arpBusy = false;
    this.localAddresses = new Set();
  }

  get boundIp() {
    return this.iface ? this.iface.address : null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    const interfaces = network.listInterfaces();
    this.log.info('[Dante] Interfaces:', interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'none');

    let iface = null;
    if (this.requestedNic) {
      iface = interfaces.find((i) => i.address === this.requestedNic || i.name === this.requestedNic) || null;
      if (!iface) this.log.warn(`[Dante] Requested NIC "${this.requestedNic}" not found; auto-selecting.`);
    }
    this.bind(iface || network.pickDefaultInterface(interfaces));

    this.timers.push(setInterval(() => this.discoveryTick(), TIMING.DISCOVERY_INTERVAL));
    this.timers.push(setInterval(() => this.subscriptionTick(), TIMING.SUBSCRIPTION_INTERVAL));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopAllMetering();
    this.closeSockets();
  }

  /** Switch to the interface with the given IPv4 address ('all' = wildcard). */
  selectInterface(address) {
    const iface = address && address !== 'all' ? network.listInterfaces().find((i) => i.address === address) : null;
    this.bind(iface || null);
    return this.interfaceInfo();
  }

  interfaceInfo() {
    return { boundIp: this.boundIp, name: this.iface ? this.iface.name : 'All Interfaces' };
  }

  bind(iface) {
    this.stopAllMetering();
    this.closeSockets();
    this.devices.clear();
    this.arpProbes.clear();
    this.iface = iface;
    this.localAddresses = new Set(network.listInterfaces().map((i) => i.address));
    this.boundMac = iface ? network.macToBuffer(network.hardwareMac(iface)) : Buffer.alloc(6);

    if (iface) this.log.info(`[Dante] Bound to ${iface.name} (${iface.address})`);
    else this.log.warn('[Dante] No specific interface selected; listening on all interfaces.');

    this.openSockets();
    this.sendMdnsQueries();
    this.probeArp();
    this.emit('interface', this.interfaceInfo());
  }

  // -------------------------------------------------------------------------
  // Sockets
  // -------------------------------------------------------------------------

  openSockets() {
    const local = this.boundIp || undefined;
    this.openSocket('ARC', { address: local, onMessage: (m, r) => this.handleArc(m, r) });
    this.openSocket('CMC', { address: local, onMessage: (m, r) => this.handleCmc(m, r) });
    this.openSocket('SETTINGS', {
      port: PORTS.INFO,
      group: MULTICAST.INFO,
      onMessage: (m, r) => this.handleSettings(m, r)
    });
    this.openSocket('HEARTBEAT', {
      port: PORTS.HEARTBEAT,
      group: MULTICAST.HEARTBEAT,
      onMessage: (m, r) => this.handleHeartbeat(m, r)
    });
    // Exclusive so a Dante Controller on this machine can't steal our stream
    // (and vice versa); if 8751 is taken, any free port works — devices send
    // to whatever port we put in the subscription request.
    this.meteringPort = null;
    this.openSocket('METERING', {
      port: PORTS.METERING,
      address: local,
      exclusive: true,
      fallbackToEphemeral: true,
      onMessage: (m, r) => this.handleMetering(m, r),
      onListening: (s) => {
        this.meteringPort = s.address().port;
        this.log.info(`[Dante] Metering listener on ${s.address().address}:${this.meteringPort}`);
        for (const ip of this.devices.keys()) this.startMetering(ip);
      }
    });
    // 5353 is usually held by the OS responder; fall back to an ephemeral port
    // (replies then arrive as legacy unicast).
    this.openSocket('MDNS', {
      port: PORTS.MDNS,
      group: MULTICAST.MDNS,
      multicastInterface: true,
      fallbackToEphemeral: true,
      onMessage: (m, r) => this.handleMdns(m, r)
    });
  }

  openSocket(name, opts) {
    const { port = 0, address, group, multicastInterface, fallbackToEphemeral, exclusive, onMessage, onListening } = opts;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: !exclusive });

    sock.on('message', (msg, rinfo) => {
      try {
        onMessage(msg, rinfo);
      } catch (err) {
        this.log.debug(`[${name}] Ignoring malformed packet from ${rinfo.address}: ${err.message}`);
      }
    });

    sock.on('error', (err) => {
      if (this.sockets[name] !== sock) return;
      if (fallbackToEphemeral && port !== 0) {
        this.log.info(`[${name}] Port ${port} is in use (${err.code}); using a free port instead.`);
        sock.close();
        this.openSocket(name, { ...opts, port: 0, fallbackToEphemeral: false });
        return;
      }
      this.log.warn(`[${name}] Socket error: ${err.message}`);
    });

    sock.on('listening', () => {
      if (group) {
        try {
          sock.addMembership(group, this.boundIp || undefined);
        } catch (err) {
          this.log.warn(`[${name}] Could not join ${group}: ${err.message}`);
        }
      }
      if (multicastInterface && this.boundIp) {
        try {
          sock.setMulticastInterface(this.boundIp);
        } catch (err) {
          this.log.debug(`[${name}] setMulticastInterface failed: ${err.message}`);
        }
      }
      if (onListening) onListening(sock);
    });

    this.sockets[name] = sock;
    sock.bind({ port, address });
    return sock;
  }

  /** Close sockets after a short grace period so queued sends (unsubscribes) go out. */
  closeSockets(graceMs = 250) {
    const socks = Object.values(this.sockets);
    this.sockets = {};
    const close = () => {
      for (const sock of socks) {
        try {
          sock.close();
        } catch {
          // already closed
        }
      }
    };
    if (graceMs > 0) setTimeout(close, graceMs).unref();
    else close();
  }

  send(socketName, buf, port, host) {
    const sock = this.sockets[socketName];
    if (!sock || !port || !host) return;
    try {
      sock.send(buf, port, host, (err) => {
        if (err) this.log.debug(`[${socketName}] send to ${host}:${port} failed: ${err.message}`);
      });
    } catch (err) {
      this.log.debug(`[${socketName}] send failed: ${err.message}`);
    }
  }

  nextSeq() {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    return seq;
  }

  // -------------------------------------------------------------------------
  // Outgoing queries
  // -------------------------------------------------------------------------

  sendArc(ip, commandType, args) {
    const dev = this.devices.get(ip);
    this.send('ARC', packets.arcCommand(this.nextSeq(), commandType, args), (dev && dev.ports.ARC) || PORTS.ARC, ip);
  }

  settingsPortFor(ip) {
    const dev = this.devices.get(ip);
    return (dev && dev.ports.SETTINGS) || PORTS.SETTINGS;
  }

  queryName(ip) {
    this.sendArc(ip, ARC_COMMANDS.DEVICE_NAME);
  }

  queryChannelCounts(ip) {
    this.sendArc(ip, ARC_COMMANDS.CHANNEL_COUNTS);
  }

  queryDeviceSettings(ip) {
    this.sendArc(ip, ARC_COMMANDS.DEVICE_SETTINGS);
  }

  queryTxNames(ip) {
    const dev = this.devices.get(ip);
    const pages = packets.pageCount((dev && dev.tx.count) || 16, TX_PAGE_SIZE);
    for (let page = 0; page < pages; page++) this.sendArc(ip, ARC_COMMANDS.TX_FRIENDLY_NAMES, packets.txNamesArgs(page));
  }

  queryRxChannels(ip) {
    const dev = this.devices.get(ip);
    const count = (dev && dev.rx.count) || 16;
    const pages = packets.pageCount(count, RX_PAGE_SIZE);
    for (let page = 0; page < pages; page++) {
      this.sendArc(ip, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(page, count));
    }
  }

  querySettingsPort(ip) {
    const dev = this.devices.get(ip);
    this.send('CMC', packets.cmcSettingsPortQuery(this.nextSeq(), this.boundMac), (dev && dev.ports.CMC) || PORTS.CMC, ip);
  }

  queryClocking(ip) {
    const cmd = packets.clockingQuery(this.nextSeq(), this.boundMac);
    this.send('SETTINGS', cmd, this.settingsPortFor(ip), ip);
    this.send('SETTINGS', cmd, PORTS.INFO, ip);
  }

  queryInterfaces(ip) {
    for (const build of [packets.interfaceControlQuery, packets.interfaceStatusQuery]) {
      const cmd = build(this.nextSeq(), this.boundMac);
      this.send('SETTINGS', cmd, this.settingsPortFor(ip), ip);
      this.send('SETTINGS', cmd, PORTS.INFO, ip);
    }
  }

  /** Local address/MAC a device should stream meters to. */
  subscriberFor(ip) {
    if (this.iface) return { address: this.iface.address, mac: this.boundMac };
    const iface = network.listInterfaces().find((i) => network.sameSubnet(ip, i.address, i.netmask));
    return iface ? { address: iface.address, mac: network.macToBuffer(iface.mac) } : null;
  }

  /** (Re)send the metering subscription; devices expect periodic refreshes. */
  startMetering(ip) {
    const dev = this.devices.get(ip);
    const subscriber = this.subscriberFor(ip);
    if (!dev || !dev.hasName || !this.meteringPort || !subscriber) return;
    const pkt = packets.cmcMeteringRequest(this.nextSeq(), {
      deviceName: dev.name,
      subscriberIp: subscriber.address,
      mac: subscriber.mac,
      port: this.meteringPort
    });
    this.send('CMC', pkt, dev.ports.CMC || PORTS.CMC, ip);
    dev.meteringSubscribed = true;
  }

  stopMetering(ip) {
    const dev = this.devices.get(ip);
    const subscriber = this.subscriberFor(ip);
    if (!dev || !dev.meteringSubscribed || !this.meteringPort || !subscriber) return;
    const pkt = packets.cmcMeteringStop(this.nextSeq(), { deviceName: dev.name, mac: subscriber.mac, port: this.meteringPort });
    this.send('CMC', pkt, dev.ports.CMC || PORTS.CMC, ip);
    dev.meteringSubscribed = false;
  }

  /** Tell devices to stop streaming to us (shutdown / interface change). */
  stopAllMetering() {
    for (const ip of this.devices.keys()) this.stopMetering(ip);
  }

  pollDevice(ip) {
    this.queryName(ip);
    this.queryChannelCounts(ip);
    this.queryDeviceSettings(ip);
    this.queryTxNames(ip);
    this.queryRxChannels(ip);
    this.queryClocking(ip);
    this.queryInterfaces(ip);
  }

  sendMdnsQueries() {
    for (const service of Object.values(SERVICES)) {
      this.send('MDNS', mdns.buildQuery([service]), PORTS.MDNS, MULTICAST.MDNS);
    }
  }

  // -------------------------------------------------------------------------
  // Periodic work
  // -------------------------------------------------------------------------

  discoveryTick() {
    const interfaces = network.listInterfaces();
    this.localAddresses = new Set(interfaces.map((i) => i.address));
    if (this.iface) {
      if (!interfaces.some((i) => i.address === this.boundIp)) {
        this.log.warn(`[Dante] Interface ${this.boundIp} disappeared; re-binding.`);
        this.bind(network.pickDefaultInterface(interfaces));
        return;
      }
    }

    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen > TIMING.REMOVE_AFTER) {
        this.log.info(`[Dante] Removed device that has been offline for a while: ${dev.name} (${ip})`);
        this.devices.delete(ip);
      }
    }

    this.sendMdnsQueries();
    this.probeArp();
    for (const ip of this.devices.keys()) this.pollDevice(ip);
  }

  subscriptionTick() {
    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen <= TIMING.OFFLINE_AFTER) this.startMetering(ip);
    }
  }

  async probeArp() {
    if (this.arpBusy) return;
    this.arpBusy = true;
    try {
      const subnet = this.iface || LINK_LOCAL;
      const ips = await network.readArpTable();
      const now = Date.now();
      for (const ip of ips) {
        if (ip === this.boundIp || ip.endsWith('.255') || this.devices.has(ip)) continue;
        if (!network.sameSubnet(ip, subnet.address, subnet.netmask)) continue;
        const last = this.arpProbes.get(ip);
        if (last && now - last < TIMING.ARP_REPROBE_AFTER) continue;
        // Only registered once the host answers on ARC.
        this.arpProbes.set(ip, now);
        this.queryName(ip);
        this.queryChannelCounts(ip);
      }
    } catch (err) {
      this.log.debug(`[ARP] ${err.message}`);
    } finally {
      this.arpBusy = false;
    }
  }

  /** Drop offline devices immediately and re-poll everything. */
  refresh() {
    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen > TIMING.OFFLINE_AFTER) this.devices.delete(ip);
    }
    this.arpProbes.clear();
    this.sendMdnsQueries();
    this.probeArp();
    for (const ip of this.devices.keys()) {
      this.pollDevice(ip);
      this.querySettingsPort(ip);
      this.startMetering(ip);
    }
  }

  // -------------------------------------------------------------------------
  // Device records
  // -------------------------------------------------------------------------

  register(ip, name) {
    let dev = this.devices.get(ip);
    const now = Date.now();
    if (!dev) {
      dev = {
        ip,
        name: ip,
        hasName: false,
        ports: { ARC: PORTS.ARC, CMC: PORTS.CMC, SETTINGS: PORTS.SETTINGS },
        mac: null,
        mdnsMf: null,
        mdnsModel: null,
        manufacturer: null,
        modelName: null,
        productVersion: null,
        softwareVersion: null,
        firmwareVersion: null,
        sampleRate: null,
        tx: { count: 0, channels: {} },
        rx: { count: 0, channels: {} },
        meters: { tx: {}, rx: {} },
        clock: null,
        numPorts: null,
        secondaryLinkUp: null,
        secondaryIp: null,
        firstSeen: now,
        lastSeen: now
      };
      if (name && DEVICE_NAME_RE.test(name)) {
        dev.name = name;
        dev.hasName = true;
      }
      this.devices.set(ip, dev);
      this.log.info(`[Dante] Discovered ${dev.name} (${ip})`);
      this.identity.resolve(dev);
      this.pollDevice(ip);
      this.querySettingsPort(ip);
      this.startMetering(ip);
    } else {
      if (now - dev.lastSeen > TIMING.OFFLINE_AFTER) this.log.info(`[Dante] ${dev.name} (${ip}) is back online`);
      dev.lastSeen = now;
      if (name) this.setName(dev, name);
    }
    return dev;
  }

  setName(dev, name) {
    if (!name || !DEVICE_NAME_RE.test(name) || (dev.hasName && dev.name === name)) return;
    const previous = dev.hasName ? dev.name : null;
    if (previous) this.stopMetering(dev.ip);
    dev.name = name;
    dev.hasName = true;
    if (previous) this.log.info(`[Dante] ${dev.ip} renamed: ${previous} -> ${name}`);
    this.identity.resolve(dev);
    this.startMetering(dev.ip);
  }

  setChannelCount(dev, dir, count) {
    const block = dev[dir];
    const prefix = dir === 'tx' ? 'Tx' : 'Rx';
    const changed = block.count !== count;
    block.count = count;
    for (const key of Object.keys(block.channels)) {
      if (Number(key) > count) delete block.channels[key];
    }
    for (let i = 1; i <= count; i++) {
      if (!block.channels[i]) block.channels[i] = { number: i, name: `${prefix} ${i}` };
    }
    return changed;
  }

  recordLevels(dev, dir, firstChannel, bytes, now) {
    const block = dev[dir];
    const meters = dev.meters[dir];
    for (let i = 0; i < bytes.length; i++) {
      const ch = firstChannel + i;
      if (block.count && ch > block.count) break;
      meters[ch] = { peak: bytes[i], at: now };
    }
  }

  // -------------------------------------------------------------------------
  // Incoming packets
  // -------------------------------------------------------------------------

  handleArc(msg, rinfo) {
    const reply = packets.parseArcReply(msg);
    if (!reply) return;
    const dev = this.register(rinfo.address);

    switch (reply.commandId) {
      case ARC_COMMANDS.CHANNEL_COUNTS: {
        const txChanged = this.setChannelCount(dev, 'tx', reply.txCount);
        const rxChanged = this.setChannelCount(dev, 'rx', reply.rxCount);
        if (txChanged || rxChanged) {
          this.identity.resolve(dev);
          if (txChanged) this.queryTxNames(dev.ip);
          if (rxChanged) this.queryRxChannels(dev.ip);
        }
        break;
      }
      case ARC_COMMANDS.DEVICE_NAME:
        this.setName(dev, reply.name);
        break;
      case ARC_COMMANDS.TX_FRIENDLY_NAMES:
        for (const ch of reply.channels) {
          if (dev.tx.count && ch.number > dev.tx.count) continue;
          const entry = dev.tx.channels[ch.number] || (dev.tx.channels[ch.number] = { number: ch.number, name: `Tx ${ch.number}` });
          if (ch.name) entry.name = ch.name;
        }
        break;
      case ARC_COMMANDS.RX_CHANNELS:
        for (const ch of reply.channels) {
          if (dev.rx.count && ch.number > dev.rx.count) continue;
          // "." means the receiver is subscribed to one of its own transmitters.
          const txDevice = ch.txDevice === '.' ? dev.name : ch.txDevice;
          dev.rx.channels[ch.number] = {
            number: ch.number,
            name: ch.name || `Rx ${ch.number}`,
            subscribedDevice: txDevice,
            subscribedChannel: ch.txChannel,
            status: ch.status,
            connected: RX_CONNECTED_STATUSES.has(ch.status)
          };
        }
        applyQuirks(dev);
        break;
      case ARC_COMMANDS.DEVICE_SETTINGS:
        if (VALID_SAMPLE_RATES.includes(reply.sampleRate)) dev.sampleRate = reply.sampleRate;
        break;
    }
  }

  handleSettings(msg, rinfo) {
    const reply = packets.parseSettingsReply(msg);
    if (!reply) return;
    const dev = this.register(rinfo.address);
    if (reply.mac) dev.mac = reply.mac;
    if (reply.clock) dev.clock = reply.clock;
    if (reply.secondaryIp) dev.secondaryIp = reply.secondaryIp;
  }

  handleCmc(msg, rinfo) {
    const reply = packets.parseCmcReply(msg);
    const dev = this.devices.get(rinfo.address);
    if (!reply || !dev) return;
    dev.lastSeen = Date.now();
    if (reply.settingsPort) dev.ports.SETTINGS = reply.settingsPort;
  }

  handleHeartbeat(msg, rinfo) {
    const hb = packets.parseHeartbeat(msg);
    if (!hb) return;
    const dev = this.register(rinfo.address);
    if (hb.mac) dev.mac = hb.mac;
    if (hb.ports) {
      dev.numPorts = hb.ports.numPorts;
      dev.secondaryLinkUp = hb.ports.secondaryLinkUp;
    }
    if (hb.levels) {
      const now = Date.now();
      this.recordLevels(dev, 'tx', hb.levels.txFirst, hb.levels.tx, now);
      this.recordLevels(dev, 'rx', hb.levels.rxFirst, hb.levels.rx, now);
    }
  }

  handleMetering(msg, rinfo) {
    const levels = packets.parseMeteringPacket(msg);
    if (!levels) return;
    const dev = this.register(rinfo.address);
    if (levels.mac) dev.mac = levels.mac;
    // Only size channels from the meter stream until ARC has reported counts.
    let grew = false;
    if (!dev.tx.count && levels.tx.length) grew = this.setChannelCount(dev, 'tx', levels.tx.length) || grew;
    if (!dev.rx.count && levels.rx.length) grew = this.setChannelCount(dev, 'rx', levels.rx.length) || grew;
    if (grew) applyQuirks(dev);
    if (!dev.meteringSeen) {
      dev.meteringSeen = true;
      this.log.info(`[Dante] Receiving meters from ${dev.name} (${dev.ip}): ${levels.tx.length} Tx / ${levels.rx.length} Rx`);
    }
    const now = Date.now();
    this.recordLevels(dev, 'tx', 1, levels.tx, now);
    this.recordLevels(dev, 'rx', 1, levels.rx, now);
  }

  handleMdns(msg, rinfo) {
    const instances = mdns.parseServiceInstances(msg, Object.values(SERVICES));
    for (const inst of instances) {
      // Without an A record the sender is assumed to be the device — unless the
      // sender is this machine, whose own responder answers legacy-unicast
      // queries from its cache on behalf of other hosts.
      const ip = inst.address || (this.localAddresses.has(rinfo.address) ? null : rinfo.address);
      if (!ip) continue;
      const dev = this.register(ip, inst.name);
      if (inst.port && inst.service === SERVICES.ARC) dev.ports.ARC = inst.port;
      if (inst.port && inst.service === SERVICES.CMC) dev.ports.CMC = inst.port;
      const { mf, model } = inst.txt;
      if ((mf && mf !== dev.mdnsMf) || (model && model !== dev.mdnsModel)) {
        if (typeof mf === 'string') dev.mdnsMf = mf;
        if (typeof model === 'string') dev.mdnsModel = model;
        this.identity.resolve(dev);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  isOnline(dev, now = Date.now()) {
    return now - dev.lastSeen <= TIMING.OFFLINE_AFTER;
  }

  clockLeaders() {
    const votes = new Map();
    for (const dev of this.devices.values()) {
      const gm = dev.clock && dev.clock.grandmasterUuid;
      if (gm && !/^0+$/.test(gm)) votes.set(gm, (votes.get(gm) || 0) + 1);
    }
    let grandmaster = null;
    let best = 0;
    for (const [gm, count] of votes) {
      if (count > best) [grandmaster, best] = [gm, count];
    }
    // PTP clock identities are the leader's MAC followed by two zero bytes, so
    // the leader is found even when it doesn't answer clock queries itself.
    const gmMac = grandmaster ? grandmaster.slice(0, 12) : null;
    const leaders = new Set();
    for (const dev of this.devices.values()) {
      const byClock = dev.clock && (dev.clock.isMaster || (grandmaster && dev.clock.uuid === grandmaster));
      if (byClock || (gmMac && dev.mac === gmMac)) leaders.add(dev.ip);
    }
    return leaders;
  }

  syncStatus(dev, online, isLeader) {
    const clk = dev.clock;
    const clockFault = Boolean(clk && (clk.servo === 0 || clk.servo === 1));

    let primary;
    if (!online) primary = 'error';
    else if (isLeader) primary = 'good';
    else if (!clk) primary = 'none';
    else if (clk.servo === 3) primary = 'good';
    else if (clk.servo === 2) primary = 'syncing';
    else if (clockFault || clk.state === 1) primary = 'error';
    else primary = 'good';

    const ports = dev.numPorts !== null ? dev.numPorts : clk ? clk.numPorts : null;
    let secondary;
    if (ports !== null && ports < 2) secondary = 'unsupported';
    else if (dev.secondaryLinkUp === false || !online) secondary = 'error';
    else if (ports === null && dev.secondaryLinkUp === null) secondary = 'none';
    else if (clockFault) secondary = 'error';
    else if (!clk && dev.secondaryLinkUp === null) secondary = 'none';
    else secondary = 'good';

    return {
      primarySync: primary,
      secondarySync: secondary,
      secondarySupported: secondary !== 'unsupported',
      secondaryLinkUp: dev.secondaryLinkUp
    };
  }

  /** Device structure (everything except live levels). */
  getDevices() {
    const now = Date.now();
    const leaders = this.clockLeaders();
    return [...this.devices.values()].map((dev) => {
      const online = this.isOnline(dev, now);
      const isClockLeader = leaders.has(dev.ip);
      return {
        ip: dev.ip,
        name: dev.name,
        online,
        manufacturer: dev.manufacturer,
        modelName: dev.modelName,
        productVersion: dev.productVersion,
        softwareVersion: dev.softwareVersion,
        firmwareVersion: dev.firmwareVersion,
        sampleRate: dev.sampleRate,
        isClockLeader,
        secondaryIp: dev.secondaryIp,
        ...this.syncStatus(dev, online, isClockLeader),
        tx: { count: dev.tx.count, channels: dev.tx.channels },
        rx: { count: dev.rx.count, channels: dev.rx.channels }
      };
    });
  }

  /**
   * Current peak bytes per device/direction (array index 0 = channel 1,
   * null = no recent data). When a device doesn't report its own levels for a
   * channel, the level is inferred from the other end of a Dante subscription
   * and the channel is listed under `mirrored`.
   */
  getMeterFrame(now = Date.now()) {
    const live = (dev, dir, ch) => {
      const m = dev.meters[dir][ch];
      return m && now - m.at <= TIMING.METER_STALE_AFTER ? m.peak : null;
    };
    const devices = [...this.devices.values()].filter((d) => this.isOnline(d, now));
    const byName = new Map();
    for (const d of devices) {
      byName.set(d.ip, d);
      if (d.hasName) byName.set(d.name.toLowerCase(), d);
    }

    // Index native Rx levels by (source device, source channel) for Tx inference.
    const rxBySource = new Map();
    for (const d of devices) {
      for (const ch of Object.values(d.rx.channels)) {
        if (!ch.connected || !ch.subscribedDevice || !ch.subscribedChannel) continue;
        const peak = live(d, 'rx', ch.number);
        if (peak !== null) rxBySource.set(sourceKey(ch.subscribedDevice, ch.subscribedChannel), peak);
      }
    }

    const frame = {};
    for (const dev of devices) {
      const tx = [];
      const rx = [];
      const mirrored = { tx: [], rx: [] };

      for (let ch = 1; ch <= dev.tx.count; ch++) {
        let peak = live(dev, 'tx', ch);
        if (peak === null) {
          const name = (dev.tx.channels[ch] && dev.tx.channels[ch].name) || '';
          peak = rxBySource.get(sourceKey(dev.name, name));
          if (peak === undefined) peak = rxBySource.get(sourceKey(dev.name, String(ch).padStart(2, '0')));
          if (peak === undefined) peak = null;
          else mirrored.tx.push(ch);
        }
        tx.push(peak);
      }

      for (let ch = 1; ch <= dev.rx.count; ch++) {
        let peak = live(dev, 'rx', ch);
        const sub = dev.rx.channels[ch];
        if (peak === null && sub && sub.connected && sub.subscribedDevice) {
          const src = byName.get(sub.subscribedDevice.toLowerCase()) || byName.get(sub.subscribedDevice);
          const srcCh = src && findTxChannel(src, sub.subscribedChannel);
          const srcPeak = srcCh ? live(src, 'tx', srcCh) : null;
          if (srcPeak !== null) {
            peak = srcPeak;
            mirrored.rx.push(ch);
          }
        }
        rx.push(peak);
      }

      const entry = { tx, rx };
      if (mirrored.tx.length || mirrored.rx.length) entry.mirrored = mirrored;
      frame[dev.ip] = entry;
    }
    return frame;
  }

  /**
   * Rich snapshot for the JSON API: structure plus levels. `peak` is the raw
   * Dante byte (null = no recent data); `dbfs` is null for silence or no data.
   */
  getSnapshot() {
    const frame = this.getMeterFrame();
    const levels = (peaks) => ({
      peak: peaks,
      dbfs: peaks.map((p) => {
        const db = byteToDbfs(p);
        return isFinite(db) ? db : null;
      })
    });
    return {
      timestamp: Date.now(),
      boundIp: this.boundIp,
      devices: this.getDevices().map((d) => {
        const f = frame[d.ip];
        return f ? { ...d, levels: { tx: levels(f.tx), rx: levels(f.rx) } } : d;
      })
    };
  }
}

function sourceKey(device, channel) {
  return `${String(device).toLowerCase()}\u0000${String(channel).toLowerCase()}`;
}

function findTxChannel(dev, channelName) {
  if (!channelName) return null;
  const wanted = channelName.trim().toLowerCase();
  for (const ch of Object.values(dev.tx.channels)) {
    if (ch.name && ch.name.trim().toLowerCase() === wanted) return ch.number;
  }
  const m = wanted.match(/^(\d+)/);
  const n = m ? parseInt(m[1], 10) : null;
  return n && n <= dev.tx.count ? n : null;
}

module.exports = { DanteEngine, TIMING };
