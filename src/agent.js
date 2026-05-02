/**
 * Autonomous LLM-in-the-loop browser agent.
 *
 * Flow:
 *   1. CLI passes an objective (natural language).
 *   2. Agent creates a pageflows session.
 *   3. Loop: snap → ask LLM (with tools) → run tool → repeat.
 *   4. On finish(), optionally saves the recorded events as a reusable flow.
 *
 * The LLM only sees text — current page DOM (snap) + recent events. No vision,
 * keeps cost low. Tools mirror the pageflows actions plus mailtm helpers.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = path.join(os.homedir(), '.pageflows');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const INBOX_FILE = path.join(CFG_DIR, 'mailtm.json');

const cfg = (() => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } })();
const PAGEFLOWS_URL = cfg.url || 'https://pageflows.somosahub.us';
const PAGEFLOWS_KEY = cfg.key;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || cfg.openrouterKey || '';
// Model is locked to deepseek-v4-flash — proven cheapest/most-reliable combo with the
// orchestrator pattern (~$0.005/run). Don't override per-invocation; if a future model
// is genuinely better, change this constant in source and deploy.
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const SITE_URL = process.env.PAGEFLOWS_SITE || 'https://pageflows.somosahub.us';

if (!OPENROUTER_KEY) {
  // resolved later in run()
}

async function pageflowsApi(p, opts = {}) {
  const r = await fetch(PAGEFLOWS_URL + p, {
    ...opts,
    headers: { 'X-API-Key': PAGEFLOWS_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`pageflows ${r.status}: ${data.error || text}`);
  return data;
}

// ============== TOOLS ==============
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_flows',
      description: 'List all available pre-recorded flows you can invoke instead of doing browser actions yourself. Each flow is a deterministic recording that runs cheaper and more reliably than LLM-driven steps. ALWAYS call this once at the start to discover what is already available.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invoke_flow',
      description: 'Run a previously-saved flow on the current browser session. Pass var overrides to customize. PREFER this over manual steps — flows are cheaper, faster, and battle-tested. After invoke_flow returns, the page is at the flow\'s end state. Always snap afterwards to confirm.',
      parameters: {
        type: 'object',
        properties: {
          flow_id: { type: 'string', description: 'The id of the saved flow (from list_flows).' },
          vars: { type: 'object', description: 'Override values for the flow\'s variables, e.g. { "CLASS_CODE": "ABC123", "PASSWORD": "x" }.' },
        },
        required: ['flow_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goto',
      description: 'Navigate the browser to a URL. Always use https://. Wait for DOM to load.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snap',
      description: 'Read the current page: returns visible interactive elements (buttons, inputs, links, selects with their options) with text/placeholder/value, plus the URL and a body-text excerpt. Call this whenever you need to see what is on screen before deciding the next action. NOT recorded as a step.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element by its visible text (preferred) OR by CSS selector via target. Examples: { "text": "Continuar" } or { "target": "button:has-text(\\"Selecionar plano\\") >> nth=1" }. After clicking, the page may navigate or update.',
      parameters: { type: 'object', properties: { text: { type: 'string' }, target: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Type a value into an input/textarea. Target by CSS selector, e.g. input[type=email], input[placeholder="CPF"]. Value is the text to type.',
      parameters: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' } }, required: ['target', 'value'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Pick an <option> in a <select>. Use value (option value attr) when known.',
      parameters: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' } }, required: ['target'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press',
      description: 'Send a single keypress (Enter, Tab, Escape, ArrowDown, ...).',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_ms',
      description: 'Pause for N milliseconds. Use sparingly — prefer wait_for_text when waiting for content.',
      parameters: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_text',
      description: 'Block until the visible page text contains the given string (timeout 30s).',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'eval',
      description: 'Run a JavaScript expression in the page context and return its result. ESCAPE HATCH — only use when normal actions cannot achieve the goal (e.g. React forms that ignore button clicks: eval "document.querySelector(\\"form\\").requestSubmit(); \'ok\'").',
      parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mailtm_new',
      description: 'Create a fresh disposable email inbox at mail.tm. Returns the email address. Use this whenever a flow needs an email for signup.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mailtm_wait',
      description: 'Poll the disposable inbox for an OTP-style code in incoming email. Returns the OTP digits. Optionally filter by subject substring.',
      parameters: { type: 'object', properties: { email: { type: 'string' }, subject: { type: 'string' }, timeout_seconds: { type: 'integer' } }, required: ['email'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fake_cpf',
      description: 'Generate a valid random Brazilian CPF (11 digits, no separators).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fake_phone',
      description: 'Generate a valid random Brazilian mobile phone (11 digits, DDD+9+8).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Stop the agent loop. Call when the objective is achieved OR when stuck and unable to proceed. Set success=true if the objective was met. If save_as is provided AND success=true, the recorded session steps are saved as a reusable flow with that id.',
      parameters: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          summary: { type: 'string' },
          save_as: { type: 'string', description: 'Flow id to save under, e.g. "my-test-flow"' },
        },
        required: ['success', 'summary'],
      },
    },
  },
];

// ============== TOOL EXECUTION ==============
async function execTool(state, name, args) {
  const sid = state.sessionId;
  switch (name) {
    case 'list_flows': {
      const r = await pageflowsApi('/api/flows');
      // Also include each flow's vars (so the agent knows what to pass)
      const flows = [];
      for (const f of r.flows) {
        try {
          const detail = await pageflowsApi(`/api/flows/${f.id}`);
          const j = detail.json || {};
          flows.push({
            id: f.id,
            name: f.name,
            description: f.description || '',
            vars: (j.vars || []).map(v => ({ name: v.name, resolver: v.resolver, default: v.args?.value })),
            assertions: (j.assertions || []).map(a => ({ type: a.type, ...(a.fragment ? { fragment: a.fragment } : {}), ...(a.text ? { text: a.text } : {}) })),
          });
        } catch { flows.push({ id: f.id, name: f.name, description: f.description || '' }); }
      }
      return { flows };
    }
    case 'invoke_flow': {
      const r = await pageflowsApi(`/api/sessions/${sid}/invoke-flow`, {
        method: 'POST',
        body: JSON.stringify({ flowId: args.flow_id, vars: args.vars || {} }),
      });
      // Trim to keep response small
      return {
        ok: r.ok,
        flow_id: args.flow_id,
        steps_run: (r.steps || []).length,
        steps_failed: (r.steps || []).filter(s => !s.ok && !s.skipped).length,
        assertions: (r.assertions || []).map(a => ({ type: a.type, flow: a.flow, passed: a.passed })),
        vars_resolved: Object.fromEntries(Object.entries(r.vars || {}).map(([k, v]) => [k, /password|secret|token|otp/i.test(k) ? '<redacted>' : v])),
        error: r.error,
      };
    }
    case 'goto': {
      const r = await pageflowsApi(`/api/sessions/${sid}/goto`, { method: 'POST', body: JSON.stringify({ url: args.url, waitUntil: 'domcontentloaded' }) });
      return { ok: true, url: r.url };
    }
    case 'snap': {
      const r = await pageflowsApi(`/api/sessions/${sid}/snap`);
      // Forward most attributes — selector choice depends on having full info
      const PASS = ['type', 'placeholder', 'value', 'options', 'disabled', 'name',
        'inputmode', 'autocomplete', 'pattern', 'aria-label', 'role', 'required', 'checked', 'href'];
      const elements = (r.elements || []).slice(0, 35).map(e => {
        const o = { tag: e.tag };
        for (const k of PASS) if (e[k] !== undefined && e[k] !== null && e[k] !== '') o[k] = e[k];
        if (o.options) o.options = o.options.slice(0, 10);
        const txt = (e.text || '').replace(/\s+/g, ' ').trim();
        if (txt) o.text = txt.slice(0, 80);
        return o;
      });
      return { url: r.url, title: r.title, elements, body_text: (r.text || '').slice(0, 1500) };
    }
    case 'click': {
      const body = args.target ? { target: args.target } : { text: args.text };
      const r = await pageflowsApi(`/api/sessions/${sid}/click`, { method: 'POST', body: JSON.stringify(body) });
      return { ok: true };
    }
    case 'fill': {
      await pageflowsApi(`/api/sessions/${sid}/fill`, { method: 'POST', body: JSON.stringify(args) });
      return { ok: true };
    }
    case 'select': {
      await pageflowsApi(`/api/sessions/${sid}/select`, { method: 'POST', body: JSON.stringify(args) });
      return { ok: true };
    }
    case 'press': {
      await pageflowsApi(`/api/sessions/${sid}/press`, { method: 'POST', body: JSON.stringify(args) });
      return { ok: true };
    }
    case 'wait_ms': {
      await pageflowsApi(`/api/sessions/${sid}/wait_ms`, { method: 'POST', body: JSON.stringify({ ms: args.ms }) });
      return { ok: true };
    }
    case 'wait_for_text': {
      await pageflowsApi(`/api/sessions/${sid}/wait_for`, { method: 'POST', body: JSON.stringify({ text: args.text, timeout: 30000 }) });
      return { ok: true };
    }
    case 'eval': {
      const r = await pageflowsApi(`/api/sessions/${sid}/eval`, { method: 'POST', body: JSON.stringify({ script: args.script }) });
      const result = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return { ok: true, result: (result || '').slice(0, 800) };
    }
    case 'mailtm_new': {
      const { MailTM } = require('mailtm-cli');
      const mt = new MailTM();
      await mt.createAccount();
      const inboxes = (() => { try { return JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); } catch { return {}; } })();
      inboxes[mt.email] = { password: mt.password, token: mt.token };
      fs.mkdirSync(CFG_DIR, { recursive: true });
      fs.writeFileSync(INBOX_FILE, JSON.stringify(inboxes, null, 2));
      return { email: mt.email };
    }
    case 'mailtm_wait': {
      const { MailTM } = require('mailtm-cli');
      const inboxes = (() => { try { return JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); } catch { return {}; } })();
      const stored = inboxes[args.email];
      if (!stored) throw new Error(`no stored inbox for ${args.email}. call mailtm_new first.`);
      const mt = new MailTM({ email: args.email, password: stored.password, token: stored.token });
      const r = await mt.waitForOTP({ subjectFilter: args.subject || null, timeout: (args.timeout_seconds || 120) * 1000 });
      return { otp: r.otp, subject: r.subject };
    }
    case 'fake_cpf': {
      const r = () => Math.floor(Math.random() * 9);
      const n = Array.from({ length: 9 }, r);
      let s = 0; for (let i = 0; i < 9; i++) s += n[i] * (10 - i);
      let d1 = 11 - (s % 11); if (d1 >= 10) d1 = 0; n.push(d1);
      s = 0; for (let i = 0; i < 10; i++) s += n[i] * (11 - i);
      let d2 = 11 - (s % 11); if (d2 >= 10) d2 = 0; n.push(d2);
      return { cpf: n.join('') };
    }
    case 'fake_phone': {
      const ddd = String(Math.floor(11 + Math.random() * 89));
      const num = String(Math.floor(10000000 + Math.random() * 89999999));
      return { phone: `${ddd}9${num}` };
    }
    case 'finish': {
      state.done = true;
      state.success = !!args.success;
      state.summary = args.summary || '';
      state.saveAs = args.save_as || null;
      return { ok: true };
    }
  }
  throw new Error(`unknown tool: ${name}`);
}

// ============== LLM CALL ==============
async function callOpenRouter({ model, messages, tools }) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE_URL,
      'X-Title': 'pageflows-agent',
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0 }),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`openrouter non-json: ${text.slice(0, 300)}`); }
  if (!r.ok || json.error) throw new Error(`openrouter ${r.status}: ${json.error?.message || text.slice(0, 300)}`);
  return json.choices?.[0]?.message;
}

// ============== AGENT LOOP ==============
const SYSTEM = `You are an autonomous browser agent for the pageflows platform. You drive a real Chromium browser to achieve a user's objective.

ALWAYS START WITH list_flows
- The platform has pre-recorded flows that already do common things (signup, OTP, address forms, plan selection, etc).
- Each flow is deterministic, cheap, and battle-tested. PREFER invoke_flow over manual steps.
- Pattern: list_flows → identify which existing flows cover parts of the objective → invoke them in order with appropriate vars → only do manual steps for parts NOT covered.
- After invoke_flow, snap to confirm the new page state, then decide next action.

GENERAL RULES
- Each turn call ONE tool (or a small parallel batch when independent). After every page-changing action call snap.
- Do NOT call snap twice in a row without an action between.
- Do NOT call wait_ms between every step — only after navigation or form submission.
- Aim to finish in under 25 turns when leveraging flows.

SELECTOR STRATEGY (this is the most common failure mode — read carefully)
- Click by VISIBLE TEXT whenever possible: { "text": "Continuar" }. More robust than CSS.
- For inputs, snap returns ALL relevant attributes. Pick the most specific selector that matches exactly one element. Build it from the snap output.
- Examples of selectors that work for fill: input[type=email], input[type=password], input[inputmode=numeric], input[placeholder="CPF"], input[placeholder="nome completo"].
- WHEN AN INPUT HAS MULTIPLE ATTRIBUTES (e.g. type=text + inputmode=numeric + autocomplete=one-time-code), prefer the inputmode/autocomplete attribute over generic type=text — those are more unique.
- If a selector fails with a Playwright timeout, STOP retrying the same selector — re-snap and pick a different attribute.
- For nth-of-list selectors: button:has-text("Selecionar plano") >> nth=1 (0-indexed).
- For exact text match (not substring): button:text-is("12 parcelas").

BRAZILIAN FORMS (Portal Hub and similar)
- Use fake_cpf and fake_phone tools — they generate valid 11-digit values that pass form validation.
- For email-OTP signups: 1) mailtm_new → email. 2) fill email field with returned email. 3) click submit. 4) mailtm_wait(email, subject) → otp. 5) fill the OTP field — the field is usually input[inputmode=numeric] NOT input[type=text]. 6) click "Confirmar código" or similar.
- Date inputs (input[type=date]) accept "YYYY-MM-DD".
- React forms with native <button type=submit>: click works most of the time. If after clicking nothing happens (URL doesn't change after wait_ms 4000), fall back to: eval "document.querySelector('form').requestSubmit(); 'ok'".

SELECT ELEMENTS
- Snap returns elements[i].options as [{value, label}, ...]. Use the VALUE in your select call, not the label, unless told otherwise.

SESSION RECORDING
- Every successful action you take is recorded as a step in a pageflows session. When you finish with success=true and provide save_as="my-id", the recorded steps become a reusable flow that can be replayed without an LLM.
- snap is NOT recorded. fake_cpf, fake_phone, mailtm_new, mailtm_wait are NOT recorded as page steps but their values are remembered.

WHEN STUCK
- Re-snap. Look at body_text for error messages. Look at inputs[i].value to verify your fills landed.
- Try a different selector strategy. Try eval as escape hatch. If two consecutive different attempts fail, finish with success=false and explain.

REACT FORM FALLBACK (CRITICAL — applied multiple times in a typical signup)
- After you click a submit/Continuar button, take a snap. If the URL DID NOT change AND you see the same form, IMMEDIATELY call: eval { script: "document.querySelector('form').requestSubmit(); 'ok'" }. Then snap again.
- Do NOT click the same button a second time hoping it will work. Move to eval fallback after the FIRST failed submit.

DON'T GIVE UP MID-FLOW
- A signup has many screens. Until the success URL is reached, keep going. Re-snap and pick the next action.
- Only finish with success=false after ≥3 DIFFERENT strategies failed for the same blocker.

CALL finish WHEN
- Objective is achieved. Set success=true, summary, and save_as if the flow is reusable.
- Cannot proceed (3+ different attempts failed for the same step). Set success=false and explain in summary.`;

async function run({ objective, maxTurns = 50, onEvent = null }) {
  const model = DEFAULT_MODEL;
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY not set. export OPENROUTER_API_KEY=... or pageflows config set openrouterKey <key>');
  if (!PAGEFLOWS_KEY) throw new Error('pageflows API key not configured. run: pageflows config set key <key>');

  const emit = (t, d) => { if (onEvent) try { onEvent({ type: t, ...d }); } catch {} };

  const sess = await pageflowsApi('/api/sessions', { method: 'POST' });
  const sessionId = sess.id;
  emit('session_created', { sessionId });

  const state = { sessionId, done: false, success: false, summary: '', saveAs: null, turns: 0, costInTokens: 0, costOutTokens: 0 };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Objective: ${objective}` },
  ];

  let lastError = null;
  for (let turn = 0; turn < maxTurns && !state.done; turn++) {
    state.turns = turn + 1;
    emit('turn_start', { turn: state.turns });
    let msg;
    try { msg = await callOpenRouter({ model, messages, tools: TOOLS }); }
    catch (e) { lastError = e.message; emit('llm_error', { error: e.message }); break; }
    if (!msg) { lastError = 'empty LLM response'; break; }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      // model gave plain text — stop and treat as failure (it should always tool call)
      lastError = `model returned text instead of tool call: ${(msg.content || '').slice(0, 200)}`;
      emit('llm_text', { content: msg.content });
      break;
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let args;
      try { args = JSON.parse(tc.function.arguments || '{}'); }
      catch (e) { args = {}; }
      emit('tool_call', { turn: state.turns, name, args });
      let result, err;
      try { result = await execTool(state, name, args); }
      catch (e) { err = e.message; result = { ok: false, error: e.message }; }
      emit('tool_result', { turn: state.turns, name, ok: !err, error: err, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
      if (state.done) break;
    }
  }

  // Optionally save the recorded session as a flow
  let savedFlowId = null;
  if (state.done && state.success && state.saveAs) {
    try {
      const saved = await pageflowsApi(`/api/sessions/${sessionId}/save-flow`, {
        method: 'POST',
        body: JSON.stringify({ id: state.saveAs, name: state.saveAs, description: `agent-recorded: ${objective.slice(0, 200)}`, vars: [], assertions: [] }),
      });
      savedFlowId = saved.flow.id;
      emit('flow_saved', { flowId: savedFlowId });
    } catch (e) {
      emit('flow_save_failed', { error: e.message });
    }
  }

  // Close session
  try { await pageflowsApi(`/api/sessions/${sessionId}`, { method: 'DELETE' }); } catch {}

  return {
    sessionId,
    success: state.success,
    summary: state.summary,
    turns: state.turns,
    error: lastError,
    savedFlowId,
  };
}

module.exports = { run, TOOLS };
