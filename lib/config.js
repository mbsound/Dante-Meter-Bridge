'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const APP_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = 'dante-meter.config.json';

const DEFAULTS = {
  port: 8752,
  host: '0.0.0.0',
  nic: null,
  open: false,
  debug: false,
  deviceOverrides: {}
};

const USAGE = `Dante Audio Meter Bridge

Usage: node server.js [options]

Options:
  -i, --nic <ip|name>   Network interface to use for Dante (IP address or name, e.g. en6)
  -p, --port <port>     Web UI port (default: ${DEFAULTS.port})
      --host <address>  Address the web UI listens on (default: ${DEFAULTS.host}, all interfaces)
  -c, --config <file>   Config file (default: ./${DEFAULT_CONFIG_FILE} if present)
      --open            Open the UI in the default browser once started
      --debug           Verbose logging
  -v, --version         Print version and exit
  -h, --help            Show this help

Environment variables: DANTE_IP, PORT, HOST, DEBUG=1
Precedence: command line > environment > config file > defaults.
`;

class ConfigError extends Error {}

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        nic: { type: 'string', short: 'i' },
        ip: { type: 'string' }, // legacy alias for --nic
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        config: { type: 'string', short: 'c' },
        open: { type: 'boolean' },
        debug: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' }
      },
      strict: true,
      allowPositionals: false
    }).values;
  } catch (err) {
    throw new ConfigError(`${err.message}\n\n${USAGE}`);
  }
}

function readConfigFile(file, explicit) {
  if (!fs.existsSync(file)) {
    if (explicit) throw new ConfigError(`Config file not found: ${file}`);
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (err) {
    throw new ConfigError(`Could not read config file ${file}: ${err.message}`);
  }
}

function parsePort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid port from ${source}: ${value}`);
  }
  return port;
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

/**
 * Resolve the effective configuration.
 * @returns {{port:number, host:string, nic:string|null, open:boolean, debug:boolean,
 *            deviceOverrides:object, configFile:string|null, help:boolean, version:boolean}}
 */
function loadConfig({ argv = process.argv.slice(2), env = process.env, appDir = APP_DIR } = {}) {
  const cli = parseCli(argv);
  const explicitFile = cli.config ? path.resolve(cli.config) : null;
  const configFile = explicitFile || path.join(appDir, DEFAULT_CONFIG_FILE);
  const file = cli.help || cli.version ? {} : readConfigFile(configFile, Boolean(explicitFile));

  const portSource = firstDefined(cli.port, env.PORT, file.port);
  const overrides = file.deviceOverrides || {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigError('"deviceOverrides" in the config file must be an object keyed by device name');
  }

  return {
    port: portSource === undefined ? DEFAULTS.port : parsePort(portSource, cli.port ? '--port' : env.PORT ? 'PORT' : 'config'),
    host: firstDefined(cli.host, env.HOST, file.host) || DEFAULTS.host,
    nic: firstDefined(cli.nic, cli.ip, env.DANTE_IP, file.nic) || DEFAULTS.nic,
    open: Boolean(cli.open || file.open),
    debug: Boolean(cli.debug || env.DEBUG === '1' || env.DEBUG === 'true' || file.debug),
    deviceOverrides: overrides,
    configFile: fs.existsSync(configFile) ? configFile : null,
    help: Boolean(cli.help),
    version: Boolean(cli.version)
  };
}

module.exports = { loadConfig, ConfigError, USAGE, DEFAULTS, DEFAULT_CONFIG_FILE };
