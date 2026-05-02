/**
 * Integration test: verifica que o dispatcher em runFlow passa runId
 * corretamente para o httpCtx de actions http.*, e que recordHttpCall
 * persiste a linha com trace_id no formato correto.
 *
 * Usa runFlowOnSession (sem Playwright) com um session mock para exercitar
 * o caminho real do dispatcher — o mesmo código corrigido pelo Issue 1/2.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Aponta DB para arquivo temporário isolado ANTES de qualquer require do src/
const TMP_DB = path.join(os.tmpdir(), 'flows-hub-test-' + Date.now() + '.db');
process.env.DB_FILE = TMP_DB;

let echoServer;
let echoPort;

test.before(async () => {
  echoServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        traceId: req.headers['x-trace-id'] || null,
      }));
    });
  });
  await new Promise((r) => echoServer.listen(0, r));
  echoPort = echoServer.address().port;
});

test.after(async () => {
  echoServer.close();
  // Remove DB temporário
  try { fs.unlinkSync(TMP_DB); } catch {}
  // Remove WAL/SHM auxiliares
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

test('integration: http.request via dispatcher grava em http_calls com runId correto', async () => {
  // Lazy require depois de setar DB_FILE
  const db = require('../src/db');
  const { runFlowOnSession } = require('../src/replay');

  const flowId = 'test-flow-' + Date.now();
  const runId = crypto.randomBytes(8).toString('hex');

  // Insere fluxo com um passo http.request
  db.prepare('INSERT INTO flows (id, name, json) VALUES (?, ?, ?)').run(
    flowId,
    'test-flow',
    JSON.stringify({
      id: flowId,
      vars: [],
      steps: [
        {
          n: 1,
          action: 'http.request',
          args: { method: 'GET', url: `http://localhost:${echoPort}/echo` },
        },
      ],
    }),
  );

  // Session mock — http.* actions não usam o objeto session, mas runFlow recebe
  const sessionMock = { page: null, context: null, browser: null };

  const result = await runFlowOnSession({
    flowId,
    overrides: {},
    session: sessionMock,
    runId,
  });

  // runFlow deve ter completado sem erro
  assert.strictEqual(result.ok, true, `runFlowOnSession falhou: ${result.error}`);

  // Deve haver exatamente 1 linha em http_calls para este runId
  const calls = db.prepare('SELECT * FROM http_calls WHERE run_id = ?').all(runId);
  assert.strictEqual(calls.length, 1, 'esperava 1 linha em http_calls');

  const call = calls[0];
  assert.strictEqual(call.response_status, 200, 'status HTTP deve ser 200');

  // trace_id deve seguir o padrão runId:stepN
  assert.strictEqual(call.trace_id, `${runId}:1`, `trace_id incorreto: ${call.trace_id}`);

  // O servidor echo devolve o x-trace-id no body — confirma que o header foi enviado
  const respBody = JSON.parse(call.response_body);
  assert.strictEqual(respBody.traceId, `${runId}:1`, `header X-Trace-Id não chegou no servidor: ${call.response_body}`);
});
