'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { byteToDbfs, dbfsToNormalized, isClipByte } = require('../public/levels');

test('byteToDbfs matches the Dante level encoding', () => {
  const cases = [
    [0, 0],
    [1, 0],
    [2, -0.5],
    [50, -24.5],
    [121, -60],
    [122, -60.5],
    [200, -99.5],
    [253, -126],
    [254, -Infinity],
    [255, -Infinity],
    [null, -Infinity]
  ];
  for (const [byte, expected] of cases) assert.equal(byteToDbfs(byte), expected, `byte ${byte}`);
});

test('dbfsToNormalized curve is unchanged', () => {
  const cases = [
    [-Infinity, 0],
    [-70, 0],
    [-60, 0],
    [-48, 0.125],
    [-36, 0.25],
    [-24, 0.45],
    [-18, 0.55],
    [-12, 0.685],
    [-6, 0.82],
    [-3, 0.91],
    [0, 1],
    [3, 1]
  ];
  for (const [db, expected] of cases) assert.ok(Math.abs(dbfsToNormalized(db) - expected) < 1e-9, `${db} dBFS`);
});

test('only byte 0 is a clip', () => {
  assert.equal(isClipByte(0), true);
  assert.equal(isClipByte(1), false);
  assert.equal(isClipByte(null), false);
});
