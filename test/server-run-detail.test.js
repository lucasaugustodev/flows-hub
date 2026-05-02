const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isola DB para teste — deve ser setado ANTES de qualquer require do projeto
const TMP_DB = path.join(os.tmpdir(), 'flows-hub-srv-test-' + Date.now() + '.db');
process.env.DB_FILE = TMP_DB;

let server;
let port;
let tokenPlain;

test.before(async () => {
  const { makeApp } = require('../src/server');
  const db = require('../src/db');
  const auth = require('../src/auth');

  // 1. Cria usuário proprietário (projects.owner_id NOT NULL)
  const userId = auth.newId();
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
    .run(userId, 'tester@somosahub.com.br', 'dummy-hash', 'Tester');

  // 2. Cria projeto e membership
  const projectId = 'p-srv-test-01';
  db.prepare('INSERT INTO projects (id, slug, name, owner_id) VALUES (?, ?, ?, ?)')
    .run(projectId, 'p-srv-test-01', 'Test Project', userId);
  db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
    .run(projectId, userId, 'owner');

  // 3. Emite token real (auth.issueToken gera pf_<hex> e armazena o hash)
  const t = auth.issueToken({ userId, kind: 'api', name: 'test-token' });
  tokenPlain = t.token;

  // 4. Seed: run pertencente ao projeto
  db.prepare('INSERT INTO runs (id, project_id, flow_id, status) VALUES (?, ?, ?, ?)')
    .run('run-aaa', projectId, 'flow-x', 'passed');

  // 5. Seed: http_call para o run
  db.prepare(`INSERT INTO http_calls
    (run_id, step_n, trace_id, method, url, response_status, latency_ms,
     request_headers, request_body, response_headers, response_body, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('run-aaa', 1, 'run-aaa:1', 'POST', 'https://api.example.com/x', 201, 150,
         '{}', null, '{}', '{"id":"abc"}', null);

  // 6. Seed: audit_entry para o run
  db.prepare(`INSERT INTO audit_entries
    (run_id, step_n, trace_id, audit_log_id, action, http_status, status, latency_ms, user_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('run-aaa', 2, 'run-aaa:2', 99, 'post.api.x', 201, 'success', 250, 'u1', '{}');

  // 7. Sobe o servidor na porta aleatória
  const app = makeApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = server.address().port;
});

test.after(() => {
  if (server) server.close();
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

// Helper para requisições autenticadas com o projeto resolvido via header
function apiGet(path) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Authorization: `Bearer ${tokenPlain}`,
      'X-Project': 'p-srv-test-01',
    },
  });
}

test('GET /api/runs/:id/http-calls retorna calls do run', async () => {
  const resp = await apiGet('/api/runs/run-aaa/http-calls');
  assert.strictEqual(resp.status, 200);
  const json = await resp.json();
  assert.strictEqual(json.calls.length, 1);
  assert.strictEqual(json.calls[0].method, 'POST');
  assert.strictEqual(json.calls[0].response_status, 201);
  assert.strictEqual(json.calls[0].url, 'https://api.example.com/x');
});

test('GET /api/runs/:id/audit-entries retorna entries do run', async () => {
  const resp = await apiGet('/api/runs/run-aaa/audit-entries');
  assert.strictEqual(resp.status, 200);
  const json = await resp.json();
  assert.strictEqual(json.entries.length, 1);
  assert.strictEqual(json.entries[0].action, 'post.api.x');
  assert.strictEqual(json.entries[0].audit_log_id, 99);
});

test('GET /api/runs/:id/http-calls 401 sem token', async () => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/runs/run-aaa/http-calls`);
  assert.ok(resp.status === 401 || resp.status === 403, `expected 401/403, got ${resp.status}`);
});
