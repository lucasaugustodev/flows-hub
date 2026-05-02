const test = require('node:test');
const assert = require('node:assert');
const { auditAssertEntry } = require('../src/actions/audit');

function fakeSupabase(rows, err = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: rows, error: err }),
          }),
        }),
      }),
    }),
  };
}

test('audit.assert_entry pass quando supabase retorna match', async () => {
  const sb = fakeSupabase([{
    id: 99,
    trace_id: 'r1:3',
    action: 'post.api.adesao.iniciar',
    http_status: 201,
    status: 'success',
    latency_ms: 250,
    user_id: 'u1',
  }]);
  const recorded = [];
  const ctx = {
    runId: 'r1',
    stepN: 5,
    supabase: sb,
    recordAuditEntry: (e) => recorded.push(e),
  };
  const r = await auditAssertEntry(ctx, {
    correlate_with_step: 3,
    action: 'post.api.adesao.iniciar',
    http_status: 201,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.id, 99);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].audit_log_id, 99);
});

test('audit.assert_entry fail quando action nao bate', async () => {
  const sb = fakeSupabase([{ id: 1, action: 'get.api.adesao.iniciar', http_status: 200, status: 'success' }]);
  const ctx = { runId: 'r1', stepN: 5, supabase: sb, recordAuditEntry: () => {} };
  await assert.rejects(
    auditAssertEntry(ctx, {
      correlate_with_step: 3,
      action: 'post.api.adesao.iniciar',
      http_status: 201,
    }),
    /audit entry mismatch.*action/,
  );
});

test('audit.assert_entry fail quando http_status nao bate', async () => {
  const sb = fakeSupabase([{ id: 1, action: 'post.api.x', http_status: 500, status: 'error' }]);
  const ctx = { runId: 'r1', stepN: 5, supabase: sb, recordAuditEntry: () => {} };
  await assert.rejects(
    auditAssertEntry(ctx, { action: 'post.api.x', http_status: 200 }),
    /audit entry mismatch.*http_status/,
  );
});

test('audit.assert_entry fail quando entry nao encontrada', async () => {
  const sb = fakeSupabase([]);
  const ctx = { runId: 'r1', stepN: 5, supabase: sb, recordAuditEntry: () => {} };
  await assert.rejects(
    auditAssertEntry(ctx, { action: 'post.api.x' }),
    /audit entry not found/,
  );
});

test('audit.assert_entry fail sem ctx.supabase', async () => {
  const ctx = { runId: 'r1', stepN: 5 };
  await assert.rejects(
    auditAssertEntry(ctx, { action: 'post.api.x' }),
    /requires ctx\.supabase/,
  );
});

test('audit.assert_entry valida latency_ms_under', async () => {
  const sb = fakeSupabase([{
    id: 1, action: 'post.api.x', http_status: 200, status: 'success', latency_ms: 5000,
  }]);
  const ctx = { runId: 'r1', stepN: 5, supabase: sb, recordAuditEntry: () => {} };
  await assert.rejects(
    auditAssertEntry(ctx, {
      action: 'post.api.x',
      expect: { latency_ms_under: 1000 },
    }),
    /latency_ms 5000 > 1000/,
  );
});
