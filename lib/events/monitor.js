'use strict';

/**
 * Network monitor: compares successive snapshots of the Dante engine's view of
 * the network and records what changed in the event log.
 *
 * Healthy states are not logged when first seen (no flood of "locked" entries
 * at startup); abnormal ones are. Simultaneous subscription changes on one
 * receiver are grouped into a single entry.
 */

const {
  RX_CONNECTED_STATUSES,
  RX_PENDING_STATUSES,
  SUBSCRIPTION_STATUS_NAMES,
  CLOCK_MUTE_REASONS
} = require('../dante/constants');
const { sameSubnet } = require('../dante/network');

const TIMING = {
  CHECK_INTERVAL: 1000,
  NAME_WAIT: 5000, // wait this long for a device name before logging "online" with its IP
  RESPONSE_TIMEOUT: 12000, // heartbeating but not answering queries for this long
  LATE_PACKET_LOG_EVERY: 30000,
  CLOCK_WARNING_RATIO: 0.8, // of the device's maximum drift
  CLOCK_WARNING_CLEAR_RATIO: 0.6
};

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function clockSync(clock) {
  if (!clock) return null;
  if (clock.servo === 3) return 'locked';
  if (clock.servo === 2) return 'syncing';
  if (clock.servo === 0 || clock.servo === 1) return 'lost';
  return null;
}

function muteReasons(flags) {
  const reasons = CLOCK_MUTE_REASONS.filter(([bit]) => flags & bit).map(([, name]) => name);
  return reasons.length ? reasons.join(', ') : 'unknown reason';
}

function subscriptionClass(ch) {
  if (!ch.subscribedDevice || !ch.subscribedChannel) return 'none';
  if (RX_CONNECTED_STATUSES.has(ch.status) || (ch.status === 1 && ch.rxStatus === 0x0101)) return 'connected';
  if (RX_PENDING_STATUSES.has(ch.status)) return 'pending';
  return 'error';
}

function channelLabel(ch) {
  return ch.name && ch.name !== `Rx ${ch.number}` ? `${ch.number} (${ch.name})` : String(ch.number);
}

/** "Mic-Rx / 01" for one channel, "Mic-Rx / 01, 02, 03" for several from one device. */
function sources(chs) {
  const byDevice = new Map();
  for (const ch of chs) {
    if (!byDevice.has(ch.subscribedDevice)) byDevice.set(ch.subscribedDevice, []);
    byDevice.get(ch.subscribedDevice).push(ch.subscribedChannel);
  }
  return [...byDevice].map(([device, channels]) => `${device} / ${channels.join(', ')}`).join('; ');
}

function listChannels(chs) {
  const labels = chs.map(channelLabel);
  return `${chs.length === 1 ? 'channel' : 'channels'} ${labels.join(', ')}`;
}

class NetworkMonitor {
  /**
   * @param {{getMonitorSnapshot: (now: number) => object, on?: Function}} engine
   * @param {import('./event-log').EventLog} eventLog
   */
  constructor({ engine, eventLog, timing = {} }) {
    this.engine = engine;
    this.eventLog = eventLog;
    this.timing = { ...TIMING, ...timing };
    this.timer = null;
    this.reset();
  }

  reset() {
    this.devices = new Map(); // ip -> tracked state
    this.offlineSince = new Map(); // device name -> time it went offline (survives removal)
    this.leaders = null;
    this.multipleLeaders = false;
    this.health = { multicastBlocked: false, meteringBlocked: false };
  }

