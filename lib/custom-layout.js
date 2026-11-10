'use strict';

/**
 * Saved layouts for the "Custom" tab. Each layout is a named set of
 * hand-picked Tx and Rx channels, grouped by device. The library is kept on the
 * bridge (one JSON file) so it survives restarts and every screen can open any
 * layout; which layout a screen shows is that screen's own choice.
 *
 * File shape: { version: 2, layouts: [{ name, devices: [{ name, tx: [ch], rx: [ch] }] }] }
 * Devices are keyed by name, not IP, so a layout still applies after a device
 * gets a new link-local address. Version 1 files ({ devices }) are migrated to a
 * single layout called "Layout 1".
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LIMITS = { layouts: 100, layoutName: 48, devices: 128, channelsPerDirection: 1024, maxChannel: 4096, nameLength: 64 };
const DEFAULT_NAME = 'Layout 1';
const EXPORT_FORMAT = 'dante-meter-bridge-layout';

class LayoutError extends Error {}

function cleanLayoutName(name) {
  if (typeof name !== 'string') throw new LayoutError('layout name must be text');
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) throw new LayoutError('layout name cannot be empty');
  if (clean.length > LIMITS.layoutName) throw new LayoutError(`layout name is longer than ${LIMITS.layoutName} characters`);
  return clean;
}

/** Return a clean copy of one layout's device list, or throw. */
function validateDevices(input) {
  if (!Array.isArray(input)) throw new LayoutError('"devices" must be a list');
  if (input.length > LIMITS.devices) throw new LayoutError(`at most ${LIMITS.devices} devices per layout`);

  const seen = new Set();
  const devices = [];
  for (const entry of input) {
    if (!entry || typeof entry.name !== 'string') throw new LayoutError('each device needs a name');
    const name = entry.name.trim();
    if (!name || name.length > LIMITS.nameLength) throw new LayoutError('invalid device name');
    if (seen.has(name)) continue;
    seen.add(name);
    const channels = (list) => {
      if (list === undefined) return [];
      if (!Array.isArray(list) || list.length > LIMITS.channelsPerDirection) throw new LayoutError(`invalid channel list for ${name}`);
      const set = new Set();
      for (const n of list) {
        if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxChannel) throw new LayoutError(`invalid channel number for ${name}`);
        set.add(n);
      }
      return [...set].sort((a, b) => a - b);
    };
    const tx = channels(entry.tx);
    const rx = channels(entry.rx);
    if (tx.length || rx.length) devices.push({ name, tx, rx });
  }
  return devices;
}

/** Kept for callers validating a single `{ devices }` layout. */
function validateLayout(input) {
  if (!input || typeof input !== 'object') throw new LayoutError('layout must be an object with a "devices" list');
  return { devices: validateDevices(input.devices) };
}

/** Accept a v2 library, or a v1 single layout (migrated). */
function validateLibrary(input) {
  if (input && Array.isArray(input.devices) && !Array.isArray(input.layouts)) {
    const devices = validateDevices(input.devices);
    return { layouts: devices.length ? [{ name: DEFAULT_NAME, devices }] : [] };
  }
  if (!input || !Array.isArray(input.layouts)) throw new LayoutError('expected a "layouts" list');
  const layouts = [];
  const names = new Set();
  let skipped = 0;
  for (const l of input.layouts.slice(0, LIMITS.layouts)) {
    try {
      const name = cleanLayoutName(l && l.name);
      if (names.has(name.toLowerCase())) continue;
      const devices = validateDevices(l.devices || []);
      names.add(name.toLowerCase());
      layouts.push({ name, devices });
    } catch (err) {
      if (!(err instanceof LayoutError)) throw err;
      skipped++; // one bad entry (e.g. a hand edit) must not cost the whole library
    }
  }
  return { layouts, skipped };
}

/**
 * Read an exported layout file (or a bare `{ devices }` / `{ name, devices }`).
 * Returns { name, devices }.
 */
function parseExport(input) {
  if (!input || typeof input !== 'object') throw new LayoutError('not a layout file');
  if (input.format !== undefined && input.format !== EXPORT_FORMAT) throw new LayoutError('not a Dante Meter Bridge layout file');
  if (!Array.isArray(input.devices)) throw new LayoutError('the file has no "devices" list');
  const name = input.name === undefined ? 'Imported layout' : cleanLayoutName(input.name);
  return { name, devices: validateDevices(input.devices) };
}

