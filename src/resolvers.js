/**
 * Var resolvers — substitute ${VAR} at replay time.
 */
const { execSync } = require('child_process');
const { MailTM } = require('mailtm-cli');

const RESOLVERS = {
  static: ({ value }) => value,

  // Generates a random valid CPF
  'fake.cpf': () => {
    const rand = () => Math.floor(Math.random() * 9);
    const n = Array.from({ length: 9 }, rand);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += n[i] * (10 - i);
    let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0; n.push(d1);
    sum = 0;
    for (let i = 0; i < 10; i++) sum += n[i] * (11 - i);
    let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0; n.push(d2);
    return n.join('');
  },

  'fake.phone': () => {
    // Brazilian mobile: DDD (2) + 9 + 8 digits = 11 total
    const ddd = String(Math.floor(11 + Math.random() * 89));
    const n = String(Math.floor(10000000 + Math.random() * 89999999));
    return `${ddd}9${n}`;
  },

  env: ({ name }) => process.env[name] || '',

  /**
   * HTTP GET/POST that returns the parsed JSON (or raw text when json=false).
   * Lets you pull config from an admin API and use ${CFG.field.subfield} downstream.
   *
   *   { name: "CFG", resolver: "api.fetch",
   *     args: { url: "https://admin.x/api/plans/Y",
   *             headers: { "Authorization": "Bearer ${ADMIN_TOKEN}" } } }
   */
  'api.fetch': async (args) => {
    const { url, method = 'GET', headers = {}, body, json = true, timeout = 15000 } = args;
    if (!url) throw new Error('api.fetch: url required');
    const init = { method, headers: { ...headers } };
    if (body !== undefined && body !== null && body !== '') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(init.headers).some(h => h.toLowerCase() === 'content-type')) {
        init.headers['Content-Type'] = 'application/json';
      }
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw new Error(`api.fetch ${url}: ${r.status} ${text.slice(0, 200)}`);
      if (json === false) return text;
      try { return JSON.parse(text); } catch { return text; }
    } finally { clearTimeout(t); }
  },

  // Creates a fresh disposable inbox via mailtm-cli lib (no shell)
  'mailtm.new': async (args, ctx) => {
    const mt = new MailTM();
    await mt.createAccount();
    ctx.mailtmInstances = ctx.mailtmInstances || {};
    ctx.mailtmInstances[args.bind || 'default'] = mt;
    ctx.cleanup.push(async () => { try { await mt.deleteAccount(); } catch {} });
    return mt.email;
  },

  // Re-authenticate to an EXISTING mailtm inbox using stored credentials,
  // and bind it for later mailtm.wait calls. Use this for login flows that
  // re-use a saved inbox (vs mailtm.new which creates a fresh one).
  'mailtm.bind': async (args, ctx) => {
    const { email, password, bind = 'default' } = args;
    if (!email || !password) throw new Error('mailtm.bind: email and password required');
    const mt = new MailTM({ email, password });
    await mt.loginExisting({ email, password });
    ctx.mailtmInstances = ctx.mailtmInstances || {};
    ctx.mailtmInstances[bind] = mt;
    return email;
  },

  // Polls the mailtm inbox previously created by mailtm.new
  'mailtm.wait': async (args, ctx) => {
    const bind = args.bind || 'default';
    const mt = (ctx.mailtmInstances || {})[bind];
    if (!mt) throw new Error(`mailtm.wait: no inbox bound to "${bind}". Call mailtm.new first.`);
    const out = await mt.waitForOTP({
      timeout: (args.timeout || 180) * 1000,
      subjectFilter: args.subject || null,
      fromFilter: args.from || null,
      otpPattern: args.regex ? new RegExp(args.regex) : null,
      minLength: args.min || 4,
      maxLength: args.max || 8,
    });
    return out.otp;
  },

  // Marks a var as required at replay time — must be supplied via overrides.
  // If we get here, no override was passed → fail fast with a helpful message.
  prompt: ({ question, name }) => {
    const q = question || name || 'value';
    throw new Error(`required var "${q}" not provided. pass it via override: --var ${q}=...`);
  },
};

/**
 * @param {Array<{name, resolver, args?}>} varDefs
 * @param {object} overrides         vars passed at replay time (override resolver)
 * @param {object} ctx               { cleanup: [] }
 * @returns {Promise<object>}        resolved vars { name → value }
 */
async function resolveAll(varDefs = [], overrides = {}, ctx = { cleanup: [] }) {
  const out = { ...overrides };
  for (const v of varDefs) {
    if (v.name in out) continue; // overridden
    const fn = RESOLVERS[v.resolver];
    if (!fn) throw new Error(`unknown resolver: ${v.resolver}`);
    out[v.name] = await fn(v.args || {}, ctx);
  }
  return out;
}

/**
 * Resolve a possibly-nested path against a root object.
 *   getPath({a:{b:[1,2]}}, 'a.b[1]') === 2
 *   getPath({a:1}, 'a') === 1
 *   getPath({}, 'missing.field') === undefined
 */
function getPath(root, path) {
  const keys = String(path).split(/[.\[\]]/).filter(s => s !== '');
  let cur = root;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function stringifyForSubstitution(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const trimmed = expr.trim();
      // Plain var name: O(1) lookup
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        return stringifyForSubstitution(vars[trimmed]);
      }
      // Nested path
      return stringifyForSubstitution(getPath(vars, trimmed));
    });
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

module.exports = { RESOLVERS, resolveAll, substitute };
