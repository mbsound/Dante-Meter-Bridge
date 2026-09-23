'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, ConfigError } = require('../lib/config');
const { resolveStaticPath, PUBLIC_DIR } = require('../lib/web/server');

test('static paths cannot escape the public directory', () => {
  assert.equal(resolveStaticPath('/'), path.join(PUBLIC_DIR, 'index.html'));
  assert.equal(resolveStaticPath('/app.js'), path.join(PUBLIC_DIR, 'app.js'));
  for (const evil of ['/../server.js', '/%2e%2e/server.js', '/..%2fpackage.json', '/%2e%2e%5cserver.js', '/a%00b', '/%E0%A4%A']) {
    const resolved = resolveStaticPath(evil);
    assert.ok(resolved === null || resolved.startsWith(PUBLIC_DIR + path.sep), `${evil} -> ${resolved}`);
  }
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('config precedence: CLI > env > file > defaults', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    path.join(dir, 'dante-meter.config.json'),
    JSON.stringify({ port: 9000, nic: 'en9', deviceOverrides: { 'Box-1': { manufacturer: 'ACME' } } })
  );

  const fromFile = loadConfig({ argv: [], env: {}, appDir: dir });
  assert.equal(fromFile.port, 9000);
  assert.equal(fromFile.nic, 'en9');
  assert.equal(fromFile.host, '0.0.0.0');
  assert.deepEqual(fromFile.deviceOverrides, { 'Box-1': { manufacturer: 'ACME' } });

  const fromEnv = loadConfig({ argv: [], env: { PORT: '9100', DANTE_IP: '169.254.1.1' }, appDir: dir });
  assert.equal(fromEnv.port, 9100);
  assert.equal(fromEnv.nic, '169.254.1.1');

  const fromCli = loadConfig({ argv: ['-p', '9200', '--nic', 'en6', '--open'], env: { PORT: '9100' }, appDir: dir });
  assert.equal(fromCli.port, 9200);
  assert.equal(fromCli.nic, 'en6');
  assert.equal(fromCli.open, true);
});

test('defaults with no config file', (t) => {
  const cfg = loadConfig({ argv: [], env: {}, appDir: tmpDir(t) });
  assert.equal(cfg.port, 8752);
  assert.equal(cfg.nic, null);
  assert.equal(cfg.configFile, null);
});

test('invalid input is reported clearly', (t) => {
  const dir = tmpDir(t);
  assert.throws(() => loadConfig({ argv: ['--port', 'abc'], env: {}, appDir: dir }), ConfigError);
  assert.throws(() => loadConfig({ argv: ['--bogus'], env: {}, appDir: dir }), ConfigError);
  assert.throws(() => loadConfig({ argv: ['--config', path.join(dir, 'missing.json')], env: {}, appDir: dir }), ConfigError);
  fs.writeFileSync(path.join(dir, 'dante-meter.config.json'), '{ not json');
  assert.throws(() => loadConfig({ argv: [], env: {}, appDir: dir }), ConfigError);
});
