const { makeTraceId } = require('../lib/trace-id');

async function httpRequest(ctx, args = {}) {
  const { method = 'GET', url, headers = {}, body, timeout = 30000 } = args;
  if (!url) throw new Error('http.request requires url');

  const traceId = ctx.traceId || makeTraceId(ctx.runId, ctx.stepN);
  const finalHeaders = {
    'X-Trace-Id': traceId,
    ...(body && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };
  const finalBody = body == null
    ? undefined
    : (typeof body === 'object' ? JSON.stringify(body) : String(body));

  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let resp, respBody, err;
  try {
    resp = await fetch(url, { method, headers: finalHeaders, body: finalBody, signal: ctrl.signal });
    respBody = await resp.text();
  } catch (e) {
    err = e?.message || String(e);
  } finally {
    clearTimeout(t);
  }
  const latency = Date.now() - start;

  const callRecord = {
    run_id: ctx.runId,
    step_n: ctx.stepN,
    trace_id: traceId,
    method,
    url,
    request_headers: JSON.stringify(finalHeaders),
    request_body: finalBody ?? null,
    response_status: resp?.status ?? null,
    response_headers: resp ? JSON.stringify(Object.fromEntries(resp.headers.entries())) : null,
    response_body: respBody ?? null,
    latency_ms: latency,
    error: err ?? null,
  };
  if (typeof ctx.recordCall === 'function') ctx.recordCall(callRecord);

  const ret = err
    ? { ok: false, error: err, status: null, body: null, headers: null, latency_ms: latency, trace_id: traceId }
    : { ok: resp.ok, status: resp.status, body: respBody, headers: Object.fromEntries(resp.headers.entries()), latency_ms: latency, trace_id: traceId };
  if (ctx) ctx.lastHttpResult = ret;
  return ret;
}

function httpAssertStatus(ctx, args = {}) {
  const last = ctx?.lastHttpResult;
  if (!last) {
    throw new Error('http.assert_status requires a previous http.* call (ctx.lastHttpResult missing)');
  }
  const { equals, in: oneOf, not } = args;

  if (equals != null && last.status !== equals) {
    throw new Error(`status mismatch: expected ${equals}, got ${last.status}`);
  }
  if (Array.isArray(oneOf) && !oneOf.includes(last.status)) {
    throw new Error(`status mismatch: expected in [${oneOf.join(',')}], got ${last.status}`);
  }
  if (not != null && last.status === not) {
    throw new Error(`status mismatch: expected != ${not}, got ${last.status}`);
  }

  return { ok: true, status: last.status };
}

module.exports = { httpRequest, httpAssertStatus };