function toExport(layout) {
  return { format: EXPORT_FORMAT, version: 1, name: layout.name, devices: layout.devices };
}

class CustomLayouts extends EventEmitter {
  /** @param {{ file?: string|null, log?: object }} opts  file = null keeps it in memory only */
  constructor({ file = null, log = { warn() {} } } = {}) {
    super();
    this.file = file;
    this.log = log;
    this.library = { layouts: [] };
  }

  load() {
    if (!this.file) return this;
    try {
      const { layouts, skipped } = validateLibrary(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.library = { layouts };
      if (skipped) this.log.warn(`[Custom] Skipped ${skipped} invalid layout${skipped === 1 ? '' : 's'} in ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy: the next save would otherwise overwrite the user's file.
        const backup = `${this.file}.unreadable`;
        try {
          fs.copyFileSync(this.file, backup);
          this.log.warn(`[Custom] Ignoring unreadable ${this.file} (${err.message}); a copy was kept as ${backup}`);
        } catch {
          this.log.warn(`[Custom] Ignoring unreadable ${this.file}: ${err.message}`);
        }
      }
    }
    return this;
  }

  get() {
    return this.library;
  }

  find(name) {
    return this.library.layouts.find((l) => l.name === name) || null;
  }

  /** A name not yet used: "Name", "Name (2)", "Name (3)" … */
  uniqueName(base) {
    const taken = new Set(this.library.layouts.map((l) => l.name.toLowerCase()));
    const clean = cleanLayoutName(base);
    if (!taken.has(clean.toLowerCase())) return clean;
    const stem = clean.replace(/ \(\d+\)$/, '').slice(0, LIMITS.layoutName - 5).trim();
    for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})`.toLowerCase())) return `${stem} (${i})`;
  }

  /** Create or replace a layout's channels. */
  save(name, devices) {
    const clean = cleanLayoutName(name);
    const cleanDevices = validateDevices(devices);
    const existing = this.library.layouts.find((l) => l.name.toLowerCase() === clean.toLowerCase());
    if (existing) existing.devices = cleanDevices;
    else {
      if (this.library.layouts.length >= LIMITS.layouts) throw new LayoutError(`at most ${LIMITS.layouts} saved layouts`);
      this.library.layouts.push({ name: clean, devices: cleanDevices });
    }
    return this.commit(existing ? existing.name : clean);
  }

  /** Add a new layout under a name that isn't taken yet. Returns the name used. */
  create(name, devices = []) {
    const unique = this.uniqueName(name);
    this.save(unique, devices);
    return unique;
  }

  rename(from, to) {
    const layout = this.find(from);
    if (!layout) throw new LayoutError(`no layout called "${from}"`);
    const clean = cleanLayoutName(to);
    if (clean.toLowerCase() !== from.toLowerCase() && this.library.layouts.some((l) => l.name.toLowerCase() === clean.toLowerCase())) {
      throw new LayoutError(`a layout called "${clean}" already exists`);
    }
    const previous = layout.name;
    layout.name = clean;
    if (previous !== clean) this.emit('renamed', previous, clean);
    return this.commit(clean);
  }

  remove(name) {
    const before = this.library.layouts.length;
    this.library.layouts = this.library.layouts.filter((l) => l.name !== name);
    if (this.library.layouts.length === before) throw new LayoutError(`no layout called "${name}"`);
    return this.commit(null);
  }

  commit(name) {
    const failure = this.persist();
    this.emit('changed', this.library);
    if (failure) {
      throw new LayoutError(`the change is in use now but could not be written to disk, so it will be lost when the bridge restarts (${failure.message})`);
    }
    return name;
  }

  /** Write the library to disk. Returns the error if it could not be written. */
  persist() {
    if (!this.file) return null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, ...this.library }, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn(`[Custom] Could not save ${this.file}: ${err.message}`);
      return err;
    }
    return null;
  }
}

module.exports = {
  CustomLayouts,
  LayoutError,
  validateLayout,
  validateLibrary,
  parseExport,
  toExport,
  cleanLayoutName,
  EXPORT_FORMAT,
  DEFAULT_NAME,
  LIMITS
};
