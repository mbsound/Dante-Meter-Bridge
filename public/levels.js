/**
 * Dante meter level math, shared by the Node server and the browser UI.
 *
 * Dante reports each channel's peak as a single byte:
 *   0        => clip / overload
 *   1        => 0 dBFS
 *   2-253    => 0.5 dB steps below 0 dBFS (-(byte - 1) / 2)
 *   254      => muted / silent
 *   255      => no reading
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DanteLevels = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SILENT = 254;

  function byteToDbfs(byteVal) {
    if (byteVal === undefined || byteVal === null || byteVal >= SILENT) return -Infinity;
    if (byteVal <= 1) return 0.0;
    return -(byteVal - 1) / 2;
  }

  function isClipByte(byteVal) {
    return byteVal === 0;
  }

  // Piecewise mapping of -60..0 dBFS onto a 0..1 meter height. The upper
  // range is expanded so the working area (-18..0) gets most of the ladder.
  function dbfsToNormalized(dbfs) {
    if (typeof dbfs !== 'number' || !isFinite(dbfs) || dbfs <= -60) return 0;
    if (dbfs >= 0) return 1.0;
    if (dbfs >= -6) return 0.82 + 0.18 * ((dbfs + 6) / 6);
    if (dbfs >= -18) return 0.55 + 0.27 * ((dbfs + 18) / 12);
    if (dbfs >= -36) return 0.25 + 0.30 * ((dbfs + 36) / 18);
    return 0.25 * ((dbfs + 60) / 24);
  }

  return { SILENT, byteToDbfs, isClipByte, dbfsToNormalized };
});
