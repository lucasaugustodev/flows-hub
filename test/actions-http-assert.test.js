const test = require('node:test');
const assert = require('node:assert');
const { httpAssertStatus } = require('../src/actions/http');

test('httpAssertStatus pass quando equals casa', () => {
  const ctx = { lastHttpResult: { status: 200 } };
  const r = httpAssertStatus(ctx, { equals: 200 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
});

test('httpAssertStatus throw quando equals diverge', () => {
  const ctx = { lastHttpResult: { status: 500 } };
  assert.throws(() => httpAssertStatus(ctx, { equals: 200 }), /status mismatch/);
});

test('httpAssertStatus suporta in array', () => {
  const ctx = { lastHttpResult: { status: 201 } };
  const r = httpAssertStatus(ctx, { in: [200, 201, 204] });
  assert.strictEqual(r.ok, true);
});

test('httpAssertStatus throw quando in nao casa', () => {
  const ctx = { lastHttpResult: { status: 500 } };
  assert.throws(() => httpAssertStatus(ctx, { in: [200, 201] }), /expected in \[200,201\]/);
});

test('httpAssertStatus suporta not', () => {
  const ctx = { lastHttpResult: { status: 200 } };
  const r = httpAssertStatus(ctx, { not: 500 });
  assert.strictEqual(r.ok, true);
});

test('httpAssertStatus throw quando not casa', () => {
  const ctx = { lastHttpResult: { status: 500 } };
  assert.throws(() => httpAssertStatus(ctx, { not: 500 }), /expected != 500/);
});

test('httpAssertStatus throw sem lastHttpResult', () => {
  const ctx = {};
  assert.throws(() => httpAssertStatus(ctx, { equals: 200 }), /requires a previous http\.\* call/);
});
