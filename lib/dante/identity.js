'use strict';

/**
 * Device identity (manufacturer / model / versions) resolution.
 *
 * Sources, in priority order:
 *   1. User overrides from the local config file, keyed by Dante device name.
 *   2. The Dante Controller update-helper database, if installed on this
 *      machine, matched on the mDNS TXT `mf` + `model` identifiers.
 *
 * Nothing site-specific lives in this file.
 */

const fs = require('fs');
const path = require('path');

const IDENTITY_FIELDS = ['manufacturer', 'modelName', 'productVersion', 'softwareVersion', 'firmwareVersion'];

function defaultDatabasePaths() {
  const paths = [];
  if (process.platform === 'darwin') {
    paths.push('/Library/Application Support/Audinate/DanteUpdateHelper/dante_update_helper.dat');
  } else if (process.platform === 'win32' && process.env.ProgramData) {
    paths.push(path.join(process.env.ProgramData, 'Audinate', 'DanteUpdateHelper', 'dante_update_helper.dat'));
  }
  return paths;
}

function cleanVersion(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return !s || /^0(\.0)*$/.test(s) ? null : s;
}

function lower(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

class DanteDatabase {
  constructor(paths = defaultDatabasePaths()) {
    this.paths = paths;
    this.entries = [];
    this.loadedPath = null;
    this.loadedMtime = 0;
  }

  /** Re-read the database only when the file has changed on disk. */
  refresh() {
    for (const file of this.paths) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (file === this.loadedPath && stat.mtimeMs === this.loadedMtime) return this.entries;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.entries = Array.isArray(parsed && parsed.devices) ? parsed.devices.map(toEntry) : [];
        this.loadedPath = file;
        this.loadedMtime = stat.mtimeMs;
      } catch {
        this.entries = [];
      }
      return this.entries;
    }
    this.entries = [];
    return this.entries;
  }

  /** Find the best entry for a device's mDNS manufacturer + model ids. */
  lookup({ mdnsMf, mdnsModel, txCount, rxCount }) {
    const model = lower(mdnsModel);
    if (!model) return null;
    const mf = lower(mdnsMf);
    const candidates = this.refresh().filter((e) => e.model === model && (!mf || !e.mf || e.mf === mf));
    if (candidates.length <= 1) return candidates[0] || null;
    // Several units of the same model: prefer one whose channel counts agree.
    return candidates.find((e) => e.txCount === txCount && e.rxCount === rxCount) || candidates[0];
  }
}

function toEntry(raw) {
  const txt = (raw.raw_configuration && raw.raw_configuration.arcp_txt_record) || {};
  const cfg = raw.current_configuration || {};
  return {
    mf: lower(txt.mf),
    model: lower(txt.model),
    txCount: cfg.tx_audio_channel_count,
    rxCount: cfg.rx_audio_channel_count,
    identity: {
      manufacturer: raw.manufacturer_name || null,
      modelName: raw.product_model_name || raw.dante_model_name || null,
      productVersion: cleanVersion(raw.product_version),
      softwareVersion: cleanVersion(raw.product_sw_version),
      firmwareVersion: cleanVersion(raw.product_fw_version)
    }
  };
}

/**
 * Model-level behaviour quirks (not site-specific). Some devices advertise more
 * channels over ARC than they really expose for metering.
 */
const MODEL_QUIRKS = [
  // Shure Axient Digital
  { test: /ad4q|axient digital quad/i, maxTx: 4, maxRx: 1, rxNames: { 1: 'Rx Listen' } },
  { test: /ad600|spectrum manager/i, maxTx: 2, maxRx: 1 }
];

function findQuirk(dev) {
  const haystack = [dev.name, dev.modelName].filter(Boolean);
  return MODEL_QUIRKS.find((q) => haystack.some((s) => q.test.test(s))) || null;
}

function trimDirection(dir, max, defaultPrefix, renames) {
  dir.count = Math.min(dir.count, max);
  for (const key of Object.keys(dir.channels)) {
    if (Number(key) > max) delete dir.channels[key];
  }
  for (let i = 1; i <= dir.count; i++) {
    const ch = dir.channels[i] || (dir.channels[i] = { number: i, name: `${defaultPrefix} ${i}` });
    if (renames && renames[i] && (!ch.name || ch.name === `${defaultPrefix} ${i}`)) ch.name = renames[i];
  }
}

function applyQuirks(dev) {
  const quirk = findQuirk(dev);
  if (!quirk) return;
  if (quirk.maxTx !== undefined) trimDirection(dev.tx, quirk.maxTx, 'Tx');
  if (quirk.maxRx !== undefined) trimDirection(dev.rx, quirk.maxRx, 'Rx', quirk.rxNames);
}

class IdentityResolver {
  constructor({ overrides = {}, database = new DanteDatabase() } = {}) {
    this.database = database;
    this.overrides = new Map(Object.entries(overrides).map(([name, v]) => [lower(name), v]));
  }

  resolve(dev) {
    const override = this.overrides.get(lower(dev.name));
    const fromDb = this.database.lookup({
      mdnsMf: dev.mdnsMf,
      mdnsModel: dev.mdnsModel,
      txCount: dev.tx.count,
      rxCount: dev.rx.count
    });

    for (const field of IDENTITY_FIELDS) {
      const value = (override && override[field]) || (fromDb && fromDb.identity[field]) || dev[field] || null;
      dev[field] = value;
    }
    applyQuirks(dev);
  }
}

module.exports = { IdentityResolver, DanteDatabase, applyQuirks, cleanVersion, IDENTITY_FIELDS };
