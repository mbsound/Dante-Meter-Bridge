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
const { EventLog } = require('./lib/events/event-log');
const { NetworkMonitor } = require('./lib/events/monitor');
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

  const eventLog = new EventLog({ dir: config.logDir, retentionDays: config.logRetentionDays, log });
  eventLog.load();
  log.info(`[Events] Logging to ${eventLog.dir || 'memory only'} (${eventLog.events.length} earlier events loaded)`);
  eventLog.on('event', (e) => {
    const line = `[Event] ${e.severity.toUpperCase()} ${e.title}${e.device ? ` - ${e.device}` : ''}: ${e.message}`;
    if (e.severity === 'error') log.warn(line);
    else log.info(line);
  });
  const monitor = new NetworkMonitor({ engine, eventLog });
  engine.on('interface-lost', (address) => monitor.interfaceLost(address));

  const web = createWebServer({ engine, eventLog, version, log });
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

  monitor.start();
  engine.start();
  setInterval(() => eventLog.prune(), 6 * 3600 * 1000).unref();

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
    monitor.stop();
    engine.stop();
    web.close();
    eventLog.flush().finally(() => setTimeout(() => process.exit(0), 300).unref());
  };
  // SIGHUP: the terminal window was closed (the usual way launchers are stopped).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));
}

main();
