/**
 * Replay engine — execute a saved flow with dynamic vars.
 * Supports invoke_flow (composition) and per-step `when` clauses.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const db = require('./db');
const { substitute, RESOLVERS } = require('./resolvers');
const projectsLib = require('./projects');
const { goto, click, fill, selectOption, press, waitFor, waitMs, screenshotAction, evalJs, toggle, handleDialog, verifyExpect, extract, assertEq } = require('./actions');
const { httpRequest } = require('./actions/http');
const { recordHttpCall } = require('./db');
const linter = require('./linter');

const BROWSERLESS_WS = process.env.BROWSERLESS_WS || 'ws://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_INVOKE_DEPTH = 5;

const HANDLERS = {
  goto, click, fill, select: selectOption, press,
  wait_for: waitFor, wait_ms: waitMs, screenshot: screenshotAction,
  eval: evalJs, toggle, dialog: handleDialog,
  extract, assert_eq: assertEq,
  'http.request': httpRequest,
};

function loadFlow(flowId) {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(flowId);
  if (!row) throw new Error(`flow not found: ${flowId}`);
  return JSON.parse(row.json);
}

/**
 * Tiny safe expression evaluator for `when` clauses.
 * Allowed: identifiers (vars), string/number/boolean literals, == != && || ! ( ) > < >= <=
 * No function calls, no member access, no assignment.
 */
function evalWhen(expr, vars) {
  // Validate the expression contains only allowed tokens.
  const allowed = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*'|\d+(?:\.\d+)?|==|!=|>=|<=|>|<|&&|\|\||!|\(|\))\s*)+$/;
  if (!allowed.test(expr)) throw new Error(`when expression contains disallowed tokens: ${expr}`);
  const keys = Object.keys(vars);
  const values = keys.map(k => vars[k] == null ? '' : String(vars[k]));
  try {
    return !!(new Function(...keys, `"use strict"; return (${expr});`))(...values);
  } catch (e) {
    throw new Error(`when "${expr}" failed: ${e.message}`);
  }
}

