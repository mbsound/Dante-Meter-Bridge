'use strict';

/**
 * Settings changed from the web UI (as opposed to the config file, which is
 * read once at start-up). Kept in a small JSON file next to the app.
 */

const fs = require('fs');
const { EventEmitter } = require('events');

const DEFAULTS = {
  // The read-only /api/network-status summary for other tools.
  // port: null = answer on the web UI's port only; a number = also listen there.
  statusApi: { enabled: true, port: null }
};

class PreferenceError extends Error {}

function cleanStatusApi(input, current) {
  const next = { ...current };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PreferenceError('statusApi must be an object');
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new PreferenceError('statusApi.enabled must be true or false');
    next.enabled = input.enabled;
  }
  if ('port' in input) {
    if (input.port === null || input.port === '') {
      next.port = null;
    } else {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PreferenceError('The port must be a whole number from 1 to 65535');
      next.port = port;
    }
  }
  return next;
}

class Preferences extends EventEmitter {
  /** @param {{file?: string|null, log?: object}} opts  file: null keeps settings in memory only */
  constructor({ file = null, log = console } = {}) {
    super();
    this.file = file;
    this.log = log;
    this.values = structuredClone(DEFAULTS);
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return this;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && saved.statusApi) {
        this.values.statusApi = cleanStatusApi(saved.statusApi, this.values.statusApi);
      }
    } catch (err) {
      this.log.warn(`[Preferences] Ignoring ${this.file}: ${err.message}`);
      this.values = structuredClone(DEFAULTS);
    }
    return this;
  }

  get() {
    return structuredClone(this.values);
  }

  /** Apply a partial change. Throws PreferenceError for invalid input or if it cannot be saved. */
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PreferenceError('Expected an object');
    const next = structuredClone(this.values);
    if ('statusApi' in patch) next.statusApi = cleanStatusApi(patch.statusApi, next.statusApi);
    if (JSON.stringify(next) === JSON.stringify(this.values)) return this.get();
    if (this.file) {
      try {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
        fs.renameSync(tmp, this.file);
      } catch (err) {
        throw new PreferenceError(`Could not save preferences: ${err.message}`);
      }
    }
    this.values = next;
    this.emit('changed', this.get());
    return this.get();
  }
}

module.exports = { Preferences, PreferenceError, DEFAULTS };