  start() {
    this.engine.on?.('interface', (info) => this.onInterface(info));
    this.timer = setInterval(() => this.check(), this.timing.CHECK_INTERVAL);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  onInterface(info) {
    // Devices are cleared on an interface change; don't log them all as offline.
    this.reset();
    if (info?.boundIp) {
      this.add('monitoring_started', { message: `Monitoring ${info.name} (${info.boundIp})` });
    } else {
      this.add('monitoring_started', { message: 'Monitoring all interfaces' });
    }
  }

  interfaceLost(address) {
    this.reset();
    this.add('interface_lost', { message: `Network interface ${address} disappeared; switching interface` });
  }

  add(type, fields) {
    return this.eventLog.add(type, { time: this.now, ...fields });
  }

  check(now = Date.now()) {
    this.now = now;
    const snap = this.engine.getMonitorSnapshot(now);
    const seen = new Set();

    for (const dev of snap.devices) {
      seen.add(dev.ip);
      this.checkDevice(dev, snap, now);
    }
    // Removed devices: keep their offline time so a return can report the outage.
    for (const ip of this.devices.keys()) {
      if (!seen.has(ip)) this.devices.delete(ip);
    }
    this.checkLeaders(snap);
    if (snap.health) this.checkHealth(snap.health);
  }

  checkHealth(health) {
    const firewallHint =
      health.platform === 'win32'
        ? ' On Windows, allow Node.js through Windows Defender Firewall on Public networks (the Dante network is usually "Unidentified network").'
        : ' Check that a firewall allows incoming UDP for Node.js on the Dante interface.';
    if (health.multicastBlocked && !this.health.multicastBlocked) {
      this.add('multicast_missing', { message: `Devices answer queries, but no heartbeats are arriving, so sync and secondary-network status are unavailable.${firewallHint}` });
    } else if (!health.multicastBlocked && this.health.multicastBlocked) {
      this.add('multicast_restored', { message: 'Heartbeats are arriving again' });
    }
    if (health.meteringBlocked && !this.health.meteringBlocked) {
      this.add('metering_missing', { message: `Meter streams were requested but none are arriving.${firewallHint}` });
    } else if (!health.meteringBlocked && this.health.meteringBlocked) {
      this.add('metering_restored', { message: 'Meter streams are arriving again' });
    }
    this.health = { multicastBlocked: health.multicastBlocked, meteringBlocked: health.meteringBlocked };
  }

  checkDevice(dev, snap, now) {
    let s = this.devices.get(dev.ip);
    const isNew = !s;
    if (isNew) {
      s = { firstSeen: now, announced: false, online: dev.online, name: dev.name, subs: new Map() };
      this.devices.set(dev.ip, s);
    }
    const entry = (extra) => ({ device: dev.name, ip: dev.ip, ...extra });

    // --- online / offline -------------------------------------------------
    if (!s.announced) {
      if (!dev.online) return;
      if (!dev.hasName && now - s.firstSeen < this.timing.NAME_WAIT) return;
      const since = this.offlineSince.get(dev.name.toLowerCase());
      this.offlineSince.delete(dev.name.toLowerCase());
      this.add(
        'device_online',
        entry({ message: since ? `Back online after ${formatDuration(now - since)}` : 'Discovered on the network' })
      );
      s.announced = true;
      s.online = true;
      s.name = dev.name;
    } else if (s.online && !dev.online) {
      s.online = false;
      this.offlineSince.set(dev.name.toLowerCase(), dev.lastSeen || now);
      this.add('device_offline', entry({ message: `No response for ${formatDuration(now - (dev.lastSeen || now))}` }));
    } else if (!s.online && dev.online) {
      const since = this.offlineSince.get(dev.name.toLowerCase());
      this.offlineSince.delete(dev.name.toLowerCase());
      this.add('device_online', entry({ message: since ? `Back online after ${formatDuration(now - since)}` : 'Back online' }));
      s.online = true;
    }
    if (!s.online) return; // other conditions are meaningless while it's gone

    // --- configuration -------------------------------------------------------
    if (dev.hasName && s.name !== dev.name) {
      if (s.name && s.name !== dev.ip) {
        this.add('device_renamed', entry({ message: `Renamed from "${s.name}" to "${dev.name}"` }));
      }
      s.name = dev.name;
    }
    if (dev.sampleRate) {
      if (s.sampleRate && s.sampleRate !== dev.sampleRate) {
        this.add('sample_rate_changed', entry({ message: `${s.sampleRate / 1000} kHz -> ${dev.sampleRate / 1000} kHz` }));
      }
      s.sampleRate = dev.sampleRate;
    }

    // --- clock sync ------------------------------------------------------------
    const sync = clockSync(dev.clock);
    if (sync === 'lost' && s.sync !== 'lost') {
      this.add('clock_unlocked', entry({ message: 'Lost sync with the clock leader (device mutes until it regains sync)' }));
    } else if (sync === 'locked' && s.sync === 'lost') {
      this.add('clock_locked', entry({ message: 'Regained sync with the clock leader' }));
    }
    // "Syncing" is a transition, not a state change worth logging: hold the previous one.
    if (sync === 'lost' || sync === 'locked') s.sync = sync;

    const offset = dev.clockOffsetPpb ?? dev.clock?.frequencyOffsetPpb ?? null;
    const maxDrift = dev.clock?.maxDriftPpb;
    if (offset !== null && maxDrift > 0) {
      const ratio = Math.abs(offset) / maxDrift;
      if (!s.clockWarning && ratio >= this.timing.CLOCK_WARNING_RATIO) {
        s.clockWarning = true;
        this.add(
          'clock_warning',
          entry({ message: `Clock unstable: offset ${(offset / 1000).toFixed(1)} ppm, ${Math.round(ratio * 100)}% of its ${(maxDrift / 1000).toFixed(0)} ppm limit` })
        );
      } else if (s.clockWarning && ratio < this.timing.CLOCK_WARNING_CLEAR_RATIO) {
        s.clockWarning = false;
      }
    }

    // --- audio mute -----------------------------------------------------------
    const mute = dev.clock?.muteFlags;
    if (mute !== null && mute !== undefined) {
      if (mute && !s.muteFlags) {
        this.add('audio_mute', entry({ message: `Muted: ${muteReasons(mute)}` }));
      } else if (!mute && s.muteFlags) {
        this.add('audio_unmute', entry({ message: 'Un-muted' }));
      }
      s.muteFlags = mute;
    }

    // --- network ------------------------------------------------------------------
    if (snap.iface && dev.ip !== s.checkedIp) {
      s.checkedIp = dev.ip;
      if (!sameSubnet(dev.ip, snap.iface.address, snap.iface.netmask)) {
        this.add('subnet_mismatch', entry({ message: `Primary address ${dev.ip} is not in this interface's subnet (${snap.iface.address}/${snap.iface.netmask})` }));
      }
    }
    if (snap.iface && dev.secondaryIp && dev.secondaryIp !== s.checkedSecondary) {
      s.checkedSecondary = dev.secondaryIp;
      if (sameSubnet(dev.ip, dev.secondaryIp, snap.iface.netmask)) {
        this.add('subnet_conflict', entry({ message: `Primary ${dev.ip} and secondary ${dev.secondaryIp} are on the same subnet` }));
      }
    }

    if (dev.numPorts >= 2 && dev.secondaryLinkUp !== null && dev.secondaryLinkUp !== undefined) {
      if (dev.secondaryLinkUp === false && s.secondaryLinkUp !== false) {
        this.add('secondary_link_down', entry({ message: 'Secondary network port has no link' }));
      } else if (dev.secondaryLinkUp === true && s.secondaryLinkUp === false) {
        this.add('secondary_link_up', entry({ message: 'Secondary network port link restored' }));
      }
      s.secondaryLinkUp = dev.secondaryLinkUp;
    }

    if (Number.isFinite(dev.latePackets)) {
      if (s.latePackets === undefined || dev.latePackets < s.latePackets) {
        s.latePackets = dev.latePackets; // baseline / counter reset
        s.latePending = 0;
      } else if (dev.latePackets > s.latePackets) {
        s.latePending = (s.latePending || 0) + dev.latePackets - s.latePackets;
        s.latePackets = dev.latePackets;
      }
      if (s.latePending > 0 && now - (s.lateLoggedAt || 0) >= this.timing.LATE_PACKET_LOG_EVERY) {
        this.add('late_packets', entry({ message: `${s.latePending} late packet${s.latePending === 1 ? '' : 's'} received`, details: { count: s.latePending } }));
        s.latePending = 0;
        s.lateLoggedAt = now;
      }
    }

    // --- timeouts -------------------------------------------------------------
    if (dev.lastArcReplyAt) {
      const silent = now - dev.lastArcReplyAt;
      if (!s.timedOut && silent >= this.timing.RESPONSE_TIMEOUT) {
        s.timedOut = true;
        this.add('response_timeout', entry({ message: `Still on the network but not answering queries for ${formatDuration(silent)}` }));
      } else if (s.timedOut && silent < this.timing.RESPONSE_TIMEOUT) {
        s.timedOut = false;
        this.add('response_restored', entry({ message: 'Answering queries again' }));
      }
    }

    // --- subscriptions -------------------------------------------------------
    this.checkSubscriptions(dev, s, entry);
  }

  checkSubscriptions(dev, s, entry) {
    // Channels that change the same way at the same moment (e.g. every channel
    // fed by a transmitter that just vanished) are logged as one entry.
    const groups = new Map();
    const group = (type, key, describe, ch) => {
      const id = `${type}|${key}`;
      if (!groups.has(id)) groups.set(id, { type, describe, channels: [] });
      groups.get(id).channels.push(ch);
    };

    for (const ch of dev.rx) {
      const cls = subscriptionClass(ch);
      const source = cls === 'none' ? null : `${ch.subscribedDevice} / ${ch.subscribedChannel}`;
      const prev = s.subs.get(ch.number);
      s.subs.set(ch.number, { cls: cls === 'pending' && prev ? prev.cls : cls, source });
      if (cls === 'pending') continue;

      if (prev && prev.source !== source) {
        const what = source ? `now ${source}` : 'unsubscribed';
        group('routing_changed', `${ch.number}`, () => `${what}${prev.source ? ` (was ${prev.source})` : ''}`, ch);
        if (cls !== 'error') continue;
      }
      if (cls === 'error' && (!prev || prev.cls !== 'error' || prev.source !== source)) {
        const name = SUBSCRIPTION_STATUS_NAMES[ch.status] || `status ${ch.status}`;
        const type = ch.status === 1 || ch.status === 3 ? 'subscription_unresolved' : 'subscription_failed';
        group(type, `${ch.status}|${ch.subscribedDevice}`, (chs) => `${name} (${sources(chs)})`, ch);
      } else if (cls === 'connected' && prev?.cls === 'error' && prev.source === source) {
        group('subscription_restored', ch.subscribedDevice, (chs) => `connected again (${sources(chs)})`, ch);
      }
    }

    for (const g of groups.values()) {
      this.add(g.type, entry({
        message: `${listChannels(g.channels)}: ${g.describe(g.channels)}`,
        details: { channels: g.channels.map((c) => ({ number: c.number, source: c.subscribedDevice ? `${c.subscribedDevice} / ${c.subscribedChannel}` : null })) }
      }));
    }
  }

  checkLeaders(snap) {
    const current = new Set(snap.leaders);
    if (this.leaders === null) {
      // First look: report the leader without treating it as a change.
      if (current.size) {
        for (const name of current) {
          this.add('leader_elevated', { device: name, severity: 'info', message: 'Is the clock leader' });
        }
        this.leaders = current;
      }
    } else {
      for (const name of current) {
        if (!this.leaders.has(name)) this.add('leader_elevated', { device: name, message: 'Became the clock leader' });
      }
      for (const name of this.leaders) {
        if (!current.has(name)) this.add('leader_demoted', { device: name, message: 'No longer the clock leader' });
      }
      this.leaders = current;
    }

    const multiple = current.size > 1;
    if (multiple && !this.multipleLeaders) {
      this.add('multiple_leaders', { message: `More than one clock leader: ${[...current].join(', ')}` });
    }
    this.multipleLeaders = multiple;
  }
}

module.exports = { NetworkMonitor, TIMING, formatDuration };
