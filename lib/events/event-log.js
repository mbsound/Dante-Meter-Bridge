'use strict';

/**
 * The event log: an in-memory list for the UI plus one JSON-lines file per day
 * on disk, so history survives restarts. Old files are pruned after
 * `retentionDays`.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { EVENT_TYPES } = require('./catalog');

const FILE_RE = /^dante-events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function csvField(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class EventLog extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string|null} opts.dir  Directory for log files (null = memory only).
   * @param {number} [opts.retentionDays]
   * @param {number} [opts.maxInMemory]
   * @param {object} [opts.log]
   */
  constructor({ dir = null, retentionDays = 30, maxInMemory = 20000, log = null } = {}) {
    super();
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.maxInMemory = maxInMemory;
    this.log = log;
    this.events = [];
    this.nextId = 1;
    this.writeQueue = Promise.resolve();
  }

  /** Load recent history from disk and prune expired files. */
  load(now = Date.now()) {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.log?.warn(`[Events] Cannot create log directory ${this.dir}: ${err.message}`);
      this.dir = null;
      return;
    }
    this.prune(now);

    const files = fs
      .readdirSync(this.dir)
      .filter((f) => FILE_RE.test(f))
      .sort();
    const loaded = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(this.dir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event && event.type && event.time) loaded.push(event);
        } catch {
          // skip a torn line (e.g. power loss mid-write)
        }
      }
    }
    this.events = loaded.slice(-this.maxInMemory);
    this.nextId = this.events.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
  }

  prune(now = Date.now()) {
    if (!this.dir || !(this.retentionDays > 0)) return;
    const cutoff = localDate(now - this.retentionDays * 86400000);
    for (const file of fs.readdirSync(this.dir)) {
      const m = file.match(FILE_RE);
      if (m && m[1] < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, file));
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Record an event.
   * @param {keyof typeof EVENT_TYPES} type
   * @param {{device?: string, ip?: string, message: string, severity?: string, details?: object, time?: number}} fields
   */
  add(type, { device = null, ip = null, message, severity, details, time = Date.now() }) {
    const def = EVENT_TYPES[type];
    if (!def) throw new Error(`Unknown event type: ${type}`);
    const event = {
      id: this.nextId++,
      time,
      type,
      category: def.category,
      severity: severity || def.severity,
      title: def.title,
      device,
      ip,
      message
    };
    if (details) event.details = details;

    this.events.push(event);
    if (this.events.length > this.maxInMemory) this.events.splice(0, this.events.length - this.maxInMemory);
    this.persist(event);
    this.emit('event', event);
    return event;
  }

  persist(event) {
    if (!this.dir) return;
    const file = path.join(this.dir, `dante-events-${localDate(event.time)}.jsonl`);
    const line = JSON.stringify(event) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => fs.promises.appendFile(file, line))
      .catch((err) => this.log?.warn(`[Events] Could not write ${file}: ${err.message}`));
  }

  /** Wait for pending writes (used on shutdown and in tests). */
  flush() {
    return this.writeQueue;
  }

  recent(limit = 2000) {
    return this.events.slice(-limit);
  }

  /** @param {{categories?: string[], severities?: string[], limit?: number}} filter */
  query({ categories = [], severities = [], limit = 2000 } = {}) {
    const cats = new Set(categories);
    const sevs = new Set(severities);
    const matches = this.events.filter(
      (e) => (!cats.size || cats.has(e.category)) && (!sevs.size || sevs.has(e.severity))
    );
    return matches.slice(-limit);
  }

  /** Clear the in-memory list. Files on disk are kept. */
  clear() {
    this.events = [];
    this.emit('cleared');
  }

  static toCsv(events) {
    const header = ['Time', 'Severity', 'Category', 'Event', 'Device', 'IP', 'Message'];
    const rows = events.map((e) =>
      [new Date(e.time).toISOString(), e.severity, e.category, e.title, e.device, e.ip, e.message].map(csvField).join(',')
    );
    return [header.join(','), ...rows].join('\r\n') + '\r\n';
  }
}

module.exports = { EventLog, localDate };