async function runFlow(flowId, env) {
  if (env.depth > MAX_INVOKE_DEPTH) throw new Error(`invoke_flow depth exceeded (${MAX_INVOKE_DEPTH})`);
  const flow = loadFlow(flowId);
  const { vars, ctx, session, emit, stepLog, prefix, runId } = env;

  const stepLabel = (n) => prefix ? `${prefix}${n}` : String(n);

  // 1. Resolve vars declared in this flow (skip already set, skip wait_for_var deps)
  for (const def of (flow.vars || [])) {
    if (def.name in vars) continue;
    if (flow.steps?.some(s => s.action === 'wait_for_var' && s.args?.var === def.name)) continue;
    try {
      emit('var_resolving', { name: def.name, resolver: def.resolver, flow: flow.id });
      const fn = RESOLVERS[def.resolver];
      if (!fn) throw new Error(`unknown resolver: ${def.resolver}`);
      // Substitute earlier-resolved vars into args so resolvers can chain
      // (e.g. mailtm.bind { email: "${TEST_EMAIL}", password: "${TEST_PASSWORD}" }).
      const args = substitute(def.args || {}, vars);
      vars[def.name] = await fn(args, ctx);
      emit('var_resolved', { name: def.name, source: def.resolver, value: redact(def.name, vars[def.name]) });
    } catch (e) {
      emit('var_failed', { name: def.name, error: e.message });
      throw new Error(`resolving var ${def.name}: ${e.message}`);
    }
  }

  // 2. Execute steps
  for (const step of (flow.steps || [])) {
    const label = stepLabel(step.n);
    const stepStart = Date.now();

    // when clause: skip silently if false
    if (step.when) {
      let ok;
      try { ok = evalWhen(substitute(step.when, vars), vars); }
      catch (e) {
        emit('step_end', { n: label, action: step.action, ok: false, durationMs: 0, error: e.message });
        throw e;
      }
      if (!ok) {
        stepLog.push({ n: label, action: step.action, ok: true, skipped: true, when: step.when });
        emit('step_skipped', { n: label, action: step.action, when: step.when });
        continue;
      }
    }

    emit('step_start', { n: label, action: step.action, args: step.args });
    try {
      // wait_for_var: blocks until a var resolver yields (e.g. OTP arrives)
      if (step.action === 'wait_for_var') {
        const def = (flow.vars || []).find(v => v.name === step.args.var);
        if (!def) throw new Error(`wait_for_var: variable "${step.args.var}" not declared in flow.vars`);
        const fn = RESOLVERS[def.resolver];
        if (!fn) throw new Error(`unknown resolver: ${def.resolver}`);
        emit('var_resolving', { name: def.name, resolver: def.resolver });
        const stepArgs = substitute({ ...(def.args || {}), ...(step.args || {}) }, vars);
        vars[def.name] = await fn(stepArgs, ctx);
        emit('var_resolved', { name: def.name, source: def.resolver, value: redact(def.name, vars[def.name]) });
        stepLog.push({ n: label, action: step.action, ok: true, durationMs: Date.now() - stepStart, var: def.name, value: redact(def.name, vars[def.name]) });
        emit('step_end', { n: label, action: step.action, ok: true, durationMs: Date.now() - stepStart });
        continue;
      }

      // invoke_flow: recursively run another flow in the SAME browser context
      if (step.action === 'invoke_flow') {
        const subId = substitute(step.args.flow, vars);
        // explicit overrides for the child (substituted with parent's vars)
        const childOverrides = step.args.vars ? substitute(step.args.vars, vars) : {};
        // child shares parent's vars by inheritance, but its overrides take precedence
        const childVars = { ...vars, ...childOverrides };
        emit('invoke_flow_start', { n: label, flow: subId });
        const childPrefix = `${label}.`;
        await runFlow(subId, {
          ...env,
          vars: childVars,
          prefix: childPrefix,
          depth: env.depth + 1,
        });
        // promote any NEW vars resolved in child up to parent (so subsequent top-level steps see them)
        for (const k of Object.keys(childVars)) if (!(k in vars)) vars[k] = childVars[k];
        stepLog.push({ n: label, action: 'invoke_flow', ok: true, durationMs: Date.now() - stepStart, flow: subId });
        emit('invoke_flow_end', { n: label, flow: subId, durationMs: Date.now() - stepStart });
        continue;
      }

      const args = substitute(step.args, vars);
      const handler = HANDLERS[step.action];
      if (!handler) throw new Error(`unknown action: ${step.action}`);

      // Linter: snapshot page + attach listeners before the action runs
      const linterCtx = await linter.beforeStep(session, step).catch(() => null);

      let result;
      try {
        // http.* actions receive a ctx object instead of a browser session
        if (step.action.startsWith('http.')) {
          const httpCtx = {
            runId,
            stepN: step.n,
            recordCall: recordHttpCall,
          };
          result = await handler(httpCtx, args);
        } else {
          result = await handler(session, args);
        }
      } catch (handlerErr) {
        // Auto-heal: if step has step.heal=true OR action is in list of healable, try LLM fallback
        const healable = step.heal === true || ['click', 'fill', 'toggle'].includes(step.action);
        if (healable && process.env.OPENROUTER_API_KEY) {
          emit('step_heal_attempt', { n: label, action: step.action, originalError: handlerErr.message });
          const healed = await healActionWithLLM({ session, step, args, error: handlerErr.message }).catch(() => null);
          if (healed?.ok) {
            result = healed.result;
            emit('step_healed', { n: label, action: step.action, strategy: healed.strategy });
          } else {
            throw handlerErr;
          }
        } else {
          throw handlerErr;
        }
      }

      // If the action exported vars (extract / eval-with-as), merge into the running scope
      if (result?.extracted && typeof result.extracted === 'object') {
        for (const [k, v] of Object.entries(result.extracted)) {
          vars[k] = v;
          emit('var_resolved', { name: k, source: step.action, value: redact(k, v) });
        }
      }

      // Linter: run detectors after the action, attach findings to the step
      let findings = [];
      try {
        findings = await linter.afterStep(session, step, args, result, linterCtx);
      } catch (e) {
        emit('linter_error', { n: label, error: e.message });
      }
      if (findings.length) {
        emit('findings', { n: label, count: findings.length, types: [...new Set(findings.map(f => f.type))] });
      }

      // Post-condition check (if step.expect was declared)
      if (step.expect) {
        const expectSubst = substitute(step.expect, vars);
        const ev = await verifyExpect(session, expectSubst);
        if (!ev.ok) {
          throw new Error(`expect failed: ${ev.error}`);
        }
        emit('step_expect_ok', { n: label, expect: expectSubst });
      }

      const stepEntry = { n: label, action: step.action, ok: true, durationMs: Date.now() - stepStart, screenshot: result?.screenshot };
      if (findings && findings.length) stepEntry.findings = findings;
      stepLog.push(stepEntry);
      emit('step_end', { n: label, action: step.action, ok: true, durationMs: Date.now() - stepStart, screenshot: result?.screenshot, url: result?.url, findings_count: findings?.length || 0 });
    } catch (e) {
      stepLog.push({ n: label, action: step.action, ok: false, durationMs: Date.now() - stepStart, error: e.message });
      emit('step_end', { n: label, action: step.action, ok: false, durationMs: Date.now() - stepStart, error: e.message });
      throw new Error(`step ${label} (${step.action}): ${e.message}`);
    }
  }

  // 3. Flow-level assertions (also collected in env.allAssertions for the run record)
  for (const a of (flow.assertions || [])) {
    try {
      const sub = substitute(a, vars);
      const ok = await runAssertion(session, sub);
      const rec = { ...a, flow: flow.id, passed: ok };
      env.allAssertions.push(rec);
      emit('assertion', { type: a.type, passed: ok, args: a, flow: flow.id });
      if (!ok) throw new Error(`assertion failed: ${JSON.stringify(a)}`);
    } catch (e) {
      env.allAssertions.push({ ...a, flow: flow.id, passed: false, error: e.message });
      emit('assertion', { type: a.type, passed: false, error: e.message, args: a, flow: flow.id });
      throw e;
    }
  }
}

