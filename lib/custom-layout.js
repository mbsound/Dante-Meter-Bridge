'use strict';

/**
 * The "Custom" tab layout: hand-picked Tx and Rx channels, grouped by device.
 * Kept on the bridge (one JSON file) so every screen viewing it shows the same
 * layout and it survives restarts. Devices are keyed by name, not IP, so a
 * layout still applies after a device gets a new link-local address.
 *
 * Shape: { devices: [{ name, tx: [channel numbers], rx: [channel numbers] }] }
 * Device order is the order they were added; channels are kept sorted.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LIMITS = { devices: 128, channelsPerDirection: 1024, maxChannel: 4096, nameLength: 64 };

/** Return a clean copy of a layout, or throw if it can't be one. */
function validateLayout(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.devices)) {
    throw new Error('layout must be an object with a "devices" array');
  }
  if (input.devices.length > LIMITS.devices) throw new Error(`at most ${LIMITS.devices} devices`);

  const seen = new Set();
  const devices = [];
  for (const entry of input.devices) {
    if (!entry || typeof entry.name !== 'string') throw new Error('each device needs a name');
    const name = entry.name.trim();
    if (!name || name.length > LIMITS.nameLength) throw new Error('invalid device name');
    if (seen.has(name)) continue;
    seen.add(name);
    const channels = (list) => {
      if (list === undefined) return [];
      if (!Array.isArray(list) || list.length > LIMITS.channelsPerDirection) throw new Error(`invalid channel list for ${name}`);
      const set = new Set();
      for (const n of list) {
        if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxChannel) throw new Error(`invalid channel number for ${name}`);
        set.add(n);
      }
      return [...set].sort((a, b) => a - b);
    };
    const tx = channels(entry.tx);
    const rx = channels(entry.rx);
    if (tx.length || rx.length) devices.push({ name, tx, rx });
  }
  return { devices };
}

class CustomLayout extends EventEmitter {
  /** @param {{ file?: string|null, log?: object }} opts  file = null keeps it in memory only */
  constructor({ file = null, log = { warn() {} } } = {}) {
    super();
    this.file = file;
    this.log = log;
    this.layout = { devices: [] };
  }

  load() {
    if (!this.file) return this;
    try {
      this.layout = validateLayout(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[Custom] Ignoring unreadable ${this.file}: ${err.message}`);
    }
    return this;
  }

  get() {
    return this.layout;
  }

  /** Replace the layout (validated), save it and notify listeners. */
  set(input) {
    this.layout = validateLayout(input);
    this.save();
    this.emit('changed', this.layout);
    return this.layout;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.layout, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn(`[Custom] Could not save ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { CustomLayout, validateLayout, LIMITS };
