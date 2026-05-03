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

function jsonPath(obj, path = '$') {
  if (!String(path).startsWith('$')) return undefined;
  const tokens = String(path).slice(1).match(/(?:\.[A-Za-z_][\w]*)|(?:\[\d+\])/g) || [];
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.startsWith('.')) cur = cur[t.slice(1)];
    else if (t.startsWith('[')) cur = cur[Number(t.slice(1, -1))];
  }
  return cur;
}

function valueLength(value) {
  if (Array.isArray(value) || typeof value === 'string') return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value == null ? 0 : String(value).length;
}

function hasContent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function failJsonAssert(message, detail) {
  throw new Error(message ? `${message} (${detail})` : `json assertion failed: ${detail}`);
}

function stringifyComparable(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function httpAssertJson(ctx, args = {}) {
  const last = ctx?.lastHttpResult;
  if (!last) {
    throw new Error('http.assert_json requires a previous http.* call (ctx.lastHttpResult missing)');
  }

  const { path = '$', message } = args;
  let parsed;
  try {
    parsed = JSON.parse(last.body || 'null');
  } catch (e) {
    failJsonAssert(message, `response body is not valid JSON: ${e.message}`);
  }

  const value = jsonPath(parsed, path);
  const expectsExist = args.exists !== false;
  if (value === undefined) {
    if (expectsExist) failJsonAssert(message, `path ${path} missing`);
    return { ok: true, path, value: undefined };
  }
  if (args.exists === false) {
    failJsonAssert(message, `path ${path} exists`);
  }

  const minLength = args.minLength ?? args.min_length;
  if (minLength != null) {
    const actualLength = valueLength(value);
    if (actualLength < Number(minLength)) {
      failJsonAssert(message, `path ${path} length ${actualLength} < ${minLength}`);
    }
  }

  const notEmpty = args.notEmpty ?? args.not_empty;
  if (notEmpty && !hasContent(value)) {
    failJsonAssert(message, `path ${path} is empty`);
  }

  if (args.equals !== undefined) {
    const actual = stringifyComparable(value);
    const expected = stringifyComparable(args.equals);
    if (actual !== expected) {
      failJsonAssert(message, `path ${path} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  const notEquals = args.notEquals ?? args.not_equals;
  if (notEquals !== undefined) {
    const actual = stringifyComparable(value);
    const expected = stringifyComparable(notEquals);
    if (actual === expected) {
      failJsonAssert(message, `path ${path} unexpectedly equals ${JSON.stringify(expected)}`);
    }
  }

  if (args.contains !== undefined) {
    const needle = stringifyComparable(args.contains);
    const matches = Array.isArray(value)
      ? value.map(stringifyComparable).includes(needle)
      : stringifyComparable(value).includes(needle);
    if (!matches) {
      failJsonAssert(message, `path ${path} does not contain ${JSON.stringify(needle)}`);
    }
  }

  const regex = args.regexMatch ?? args.regex_match;
  if (regex !== undefined) {
    let re;
    try { re = new RegExp(String(regex)); }
    catch (e) { failJsonAssert(message, `invalid regex ${JSON.stringify(regex)}: ${e.message}`); }
    if (!re.test(stringifyComparable(value))) {
      failJsonAssert(message, `path ${path} does not match ${JSON.stringify(regex)}`);
    }
  }

  return { ok: true, path, value };
}

module.exports = { httpRequest, httpAssertStatus, httpAssertJson };
