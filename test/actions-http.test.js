const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { httpRequest } = require('../src/actions/http');

let server;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      } else if (req.url === '/fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
});

test.after(() => server.close());

test('httpRequest GET 200', async () => {
  const port = server.address().port;
  const ctx = { runId: 'r1', stepN: 1, recordCall: () => {} };
  const result = await httpRequest(ctx, {
    method: 'GET',
    url: `http://localhost:${port}/echo`,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.match(result.body, /"method":"GET"/);
});

test('httpRequest envia X-Trace-Id no header', async () => {
  const port = server.address().port;
  const calls = [];
  const ctx = { runId: 'r2', stepN: 5, recordCall: (c) => calls.push(c) };
  const result = await httpRequest(ctx, {
    method: 'POST',
    url: `http://localhost:${port}/echo`,
    body: { hello: 'world' },
  });
  assert.strictEqual(result.ok, true);
  assert.match(result.body, /"x-trace-id":"r2:5"/i);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].trace_id, 'r2:5');
  assert.strictEqual(calls[0].method, 'POST');
});

test('httpRequest captura erro 500 no response (mas ok=false)', async () => {
  const port = server.address().port;
  const ctx = { runId: 'r3', stepN: 1, recordCall: () => {} };
  const result = await httpRequest(ctx, {
    method: 'GET',
    url: `http://localhost:${port}/fail`,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 500);
});

test('httpRequest network error retorna ok:false com error', async () => {
  const ctx = { runId: 'r4', stepN: 1, recordCall: () => {} };
  const result = await httpRequest(ctx, {
    method: 'GET',
    url: 'http://localhost:1', // unreachable port
    timeout: 2000,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});
