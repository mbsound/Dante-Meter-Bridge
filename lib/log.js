'use strict';

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function createLogger({ debug = false } = {}) {
  return {
    debug: debug ? (...args) => console.log(timestamp(), '[debug]', ...args) : () => {},
    info: (...args) => console.log(timestamp(), ...args),
    warn: (...args) => console.warn(timestamp(), '[warn]', ...args),
    error: (...args) => console.error(timestamp(), '[error]', ...args)
  };
}

module.exports = { createLogger };
