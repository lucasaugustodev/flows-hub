const { makeTraceId } = require('../lib/trace-id');

async function auditAssertEntry(ctx, args = {}) {
  const sb = ctx?.supabase;
  if (!sb) {
    throw new Error('audit.assert_entry requires ctx.supabase (a Supabase client)');
  }

  // trace_id pode ser explícito ou derivado de correlate_with_step
  const traceId = args.trace_id
    || makeTraceId(ctx.runId, args.correlate_with_step ?? ctx.stepN);

  const { data, error } = await sb
    .from('audit_log')
    .select('id, trace_id, action, http_status, status, latency_ms, user_id')
    .eq('trace_id', traceId)
    .order('id', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`audit.assert_entry supabase error: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error(`audit entry not found for trace_id=${traceId}`);
  }

  const entry = data[0];

  if (args.action && entry.action !== args.action) {
    throw new Error(`audit entry mismatch: action expected=${args.action} got=${entry.action}`);
  }
  if (args.http_status != null && entry.http_status !== args.http_status) {
    throw new Error(`audit entry mismatch: http_status expected=${args.http_status} got=${entry.http_status}`);
  }
  if (args.status && entry.status !== args.status) {
    throw new Error(`audit entry mismatch: status expected=${args.status} got=${entry.status}`);
  }
  const latencyMax = args.expect?.latency_ms_under;
  if (latencyMax != null && entry.latency_ms > latencyMax) {
    throw new Error(`audit entry mismatch: latency_ms ${entry.latency_ms} > ${latencyMax}`);
  }

  if (typeof ctx.recordAuditEntry === 'function') {
    ctx.recordAuditEntry({
      run_id: ctx.runId,
      step_n: ctx.stepN,
      trace_id: traceId,
      audit_log_id: entry.id,
      action: entry.action,
      http_status: entry.http_status,
      status: entry.status,
      latency_ms: entry.latency_ms,
      user_id: entry.user_id,
      raw_json: JSON.stringify(entry),
    });
  }

  return { ok: true, entry };
}

module.exports = { auditAssertEntry };