async function executeReplay(flowId, overrides = {}, onEvent = null, meta = {}) {
  const emit = (type, data = {}) => { if (onEvent) try { onEvent({ type, t: Date.now(), ...data }); } catch {} };

  let flow;
  try { flow = loadFlow(flowId); }
  catch (e) { emit('error', { error: e.message }); throw e; }

  const runId = crypto.randomBytes(8).toString('hex');
  const runDir = path.join(DATA_DIR, 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });

  db.prepare(`INSERT INTO runs (id, flow_id, flow_name, status, vars_json, project_id, triggered_by, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(runId, flow.id, flow.name, JSON.stringify(overrides), meta.projectId || null, meta.triggeredBy || null);

  emit('run_start', { runId, flowId: flow.id, flowName: flow.name, totalSteps: (flow.steps || []).length });

  const ctx = { cleanup: [], mailtmInstances: {} };
  const stepLog = [];
  let status = 'passed';
  let error = null;

  // Seed vars: project-vars (lowest priority) → user overrides (highest).
  const vars = {};
  if (meta.projectId) {
    try {
      const pvars = projectsLib.getVarsAsObject(meta.projectId);
      for (const [name, value] of Object.entries(pvars)) {
        vars[name] = value;
        emit('var_resolved', { name, source: 'project', value: redact(name, value) });
      }
    } catch {}
  }
  for (const [name, value] of Object.entries(overrides)) {
    vars[name] = value;
    emit('var_resolved', { name, source: 'override', value: redact(name, value) });
  }

  const browser = await chromium.connect(BROWSERLESS_WS);
  const browserCtx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await browserCtx.newPage();
  page.setDefaultTimeout(30000);

  const session = {
    id: runId,
    page,
    context: browserCtx,
    browser,
    screenshotsDir: path.join(runDir, 'screenshots'),
    events: [],
    eventsPath: path.join(runDir, 'events.jsonl'),
  };

  const allAssertions = [];
  try {
    await runFlow(flowId, { vars, ctx, session, emit, stepLog, allAssertions, prefix: '', depth: 0, runId });
  } catch (e) {
    status = 'failed';
    error = e.message;
  } finally {
    try {
      // Apply project suppression rules to findings before persisting. Auto-triage
      // rows go into finding_triage; matched findings show up dimmed in the viewer.
      if (meta?.projectId) {
        try {
          const rules = require('./rules');
          const allFindings = [];
          for (const s of stepLog) for (const f of (s.findings || [])) allFindings.push(f);
          if (allFindings.length > 0) {
            const matched = rules.applyRules(allFindings, meta.projectId);
            if (matched > 0) emit('rules_applied', { matched });
          }
        } catch (e) {
          // Rule failure should never crash the run save
          // eslint-disable-next-line no-console
          console.warn('[replay] suppression rules failed:', e.message);
        }
      }
      db.prepare(`UPDATE runs SET status = ?, finished_at = CURRENT_TIMESTAMP, result_json = ?, error = ? WHERE id = ?`)
        .run(status, JSON.stringify({ steps: stepLog, vars: redactSecrets(vars), assertions: allAssertions }), error, runId);
    } catch {}
    try { await browserCtx.close(); } catch {}
    try { await browser.close(); } catch {}
    for (const fn of (ctx.cleanup || []).reverse()) try { await fn(); } catch {}
    emit('run_end', { runId, status, error });
  }

  return { runId, status, error, steps: stepLog };
}

function redact(name, value) {
  if (/password|secret|token|otp/i.test(name) && value != null) {
    const s = String(value);
    return s.length <= 2 ? '**' : s.slice(0, 2) + '*'.repeat(s.length - 2);
  }
  return value;
}

async function runAssertion(s, a) {
  switch (a.type) {
    case 'url_contains': return s.page.url().includes(a.fragment);
    case 'text_visible': {
      const txt = await s.page.evaluate(() => document.body.innerText || '');
      return txt.includes(a.text);
    }
    default: throw new Error(`unknown assertion type: ${a.type}`);
  }
}

function redactSecrets(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (/password|secret|token/i.test(k)) out[k] = '<redacted>';
    else out[k] = v;
  }
  return out;
}

/**
 * LLM-based auto-heal: when a deterministic action fails, ask a small/cheap model
 * to look at the current page state and propose a corrected target/script.
 *
 * Returns { ok, result, strategy } or null on failure.
 */
async function healActionWithLLM({ session, step, args, error }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  // Locked: same model as the agent loop.
  const model = 'deepseek/deepseek-v4-flash';

  const { snap } = require('./actions');
  const snapshot = await snap(session).catch(() => null);
  if (!snapshot) return null;

  const elements = (snapshot.elements || []).slice(0, 25).map(e => {
    const o = { tag: e.tag };
    for (const k of ['type', 'placeholder', 'value', 'options', 'disabled', 'name', 'inputmode', 'aria-label', 'role']) {
      if (e[k] !== undefined && e[k] !== null && e[k] !== '') o[k] = e[k];
    }
    if (e.text) o.text = e.text.slice(0, 80);
    return o;
  });

  const prompt = `An action failed in a browser automation flow. Look at the current page and propose a corrected JavaScript snippet that achieves the same intent.

ACTION: ${step.action}
ORIGINAL ARGS: ${JSON.stringify(args).slice(0, 500)}
ERROR: ${error}

CURRENT PAGE:
URL: ${snapshot.url}
ELEMENTS: ${JSON.stringify(elements, null, 2)}
BODY (excerpt): ${(snapshot.text || '').slice(0, 800)}

Reply ONLY with a JSON object: {"script": "<JS to evaluate in page>", "explanation": "<1 sentence>"}.
The script should be a self-contained expression that performs the action and returns 'ok'.
Examples for clicking an element: "(()=>{ const b=document.querySelector('button.foo'); b.click(); return 'ok'; })()"
Do NOT include any text outside the JSON.`;

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = await r.json();
    const txt = data.choices?.[0]?.message?.content || '';
    let parsed; try { parsed = JSON.parse(txt); } catch { return null; }
    if (!parsed.script) return null;
    const result = await session.page.evaluate(parsed.script);
    return { ok: true, result: { ok: true, healed: true, result }, strategy: 'llm-eval', script: parsed.script, explanation: parsed.explanation };
  } catch {
    return null;
  }
}

/**
 * Run a saved flow on a CALLER-PROVIDED session (the recording session of an agent
 * or another long-lived session). Useful for the orchestrator agent which composes
 * known flows + ad-hoc steps in the same browser context.
 */
async function runFlowOnSession({ flowId, overrides = {}, session, ctx = null, onEvent = null, projectId = null, runId = null }) {
  const emit = (type, data = {}) => { if (onEvent) try { onEvent({ type, t: Date.now(), ...data }); } catch {} };
  // Seed vars: project-vars first, then user overrides take precedence.
  const seeded = {};
  if (projectId) { try { Object.assign(seeded, projectsLib.getVarsAsObject(projectId)); } catch {} }
  Object.assign(seeded, overrides);
  const resolvedRunId = runId || crypto.randomBytes(8).toString('hex');
  const env = {
    vars: seeded,
    ctx: ctx || { cleanup: [], mailtmInstances: {} },
    session,
    emit,
    stepLog: [],
    allAssertions: [],
    prefix: '',
    depth: 0,
    runId: resolvedRunId,
  };
  try {
    await runFlow(flowId, env);
    return { ok: true, vars: env.vars, steps: env.stepLog, assertions: env.allAssertions };
  } catch (e) {
    return { ok: false, error: e.message, vars: env.vars, steps: env.stepLog, assertions: env.allAssertions };
  }
}

module.exports = { executeReplay, runFlowOnSession };
