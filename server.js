#!/usr/bin/env node
'use strict';

/**
 * Dante Audio Meter Bridge — entry point.
 * Zero runtime dependencies: Node.js core modules only.
 */

const { loadConfig, ConfigError, USAGE } = require('./lib/config');
const { createLogger } = require('./lib/log');
const { DanteEngine } = require('./lib/dante/engine');
const { IdentityResolver } = require('./lib/dante/identity');
const { listInterfaces, openBrowser } = require('./lib/dante/network');
const { createWebServer } = require('./lib/web/server');
const { version } = require('./package.json');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  if (config.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (config.version) {
    console.log(version);
    return;
  }

  const log = createLogger({ debug: config.debug });
  if (config.configFile) log.info(`[Config] Loaded ${config.configFile}`);

  const identity = new IdentityResolver({ overrides: config.deviceOverrides });
  const engine = new DanteEngine({ nic: config.nic, log, identity });
  const web = createWebServer({ engine, version, log });
  const localUrl = `http://localhost:${config.port}`;

  web.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${config.port} is already in use. Is the Meter Bridge already running?`);
      log.error('Close the other instance, or start this one with --port <another port>.');
      if (config.open) openBrowser(localUrl);
    } else {
      log.error(`Web server failed: ${err.message}`);
    }
    engine.stop();
    process.exit(1);
  });

  engine.start();

  web.server.listen(config.port, config.host, () => {
    const lanUrls =
      config.host === '0.0.0.0'
        ? listInterfaces().map((i) => `http://${i.address}:${config.port}`)
        : [`http://${config.host}:${config.port}`];
    console.log('');
    console.log(`  Dante Audio Meter Bridge v${version}`);
    console.log(`  Local:    ${localUrl}`);
    for (const url of lanUrls) console.log(`  Network:  ${url}`);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
    if (config.open) openBrowser(localUrl);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[Server] ${signal} received, shutting down.`);
    engine.stop();
    web.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
