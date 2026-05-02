/**
 * Integration test: http.request seguido de http.assert_status no dispatcher.
 *
 * Verifica que ctx.lastHttpResult sobrevive entre steps (httpCtx persistente
 * por run) e que assert_status consegue validar o status do request anterior.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Aponta DB para arquivo temporário isolado ANTES de qualquer require do src/
const TMP_DB = path.join(os.tmpdir(), 'flows-hub-assert-test-' + Date.now() + '.db');
process.env.DB_FILE = TMP_DB;

let echoServer;
let echoPort;

test.before(async () => {
  echoServer = http.createServer((req, res) => {
    const status = parseInt(req.url.replace('/', ''), 10) || 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  });
  await new Promise((r) => echoServer.listen(0, r));
  echoPort = echoServer.address().port;
});

test.after(async () => {
  echoServer.close();
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

test('integration: http.request + http.assert_status equals pass', async () => {
  const db = require('../src/db');
  const { runFlowOnSession } = require('../src/replay');

  const flowId = 'assert-flow-pass-' + Date.now();
  const runId = crypto.randomBytes(8).toString('hex');

  db.prepare('INSERT INTO flows (id, name, json) VALUES (?, ?, ?)').run(
    flowId,
    'assert-flow-pass',
    JSON.stringify({
      id: flowId,
      vars: [],
      steps: [
        {
          n: 1,
          action: 'http.request',
          args: { method: 'GET', url: `http://localhost:${echoPort}/200` },
        },
        {
          n: 2,
          action: 'http.assert_status',
          args: { equals: 200 },
        },
      ],
    }),
  );

  const sessionMock = { page: null, context: null, browser: null };

  const result = await runFlowOnSession({
    flowId,
    overrides: {},
    session: sessionMock,
    runId,
  });

  assert.strictEqual(result.ok, true, `assert_status falhou inesperadamente: ${result.error}`);
  assert.strictEqual(result.steps.length, 2, 'esperava 2 steps no log');
  assert.strictEqual(result.steps[1].action, 'http.assert_status');
  assert.strictEqual(result.steps[1].ok, true);
});

test('integration: http.request + http.assert_status equals fail lanca erro', async () => {
  const db = require('../src/db');
  const { runFlowOnSession } = require('../src/replay');

  const flowId = 'assert-flow-fail-' + Date.now();
  const runId = crypto.randomBytes(8).toString('hex');

  db.prepare('INSERT INTO flows (id, name, json) VALUES (?, ?, ?)').run(
    flowId,
    'assert-flow-fail',
    JSON.stringify({
      id: flowId,
      vars: [],
      steps: [
        {
          n: 1,
          action: 'http.request',
          args: { method: 'GET', url: `http://localhost:${echoPort}/200` },
        },
        {
          n: 2,
          action: 'http.assert_status',
          args: { equals: 404 },
        },
      ],
    }),
  );

  const sessionMock = { page: null, context: null, browser: null };

  const result = await runFlowOnSession({
    flowId,
    overrides: {},
    session: sessionMock,
    runId,
  });

  assert.strictEqual(result.ok, false, 'esperava falha pelo assert_status');
  assert.match(result.error, /status mismatch/, 'mensagem de erro deve conter "status mismatch"');
});
