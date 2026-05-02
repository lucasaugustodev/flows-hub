#!/usr/bin/env node
/**
 * pageflows CLI — drive the API as a human (or AI) without curl/JSON wrangling.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = path.join(os.homedir(), '.pageflows');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const STATE_FILE = path.join(CFG_DIR, 'state.json');
const INBOX_FILE = path.join(CFG_DIR, 'mailtm.json');

const loadJson = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const saveJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

const cfg = loadJson(CFG_FILE, { url: 'https://pageflows.somosahub.us', key: '' });
const state = loadJson(STATE_FILE, { sessionId: null });

async function api(p, opts = {}, { authRequired = true, includeProject = true } = {}) {
  if (authRequired && !cfg.key) die('not signed in. run: pageflows auth login   (or set a token: pageflows config set key <KEY>)');
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cfg.key) headers['X-API-Key'] = cfg.key;
  if (includeProject && cfg.project) headers['X-Project'] = cfg.project;
  const r = await fetch(cfg.url + p, { ...opts, headers });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) die(`api ${r.status}: ${data.error || text}`);
  return data;
}

function readPasswordSync(prompt) {
  // hidden read from stdin (no echo). Fallback: visible read if not a TTY.
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    // read line as-is
    const data = require('fs').readFileSync(0, 'utf8');
    return data.trim().split('\n')[0];
  }
  // Use readline-sync style via child_process for no-echo. Avoid extra deps.
  const fs = require('fs');
  const stdin = fs.openSync('/dev/tty', 'rs').toString ? null : null;
  try {
    process.stdin.resume();
    process.stdin.setRawMode(true);
    let buf = '';
    while (true) {
      const c = fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      if (c === 0) break;
      const ch = Buffer.alloc(1);
      const n = fs.readSync(0, ch, 0, 1, null);
      if (n === 0) break;
      const s = ch.toString('utf8');
      if (s === '\n' || s === '\r' || s === '') break;
      if (s === '') { process.stdout.write('\n'); process.exit(130); }
      if (s === '' || s === '\b') { if (buf.length) buf = buf.slice(0, -1); continue; }
      buf += s;
    }
    process.stdout.write('\n');
    process.stdin.setRawMode(false);
    return buf;
  } catch (e) {
    // Last resort: visible
    return require('fs').readFileSync(0, 'utf8').trim().split('\n')[0];
  }
}

function readLineSync(prompt) {
  process.stdout.write(prompt);
  // Synchronous line read from fd 0
  const fs = require('fs');
  let buf = '', chunk = Buffer.alloc(1);
  while (true) {
    let n; try { n = fs.readSync(0, chunk, 0, 1, null); } catch { break; }
    if (n === 0) break;
    const s = chunk.toString('utf8');
    if (s === '\n' || s === '\r') { if (s === '\r') { try { fs.readSync(0, chunk, 0, 1, null); } catch {} } break; }
    buf += s;
  }
  return buf.trim();
}

function die(msg) { console.error(msg); process.exit(1); }
const requireSession = () => state.sessionId || die('no current session. run: pageflows session new');

function pickArg(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
function pickFlag(args, name) { return args.includes(name); }
function collectArgs(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) out.push(args[++i]);
  return out;
}

const COMMANDS = {
  async auth(sub, ...args) {
    if (sub === 'signup') {
      const email = pickArg(args, '--email') || readLineSync('email: ');
      const name = pickArg(args, '--name') || readLineSync('name (optional): ');
      const password = pickArg(args, '--password') || readPasswordSync('password (min 8): ');

      // Step 1 — request OTP
      let r1 = await fetch(cfg.url + '/auth/signup/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || null, password }),
      });
      let data1 = await r1.json().catch(() => ({}));
      if (!r1.ok) die(`signup failed: ${data1.error || r1.statusText}`);
      console.log(`✓ verification code sent to ${email} (expires ${data1.expiresAt})`);

      // Step 2 — verify OTP
      const otp = pickArg(args, '--otp') || readLineSync('6-digit code from email: ');
      const r2 = await fetch(cfg.url + '/auth/signup/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      const data2 = await r2.json().catch(() => ({}));
      if (!r2.ok) die(`verification failed: ${data2.error || r2.statusText}`);

      cfg.key = data2.token; saveJson(CFG_FILE, cfg);
      console.log(`✓ signed up as ${data2.user.email}`);
      console.log(`  session token saved (expires ${data2.expiresAt}). use 'pageflows tokens new <name>' for long-lived tokens.`);
    } else if (sub === 'login') {
      const email = pickArg(args, '--email') || readLineSync('email: ');
      const password = pickArg(args, '--password') || readPasswordSync('password: ');
      const r = await fetch(cfg.url + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) die(`login failed: ${data.error || r.statusText}`);
      cfg.key = data.token; saveJson(CFG_FILE, cfg);
      console.log(`✓ logged in as ${data.user.email}`);
    } else if (sub === 'logout') {
      try { await api('/auth/logout', { method: 'POST' }, { authRequired: false }); } catch {}
      cfg.key = ''; saveJson(CFG_FILE, cfg);
      console.log('logged out');
    } else if (sub === 'me') {
      const r = await api('/auth/me');
      console.log(JSON.stringify(r.user, null, 2));
    } else {
      die('pageflows auth signup\npageflows auth login\npageflows auth logout\npageflows auth me');
    }
  },

  async tokens(sub, ...args) {
    if (sub === 'new' || sub === 'create') {
      const name = args[0] || readLineSync('token name (e.g. ci): ');
      const expiresInDays = parseInt(pickArg(args, '--expires-days', '0'), 10) || null;
      const r = await api('/auth/tokens', { method: 'POST', body: JSON.stringify({ name, expiresInDays }) });
      console.log(`✓ token "${name}" created. SAVE THIS NOW (shown only once):`);
      console.log(`  ${r.token}`);
      console.log(`  prefix: ${r.prefix}    id: ${r.id}${r.expiresAt ? `    expires: ${r.expiresAt}` : ''}`);
    } else if (sub === 'list' || sub === 'ls' || !sub) {
      const r = await api('/auth/tokens');
      if (!r.tokens.length) return console.log('(no tokens)');
      for (const t of r.tokens) {
        const last = t.last_used_at ? `last used ${t.last_used_at}` : 'never used';
        console.log(`  ${t.id}  [${t.kind}]  ${(t.name || '<unnamed>').padEnd(20)}  ${t.key_prefix}…  ${last}`);
      }
    } else if (sub === 'revoke' || sub === 'rm') {
      const id = args[0] || die('pageflows tokens revoke <id>');
      await api(`/auth/tokens/${id}`, { method: 'DELETE' });
      console.log('revoked');
    } else if (sub === 'use') {
      cfg.key = args[0] || die('pageflows tokens use <token>');
      saveJson(CFG_FILE, cfg);
      console.log('using token (saved to ~/.pageflows/config.json)');
    } else die('pageflows tokens new <name> [--expires-days N]\npageflows tokens list\npageflows tokens revoke <id>\npageflows tokens use <plaintext>');
  },

  async vars(sub, ...args) {
    if (!sub || sub === 'list' || sub === 'ls') {
      const reveal = args.includes('--reveal');
      const r = await api(`/api/project-vars${reveal ? '?reveal=true' : ''}`);
      if (!r.vars.length) return console.log('(no vars set in this project)');
      console.log(`vars in project ${cfg.project}:`);
      for (const v of r.vars) {
        const lock = v.is_secret ? '🔒 ' : '   ';
        console.log(`  ${lock}${v.name.padEnd(28)} ${v.value}`);
      }
      if (!reveal) console.log(`\nadd --reveal to see secret values (admin/owner only).`);
    } else if (sub === 'set') {
      const spec = args[0];
      if (!spec || !spec.includes('=')) die('pageflows vars set NAME=value [--secret] [--description "..."]');
      const eq = spec.indexOf('=');
      const name = spec.slice(0, eq);
      const value = spec.slice(eq + 1);
      const isSecret = args.includes('--secret');
      const description = pickArg(args, '--description');
      await api(`/api/project-vars/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ value, is_secret: isSecret, description }),
      });
      console.log(`✓ ${name} = ${isSecret ? '<secret>' : value}`);
    } else if (sub === 'get') {
      const name = args[0] || die('pageflows vars get NAME');
      const r = await api(`/api/project-vars?reveal=true`);
      const v = r.vars.find(x => x.name === name);
      if (!v) die(`var not found: ${name}`);
      console.log(v.value);
    } else if (sub === 'unset' || sub === 'rm' || sub === 'delete') {
      const name = args[0] || die('pageflows vars unset NAME');
      await api(`/api/project-vars/${encodeURIComponent(name)}`, { method: 'DELETE' });
      console.log(`✓ removed ${name}`);
    } else die('pageflows vars list [--reveal]\npageflows vars set NAME=value [--secret] [--description "..."]\npageflows vars get NAME\npageflows vars unset NAME');
  },

  async usage() {
    const r = await api('/auth/usage');
    console.log('Totals:'); for (const t of r.totals) console.log(`  ${t.action.padEnd(28)} ${t.count}`);
    console.log('\nRecent:');
    for (const u of r.recent.slice(0, 30)) {
      const d = u.details_json ? JSON.parse(u.details_json) : {};
      const summary = Object.entries(d).slice(0, 4).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : v}`).join(' ');
      console.log(`  ${u.created_at}  ${u.action.padEnd(20)} ${summary}`);
    }
  },

  async project(sub, ...args) {
    if (sub === 'list' || sub === 'ls' || !sub) {
      const r = await api('/projects', {}, { includeProject: false });
      if (!r.projects.length) return console.log('(no projects yet — create one: pageflows project new <name>)');
      const current = cfg.project;
      for (const p of r.projects) {
        const mark = p.slug === current ? '*' : ' ';
        console.log(` ${mark} ${p.slug.padEnd(24)} ${p.role.padEnd(7)} ${p.name}`);
      }
    } else if (sub === 'new' || sub === 'create') {
      const name = args[0] || die('pageflows project new <name> [--slug X] [--description "..."]');
      const slug = pickArg(args, '--slug');
      const description = pickArg(args, '--description');
      const r = await api('/projects', { method: 'POST', body: JSON.stringify({ name, slug, description }) }, { includeProject: false });
      cfg.project = r.project.slug; saveJson(CFG_FILE, cfg);
      console.log(`✓ project "${r.project.slug}" created (you are owner). Set as current.`);
    } else if (sub === 'use') {
      const slug = args[0] || die('pageflows project use <slug>');
      // verify membership
      const r = await api(`/projects/${slug}`, {}, { includeProject: false });
      cfg.project = r.project.slug; saveJson(CFG_FILE, cfg);
      console.log(`using project: ${r.project.slug}  (role: ${r.project.role})`);
    } else if (sub === 'show' || sub === 'info') {
      const slug = args[0] || cfg.project || die('pageflows project show [slug]');
      const r = await api(`/projects/${slug}`, {}, { includeProject: false });
      console.log(`${r.project.slug}  (${r.project.role})`);
      console.log(`  name: ${r.project.name}`);
      if (r.project.description) console.log(`  desc: ${r.project.description}`);
      console.log(`  created: ${r.project.created_at}`);
      console.log(`  members:`);
      for (const m of r.members) console.log(`    ${m.role.padEnd(7)} ${m.email}${m.name ? ' (' + m.name + ')' : ''}`);
    } else if (sub === 'invite') {
      const slug = pickArg(args, '--project') || cfg.project || die('no current project. pageflows project use <slug>');
      const role = pickArg(args, '--role', 'editor');
      const expiresInDays = parseInt(pickArg(args, '--expires-days', '14'), 10);
      const r = await api(`/projects/${slug}/invites`, { method: 'POST', body: JSON.stringify({ role, expiresInDays }) }, { includeProject: false });
      console.log(`✓ invite created (role: ${r.role}, expires: ${r.expiresAt})`);
      console.log(`  share this code with the invitee:`);
      console.log();
      console.log(`    ${r.code}`);
      console.log();
      console.log(`  they redeem with: pageflows project join ${r.code}`);
    } else if (sub === 'invites') {
      const slug = args[0] || cfg.project || die('no current project');
      const r = await api(`/projects/${slug}/invites`, {}, { includeProject: false });
      if (!r.invites.length) return console.log('(no pending invites)');
      for (const i of r.invites) {
        const status = i.used_at ? `used by ${i.used_by} at ${i.used_at}` : i.expires_at && new Date(i.expires_at) < new Date() ? 'expired' : `valid until ${i.expires_at}`;
        console.log(`  ${i.code}  [${i.role}]  ${status}`);
      }
    } else if (sub === 'join') {
      const code = args[0] || die('pageflows project join <code>');
      const r = await api('/invites/redeem', { method: 'POST', body: JSON.stringify({ code }) }, { includeProject: false });
      cfg.project = r.project.slug; saveJson(CFG_FILE, cfg);
      console.log(`✓ joined "${r.project.slug}" as ${r.project.role}. Set as current project.`);
    } else if (sub === 'members') {
      const slug = args[0] || cfg.project || die('no current project');
      const r = await api(`/projects/${slug}`, {}, { includeProject: false });
      for (const m of r.members) console.log(`  ${m.role.padEnd(7)} ${m.email}${m.name ? ' (' + m.name + ')' : ''}`);
    } else die(`pageflows project list
pageflows project new <name> [--slug X] [--description "..."]
pageflows project use <slug>
pageflows project show [slug]
pageflows project invite [--role editor|admin|viewer] [--expires-days 14]
pageflows project invites
pageflows project join <code>
pageflows project members [slug]`);
  },

  async config(sub, ...args) {
    if (sub === 'set') { cfg[args[0]] = args[1]; saveJson(CFG_FILE, cfg); console.log('saved'); }
    else if (sub === 'show') {
      console.log(`url: ${cfg.url}`);
      console.log(`key: ${cfg.key ? cfg.key.slice(0, 12) + '…' : '(unset)'}`);
      console.log(`project: ${cfg.project || '(unset)'}`);
    }
    else die('pageflows config set <url|key|project> <value>\npageflows config show');
  },

  async session(sub, ...args) {
    if (!sub || sub === 'new') {
      const r = await api('/api/sessions', { method: 'POST' });
      state.sessionId = r.id; saveJson(STATE_FILE, state);
      console.log(r.id);
    } else if (sub === 'show') {
      const r = await api(`/api/sessions/${requireSession()}`);
      console.log(JSON.stringify(r, null, 2));
    } else if (sub === 'use') {
      state.sessionId = args[0]; saveJson(STATE_FILE, state);
      console.log(`using ${args[0]}`);
    } else if (sub === 'close') {
      const id = args[0] || requireSession();
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      if (state.sessionId === id) { state.sessionId = null; saveJson(STATE_FILE, state); }
      console.log('closed');
    } else die(`unknown session subcommand: ${sub}`);
  },

  async goto(url, ...args) {
    if (!url) die('pageflows goto <url>');
    const waitUntil = pickArg(args, '--wait', 'domcontentloaded');
    const r = await api(`/api/sessions/${requireSession()}/goto`, {
      method: 'POST', body: JSON.stringify({ url, waitUntil }),
    });
    console.log(`url: ${r.url}`);
    if (r.title) console.log(`title: ${r.title}`);
    if (r.screenshot) console.log(`shot: ${cfg.url}/data/${r.screenshot}`);
  },

  async fill(target, ...rest) {
    if (!target) die(`pageflows fill <css-target> <value>
pageflows fill <css-target> --as VAR resolver[:json-args]
        Generates a real value via the resolver, fills it, but records "\${VAR}" so replay can substitute.`);
    let value, recordAs;
    const asIdx = rest.indexOf('--as');
    if (asIdx >= 0) {
      const varName = rest[asIdx + 1];
      const spec = rest[asIdx + 2];
      if (!varName || !spec) die('--as needs: --as VAR resolver[:json-args]');
      const colon = spec.indexOf(':');
      const resolver = colon >= 0 ? spec.slice(0, colon) : spec;
      const args = colon >= 0 ? JSON.parse(spec.slice(colon + 1)) : {};
      value = await resolveLocal(resolver, args);
      recordAs = '${' + varName + '}';
    } else {
      value = rest[0];
      if (value === undefined) die('pageflows fill <css-target> <value>');
    }
    const body = recordAs ? { target, value, recordAs } : { target, value };
    const r = await api(`/api/sessions/${requireSession()}/fill`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`ok ${r.ok}${recordAs ? ` (recorded as ${recordAs} = ${value})` : ''}${r.screenshot ? ` shot ${cfg.url}/data/${r.screenshot}` : ''}`);
  },

  async click(...args) {
    if (!args[0]) die('pageflows click <text>            # by visible text\npageflows click --target <css>   # by selector');
    const target = pickArg(args, '--target');
    const text = target ? null : args[0];
    const body = target ? { target } : { text };
    const r = await api(`/api/sessions/${requireSession()}/click`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`ok ${r.ok}${r.screenshot ? ` shot ${cfg.url}/data/${r.screenshot}` : ''}`);
  },

  async eval(...args) {
    if (!args.length) die('pageflows eval "<js-expression>" [--as VAR]');
    const as = pickArg(args, '--as');
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue; }
      positional.push(args[i]);
    }
    const script = positional.join(' ');
    const r = await api(`/api/sessions/${requireSession()}/eval`, { method: 'POST', body: JSON.stringify({ script, as }) });
    if (as && r.extracted) console.log(`✓ ${as} = ${JSON.stringify(r.extracted[as])}`);
    else console.log(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2));
  },

  async extract(...args) {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue; }
      positional.push(args[i]);
    }
    const selector = positional[0];
    if (!selector) die('pageflows extract <css-selector> --as VAR [--transform currency|int|float|trim|lower|upper|regex:<pat>] [--attr value|innerText|<name>]');
    const as = pickArg(args, '--as');
    if (!as) die('--as required');
    const transform = pickArg(args, '--transform');
    const attr = pickArg(args, '--attr');
    const body = { selector, as };
    if (transform) body.transform = transform;
    if (attr) body.attr = attr;
    const r = await api(`/api/sessions/${requireSession()}/extract`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`✓ ${as} = ${JSON.stringify(r.extracted?.[as])}`);
  },

  async assert(...args) {
    const actual = pickArg(args, '--actual');
    const expected = pickArg(args, '--expected');
    const compare = pickArg(args, '--compare', 'equals');
    const tolerance = parseFloat(pickArg(args, '--tolerance', '0'));
    const message = pickArg(args, '--message');
    if (actual === undefined || expected === undefined) die('pageflows assert --actual <val> --expected <val> [--compare equals|numeric_equals|equals_ignore_case|contains|regex_match|not_equals] [--tolerance N] [--message "..."]');
    await api(`/api/sessions/${requireSession()}/assert_eq`, {
      method: 'POST',
      body: JSON.stringify({ actual, expected, compare, tolerance, message }),
    });
    console.log(`✓ ${compare}: actual=${actual} expected=${expected}`);
  },

  async toggle(...args) {
    if (!args.length) die('pageflows toggle "<label>" [--off]\n  Smart checkbox: finds and toggles a consent/checkbox-like element by label, including custom React components.');
    const off = args.includes('--off');
    const label = args.filter(a => !a.startsWith('--')).join(' ');
    if (!label) die('pageflows toggle "<label>" [--off]');
    const r = await api(`/api/sessions/${requireSession()}/toggle`, {
      method: 'POST', body: JSON.stringify({ label, expectChecked: !off }),
    });
    console.log(`✓ toggled "${label}"${r.strategy ? ' via ' + r.strategy : ''}${r.screenshot ? ' shot ' + cfg.url + '/data/' + r.screenshot : ''}`);
  },

  async dialog(...args) {
    const accept = pickArg(args, '--accept');
    const title = pickArg(args, '--title');
    const noScroll = args.includes('--no-scroll');
    if (!accept) die('pageflows dialog --accept "<button text>" [--title "<dialog title>"] [--no-scroll]\n  Handles modal dialog: scrolls to bottom (terms acceptance) and clicks accept button.');
    const r = await api(`/api/sessions/${requireSession()}/dialog`, {
      method: 'POST', body: JSON.stringify({ accept, title, scrollToEnd: !noScroll }),
    });
    console.log(`✓ dialog "${accept}"${r.screenshot ? ' shot ' + cfg.url + '/data/' + r.screenshot : ''}`);
  },

  async select(target, ...rest) {
    if (!target) die('pageflows select <css> <label>\npageflows select <css> --value <value>');
    let body = { target };
    const valueIdx = rest.indexOf('--value');
    if (valueIdx >= 0) body.value = rest[valueIdx + 1];
    else body.label = rest[0];
    if (!body.label && !body.value) die('select needs a label or --value');
    const r = await api(`/api/sessions/${requireSession()}/select`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`ok ${r.ok}${r.screenshot ? ` shot ${cfg.url}/data/${r.screenshot}` : ''}`);
  },

  async press(key) {
    if (!key) die('pageflows press <key>   # e.g. Enter, Tab, Escape');
    const r = await api(`/api/sessions/${requireSession()}/press`, { method: 'POST', body: JSON.stringify({ key }) });
    console.log(`ok ${r.ok}`);
  },

  async wait(...args) {
    const id = requireSession();
    if (args[0] === 'ms') {
      const ms = parseInt(args[1] || '1000', 10);
      await api(`/api/sessions/${id}/wait_ms`, { method: 'POST', body: JSON.stringify({ ms }) });
      console.log(`waited ${ms}ms`);
    } else {
      const target = args[0];
      if (!target) die('pageflows wait <css-selector>\npageflows wait ms <ms>');
      await api(`/api/sessions/${id}/wait_for`, { method: 'POST', body: JSON.stringify({ target }) });
      console.log(`found ${target}`);
    }
  },

  async snap(...args) {
    const r = await api(`/api/sessions/${requireSession()}/snap`);
    if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`URL    ${r.url}`);
    console.log(`TITLE  ${r.title || ''}`);
    console.log('ELEMENTS:');
    for (const e of (r.elements || []).slice(0, 30)) {
      const text = (e.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const ph = e.placeholder ? ` ph="${e.placeholder}"` : '';
      const type = e.type ? ` type=${e.type}` : '';
      const val = e.value !== undefined ? ` value=${JSON.stringify(e.value)}` : '';
      const opts = e.options ? ` options=[${e.options.map(o => `${JSON.stringify(o.value)}=${JSON.stringify(o.label)}`).join(', ')}]` : '';
      console.log(`  [${String(e.id).padStart(2)}] ${e.tag}${type}${ph}${val}${opts} :: ${text}`);
    }
  },

  async screenshot() {
    const r = await api(`/api/sessions/${requireSession()}/screenshot`, { method: 'POST', body: '{}' });
    console.log(`${cfg.url}/data/${r.screenshot}`);
  },

  async mailtm(sub, ...args) {
    const { MailTM } = require('mailtm-cli');
    const inboxes = loadJson(INBOX_FILE, {});
    if (sub === 'new') {
      const mt = new MailTM();
      await mt.createAccount();
      inboxes[mt.email] = { password: mt.password, token: mt.token };
      saveJson(INBOX_FILE, inboxes);
      console.log(mt.email);
    } else if (sub === 'wait') {
      const email = args[0]; if (!email) die('pageflows mailtm wait <email> [--subject ...] [--timeout 120]');
      const stored = inboxes[email] || die(`no stored inbox for ${email}`);
      const subject = pickArg(args.slice(1), '--subject', null);
      const from = pickArg(args.slice(1), '--from', null);
      const timeout = parseInt(pickArg(args.slice(1), '--timeout', '120'), 10);
      const mt = new MailTM({ email, password: stored.password, token: stored.token });
      const r = await mt.waitForOTP({ subjectFilter: subject, fromFilter: from, timeout: timeout * 1000 });
      console.log(r.otp);
    } else if (sub === 'list') {
      Object.keys(inboxes).forEach(e => console.log(e));
    } else die('pageflows mailtm new\npageflows mailtm wait <email>\npageflows mailtm list');
  },

  async save(name, ...args) {
    if (!name) die('pageflows save <name> [--var NAME=resolver[:json-args]] [--assert url_contains=/path]');
    const id = requireSession();
    const vars = collectArgs(args, '--var').map(spec => {
      const eq = spec.indexOf('=');
      const varName = spec.slice(0, eq);
      const rest = spec.slice(eq + 1);
      const colon = rest.indexOf(':');
      const resolver = colon >= 0 ? rest.slice(0, colon) : rest;
      const jsonArgs = colon >= 0 ? JSON.parse(rest.slice(colon + 1)) : {};
      return { name: varName, resolver, args: jsonArgs };
    });
    const assertions = collectArgs(args, '--assert').map(spec => {
      const [type, ...rest] = spec.split('=');
      const v = rest.join('=');
      if (type === 'url_contains') return { type, fragment: v };
      if (type === 'text_visible') return { type, text: v };
      die(`unknown assertion type: ${type}`);
    });
    const flowId = pickArg(args, '--id', null);
    const body = { name, vars, assertions };
    if (flowId) body.id = flowId;
    const r = await api(`/api/sessions/${id}/save-flow`, { method: 'POST', body: JSON.stringify(body) });
    console.log(`flow ${r.flow.id} (${r.flow.steps.length} steps)`);
  },

  async invoke(flowId, ...args) {
    if (!flowId) die('pageflows invoke <flow-id> [--var NAME=value ...]\n  Runs a saved flow on the CURRENT session (chains flows in a manual recording).');
    const id = requireSession();
    const vars = {};
    for (const spec of collectArgs(args, '--var')) {
      const eq = spec.indexOf('=');
      vars[spec.slice(0, eq)] = spec.slice(eq + 1);
    }
    const r = await api(`/api/sessions/${id}/invoke-flow`, { method: 'POST', body: JSON.stringify({ flowId, vars }) });
    console.log(`✓ invoked ${flowId} (${(r.steps || []).length} steps, ${(r.assertions || []).length} assertions)`);
    if (r.assertions?.length) for (const a of r.assertions) console.log(`  ${a.passed ? '✓' : '✗'} ${a.type} ${JSON.stringify(a).slice(0, 120)}`);
  },

  async replay(flowId, ...args) {
    if (!flowId) die('pageflows replay <flow-id> [--var NAME=value ...]');
    const vars = {};
    for (const spec of collectArgs(args, '--var')) {
      const eq = spec.indexOf('=');
      vars[spec.slice(0, eq)] = spec.slice(eq + 1);
    }
    const r = await fetch(`${cfg.url}/api/flows/${flowId}/replay?stream=true`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ vars }),
    });
    if (!r.ok) die(`http ${r.status}: ${await r.text()}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let event = '', data = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const ln of lines) {
        if (ln.startsWith('event: ')) event = ln.slice(7).trim();
        else if (ln.startsWith('data: ')) data = ln.slice(6);
        else if (ln === '' && event && data) {
          try { printEvent(event, JSON.parse(data)); } catch {}
          event = ''; data = '';
        }
      }
    }
  },

  async flows(sub, ...args) {
    if (sub === 'export') {
      const dir = pickArg(args, '--to') || './flows';
      const withVars = args.includes('--with-vars');
      const fs = require('fs');
      fs.mkdirSync(dir, { recursive: true });
      const list = await api('/api/flows');
      let count = 0;
      for (const f of list.flows) {
        const detail = await api(`/api/flows/${encodeURIComponent(f.id)}`);
        fs.writeFileSync(`${dir}/${f.id}.json`, JSON.stringify(detail.json, null, 2) + '\n');
        count++;
      }
      console.log(`✓ exported ${count} flows to ${dir}/`);
      if (withVars) {
        const vars = await api('/api/project-vars?reveal=true').catch(() => ({ vars: [] }));
        fs.writeFileSync(`${dir}/_project-vars.json`, JSON.stringify(vars.vars || [], null, 2) + '\n');
        console.log(`✓ exported ${vars.vars?.length || 0} project vars to ${dir}/_project-vars.json`);
      }
      return;
    }
    if (sub === 'import') {
      const dir = args[0] || die('pageflows flows import <dir>');
      const fs = require('fs');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
      let count = 0, failed = 0;
      for (const file of files) {
        const flow = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
        try {
          await api('/api/flows', { method: 'POST', body: JSON.stringify(flow) });
          count++;
          console.log(`  ✓ ${flow.id}`);
        } catch (e) {
          failed++;
          console.log(`  ✗ ${flow.id}: ${e.message}`);
        }
      }
      console.log(`\n${count} imported, ${failed} failed`);
      // Restore vars if available
      const varsFile = `${dir}/_project-vars.json`;
      if (fs.existsSync(varsFile)) {
        const vars = JSON.parse(fs.readFileSync(varsFile, 'utf8'));
        for (const v of vars) {
          try {
            await api(`/api/project-vars/${encodeURIComponent(v.name)}`, {
              method: 'PUT',
              body: JSON.stringify({ value: v.value, is_secret: v.is_secret, description: v.description }),
            });
            console.log(`  ✓ var ${v.name}`);
          } catch (e) { console.log(`  ✗ var ${v.name}: ${e.message}`); }
        }
      }
      return;
    }
    if (sub === 'list' || !sub) {
      const r = await api('/api/flows');
      if (!r.flows.length) return console.log('(no flows)');
      for (const f of r.flows) console.log(`${f.id.padEnd(32)} ${f.name}`);
      return;
    }
    die('pageflows flows                              # list\npageflows flows export [--to <dir>] [--with-vars]\npageflows flows import <dir>');
  },

  async runs(...args) {
    const r = await api('/api/runs');
    const limit = parseInt(pickArg(args, '--limit', '20'), 10);
    for (const x of r.runs.slice(0, limit)) {
      console.log(`${x.id.padEnd(18)} ${(x.flow_id || '').padEnd(24)} ${x.status.padEnd(8)} ${x.started_at}`);
    }
  },

  async run(runId) {
    if (!runId) die('pageflows run <run-id>');
    console.log(`${cfg.url}/runs/${runId}`);
  },

  async schedules(sub, ...args) {
    if (!sub || sub === 'list') {
      const flowFilter = pickArg(args, '--flow');
      const { schedules } = await api('/api/schedules');
      const list = flowFilter ? schedules.filter(s => s.flow_id === flowFilter || s.flow_id.startsWith(flowFilter)) : schedules;
      if (list.length === 0) return console.log('(no schedules' + (flowFilter ? ' for flow ' + flowFilter : '') + ')');
      console.log('id        cron            flow                            on?  last      next (UTC)');
      for (const s of list) {
        const next = s.next_fire ? s.next_fire.replace('T', ' ').slice(0, 16) : '—';
        console.log(`${s.id.slice(0,8)}  ${s.cron_expr.padEnd(15)} ${(s.flow_id||'').slice(0,30).padEnd(31)} ${s.enabled?'on ':'off'}  ${(s.last_status||'-').padEnd(8)}  ${next}`);
      }
    } else if (sub === 'create' || sub === 'add') {
      const flowId = args[0];
      const cronExpr = args[1];
      if (!flowId || !cronExpr) {
        die('usage: pageflows schedules create <flow-id> "<cron>" [--name N]\n' +
            '  cron presets: @hourly @daily @weekly @monthly  or 5-field "m h dom mon dow"');
      }
      const name = pickArg(args, '--name');
      const r = await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ flow_id: flowId, cron_expr: cronExpr, name: name || null }),
      });
      console.log(`✓ schedule ${r.id}`);
    } else if (sub === 'delete' || sub === 'rm') {
      const id = await resolveScheduleId(args[0]);
      await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      console.log('✓ deleted ' + id.slice(0,8));
    } else if (sub === 'toggle' || sub === 'enable' || sub === 'disable') {
      const id = await resolveScheduleId(args[0]);
      const { schedules } = await api('/api/schedules');
      const s = schedules.find(x => x.id === id);
      if (!s) die('not found');
      const next = sub === 'enable' ? true : sub === 'disable' ? false : !s.enabled;
      await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
      console.log(`✓ ${id.slice(0,8)} → ${next ? 'enabled' : 'disabled'}`);
    } else if (sub === 'run' || sub === 'fire') {
      // Fire a one-shot replay with the schedule's vars (handy for testing).
      const id = await resolveScheduleId(args[0]);
      const { schedules } = await api('/api/schedules');
      const s = schedules.find(x => x.id === id);
      if (!s) die('not found');
      console.log(`▶ replaying ${s.flow_id} with schedule vars...`);
      const r = await api(`/api/flows/${encodeURIComponent(s.flow_id)}/replay`, {
        method: 'POST', body: JSON.stringify({ vars: s.vars || {} }),
      });
      console.log(`run ${r.runId} → ${r.status}\n${r.runUrl}`);
    } else {
      die('pageflows schedules list [--flow X] | create <flow> "<cron>" [--name N] | delete <id> | toggle/enable/disable <id> | run <id>');
    }
  },

  async rules(sub, ...args) {
    if (!sub || sub === 'list') {
      const { rules } = await api('/api/suppression-rules');
      if (rules.length === 0) return console.log('(no rules)');
      for (const r of rules) {
        const status = r.enabled ? 'on ' : 'off';
        const matches = r.match_count + (r.match_count === 1 ? ' match ' : ' matches');
        console.log(`${r.id.slice(0,8)}  ${status}  [${matches}]  ${r.name}`);
        if (r.description) console.log(`          ${r.description}`);
        console.log(`          expr: ${JSON.stringify(r.expr)}`);
      }
    } else if (sub === 'create' || sub === 'add') {
      const name = args[0];
      const exprText = args[1];
      if (!name || !exprText) {
        die('usage: pageflows rules create "<name>" \'<json-expr>\' [--description "..."]\n' +
            '  expr DSL: keys are dotted paths on a finding; values are exact / array (any-of) /\n' +
            '            {$regex} / {$contains} / {$prefix} / {$gte} / {$lte}.\n' +
            '  example: pageflows rules create "supabase 406" \'{"type":"network_error","evidence.status":406}\'');
      }
      let expr;
      try { expr = JSON.parse(exprText); }
      catch (e) { die('invalid expr JSON: ' + e.message); }
      const description = pickArg(args, '--description');
      const r = await api('/api/suppression-rules', {
        method: 'POST',
        body: JSON.stringify({ name, expr, description: description || null }),
      });
      console.log(`✓ rule ${r.id}`);
    } else if (sub === 'delete' || sub === 'rm') {
      const id = await resolveRuleId(args[0]);
      await api(`/api/suppression-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      console.log('✓ deleted ' + id.slice(0,8) + ' (auto-triages cleared)');
    } else if (sub === 'toggle' || sub === 'enable' || sub === 'disable') {
      const id = await resolveRuleId(args[0]);
      const { rules } = await api('/api/suppression-rules');
      const r = rules.find(x => x.id === id);
      if (!r) die('not found');
      const next = sub === 'enable' ? true : sub === 'disable' ? false : !r.enabled;
      await api(`/api/suppression-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
      console.log(`✓ ${id.slice(0,8)} → ${next ? 'enabled' : 'disabled'}`);
    } else if (sub === 'suggestions') {
      const { suggestions } = await api('/api/rule-suggestions');
      if (suggestions.length === 0) return console.log('(no suggestions yet — keep triaging findings as not_a_bug; suggestions appear when ≥3 share a pattern)');
      for (const s of suggestions) {
        console.log(`[${s.count}x] ${s.suggested_name}`);
        console.log(`     expr: ${JSON.stringify(s.suggested_expr)}`);
        if (s.sample_msg) console.log(`     sample: ${s.sample_msg.slice(0, 100)}`);
        console.log(`     accept with: pageflows rules create "${s.suggested_name}" '${JSON.stringify(s.suggested_expr)}'`);
      }
    } else {
      die('pageflows rules list | create "<name>" \'<json>\' | delete <id> | toggle/enable/disable <id> | suggestions');
    }
  },

  async health(sub, ...args) {
    // Cross-project health snapshot. The same data the web dashboard shows.
    const { projects } = await api('/api/dashboard', {}, { includeProject: false });
    if (sub === 'json') return console.log(JSON.stringify(projects, null, 2));
    if (projects.length === 0) return console.log('(no projects)');
    const p7d = pickArg(args, '--days', '7');
    console.log(`Health snapshot (last ${p7d}d):\n`);
    console.log('project              pass-rate  runs   findings   sched  rules   last-failure');
    for (const p of projects) {
      const pr = p.metrics.pass_rate == null ? ' —  ' : (p.metrics.pass_rate + '%').padStart(4);
      const lf = p.metrics.last_failure
        ? `${p.metrics.last_failure.flow_id}@${p.metrics.last_failure.started_at.slice(5,16)}`
        : '—';
      console.log(
        (p.project.slug || p.project.name).slice(0,20).padEnd(20) + ' ' +
        pr.padStart(8) + '   ' +
        String(p.metrics.runs).padStart(4) + '   ' +
        String(p.metrics.open_findings).padStart(8) + '    ' +
        String(p.metrics.schedules).padStart(3) + '    ' +
        String(p.metrics.rules).padStart(3) + '    ' +
        lf
      );
    }
  },

  async agent(...args) {
    if (!args.length || args[0] === 'run') {
      // strip flag pairs (--name value) before treating remainder as the objective
      const start = args[0] === 'run' ? 1 : 0;
      const positional = [];
      for (let i = start; i < args.length; i++) {
        if (args[i].startsWith('--')) { i++; continue; } // skip flag and its value
        positional.push(args[i]);
      }
      const objective = positional.join(' ');
      if (!objective) die('pageflows agent run "<objective>" [--max-turns 50]');
      const maxTurns = parseInt(pickArg(args, '--max-turns', '50'), 10);
      const { run } = require('./agent.js');
      console.log(`▶ agent objective: ${objective}`);
      console.log(`  model: deepseek/deepseek-v4-flash (locked), max-turns: ${maxTurns}`);
      const r = await run({
        objective,
        maxTurns,
        onEvent: (e) => {
          if (e.type === 'session_created') console.log(`  session: ${e.sessionId}`);
          else if (e.type === 'turn_start') process.stdout.write(`  turn ${e.turn}: `);
          else if (e.type === 'tool_call') {
            const a = JSON.stringify(e.args).slice(0, 100);
            process.stdout.write(`${e.name}(${a})\n`);
          } else if (e.type === 'tool_result' && !e.ok) {
            console.log(`    ✗ ${e.error}`);
          } else if (e.type === 'llm_error') console.log(`  ✗ llm: ${e.error}`);
          else if (e.type === 'llm_text') console.log(`  ⊘ model gave up with text: ${(e.content || '').slice(0, 200)}`);
          else if (e.type === 'flow_saved') console.log(`  ✓ flow saved: ${e.flowId}`);
          else if (e.type === 'flow_save_failed') console.log(`  ✗ flow save failed: ${e.error}`);
        },
      });
      console.log();
      console.log(`◼ ${r.success ? 'SUCCESS' : 'FAILED'} (${r.turns} turns)`);
      console.log(`  summary: ${r.summary}`);
      if (r.error) console.log(`  error: ${r.error}`);
      console.log(`  session run: ${cfg.url}/runs/${r.sessionId}`);
      if (r.savedFlowId) {
        console.log();
        console.log(`  Replay this flow with:`);
        console.log(`    pageflows replay ${r.savedFlowId}`);
      }
      process.exit(r.success ? 0 : 1);
    }
    die('pageflows agent run "<objective>"');
  },

  async help() { usage(); },
};

// Local resolvers — used by `fill --as` to generate a real value during recording.
// Mirror of server-side resolvers.js (subset that makes sense client-side).
/** Accept a full id or any unambiguous prefix; helpful for short copy-pastes. */
async function resolveScheduleId(input) {
  if (!input) die('schedule id required');
  const { schedules } = await api('/api/schedules');
  const matches = schedules.filter(s => s.id === input || s.id.startsWith(input));
  if (matches.length === 0) die(`no schedule matches "${input}"`);
  if (matches.length > 1) die(`prefix "${input}" matches ${matches.length} schedules — be more specific`);
  return matches[0].id;
}

async function resolveRuleId(input) {
  if (!input) die('rule id required');
  const { rules } = await api('/api/suppression-rules');
  const matches = rules.filter(r => r.id === input || r.id.startsWith(input));
  if (matches.length === 0) die(`no rule matches "${input}"`);
  if (matches.length > 1) die(`prefix "${input}" matches ${matches.length} rules — be more specific`);
  return matches[0].id;
}

async function resolveLocal(name, args) {
  if (name === 'static') return args.value;
  if (name === 'fake.cpf') {
    const r = () => Math.floor(Math.random() * 9);
    const n = Array.from({ length: 9 }, r);
    let s = 0; for (let i = 0; i < 9; i++) s += n[i] * (10 - i);
    let d1 = 11 - (s % 11); if (d1 >= 10) d1 = 0; n.push(d1);
    s = 0; for (let i = 0; i < 10; i++) s += n[i] * (11 - i);
    let d2 = 11 - (s % 11); if (d2 >= 10) d2 = 0; n.push(d2);
    return n.join('');
  }
  if (name === 'fake.phone') {
    const ddd = String(Math.floor(11 + Math.random() * 89));
    const n = String(Math.floor(10000000 + Math.random() * 89999999));
    return `${ddd}9${n}`;
  }
  if (name === 'env') return process.env[args.name] || '';
  die(`unknown local resolver: ${name} (use a server-side resolver via 'pageflows save --var ...')`);
}

function printEvent(type, d) {
  const t = (s) => s ? new Date(s).toISOString().slice(11, 19) : '';
  if (type === 'run_start') console.log(`▶ run ${d.runId} (${d.totalSteps} steps)`);
  else if (type === 'var_resolving') console.log(`  ⟳ ${d.name} via ${d.resolver}`);
  else if (type === 'var_resolved') console.log(`  ✓ ${d.name} = ${d.value}`);
  else if (type === 'var_failed') console.log(`  ✗ ${d.name} failed: ${d.error}`);
  else if (type === 'step_start') console.log(`  → ${d.n}. ${d.action} ${JSON.stringify(d.args)}`);
  else if (type === 'step_end') console.log(`     ${d.ok ? '✓' : '✗'} ${d.durationMs}ms${d.error ? ' ' + d.error : ''}`);
  else if (type === 'assertion') console.log(`  ${d.passed ? '✓' : '✗'} assert ${d.type}`);
  else if (type === 'run_end') console.log(`◼ ${d.status}${d.error ? ' ' + d.error : ''}`);
  else if (type === 'done') console.log(`  → ${d.runUrl}`);
  else if (type === 'error') console.log(`✗ ${d.error}`);
}

function usage() {
  console.log(`pageflows — record once, replay forever (CLI for the API)

AUTH (sign up / log in / manage tokens)
  pageflows auth signup       # creates account, saves session token
  pageflows auth login        # email + password
  pageflows auth logout
  pageflows auth me

  pageflows tokens new <name> [--expires-days N]   # create long-lived API token
  pageflows tokens list
  pageflows tokens revoke <id>
  pageflows tokens use <plaintext>                  # save an existing token to config

  pageflows usage                                   # your usage history (replays, agent calls)

PROJECT VARS (credentials/constants store — auto-merged into flow vars on replay)
  pageflows vars list [--reveal]                     # secrets redacted unless admin+ with --reveal
  pageflows vars set NAME=value [--secret]           # save (--secret redacts in displays)
  pageflows vars get NAME                            # fetch raw value
  pageflows vars unset NAME

PROJECTS (multi-tenant — all flows/runs/sessions belong to a project)
  pageflows project list                             # lists projects you're a member of
  pageflows project new <name> [--slug X]            # create new project (you become owner)
  pageflows project use <slug>                       # set current project (used by all other commands)
  pageflows project show [slug]                      # details + members
  pageflows project invite [--role editor]           # generate invite code (admin+)
  pageflows project invites                          # list pending invites for current project
  pageflows project join <code>                      # redeem invite, become member
  pageflows project members

CONFIG
  pageflows config set url <api-url>
  pageflows config set key <api-key>                # manual override (e.g. paste a long-lived token)
  pageflows config set project <slug>               # current project shortcut
  pageflows config show

SESSIONS (one current at a time, stored in ~/.pageflows/state.json)
  pageflows session new
  pageflows session show
  pageflows session use <id>
  pageflows session close [id]

VERIFICATION (config-aware testing)
  pageflows extract <css> --as VAR [--transform currency|int|float|regex:<pat>] [--attr value|innerText]
                                                   # read DOM into a flow var
  pageflows eval "<js>" --as VAR                   # run JS, store return as a flow var
  pageflows assert --actual <val> --expected <val> [--compare numeric_equals] [--tolerance N]
                                                   # fails the step if mismatch (use \${VAR} to compare runtime values)

ACTIONS  (operate on the current session — every call is recorded as a step)
  pageflows goto <url> [--wait domcontentloaded|load|networkidle]
  pageflows fill <css-target> <value>
  pageflows click <visible-text>           # or: --target <css>
  pageflows press <key>                    # Enter, Tab, Escape, ...
  pageflows wait <css-selector>            # or: pageflows wait ms <ms>
  pageflows snap                           # peek at current page (NOT recorded)
  pageflows screenshot

DISPOSABLE INBOX (mail.tm)
  pageflows mailtm new
  pageflows mailtm wait <email> [--subject "..."] [--from "..."] [--timeout 120]
  pageflows mailtm list

PERSIST AS A FLOW
  pageflows save <name>
      [--id custom-id]
      [--var NAME=resolver]                  # static, fake.cpf, fake.phone, mailtm.new, mailtm.wait, env, prompt
      [--var NAME=resolver:'{"k":"v"}']
      [--assert url_contains=/path]
      [--assert text_visible=Welcome]

REPLAY
  pageflows replay <flow-id> [--var NAME=value ...]   # SSE live, prints each step
  pageflows flows
  pageflows runs [--limit 20]
  pageflows run <run-id>                              # prints public viewer URL

SCHEDULES (cron-driven replays — minute-granularity, UTC)
  pageflows schedules list [--flow X]
  pageflows schedules create <flow-id> "<cron>" [--name N]
                                          # cron: @hourly @daily @weekly @monthly  or "m h dom mon dow"
  pageflows schedules delete <id>
  pageflows schedules enable <id>
  pageflows schedules disable <id>
  pageflows schedules run <id>            # fire one-shot manually with the schedule's vars

SUPPRESSION RULES (auto-triage findings as not_a_bug)
  pageflows rules list
  pageflows rules create "<name>" '<json-expr>' [--description "..."]
                                          # expr DSL: { type, severity, evidence.x, ... }
                                          #   $regex / $contains / $prefix / $gte / $lte / arrays = any-of
  pageflows rules delete <id>             # also clears auto-triages this rule created
  pageflows rules enable / disable <id>
  pageflows rules suggestions             # patterns from your manual not_a_bug triages

HEALTH (cross-project pass-rate + open-findings snapshot)
  pageflows health                        # plaintext table
  pageflows health json                   # full JSON for piping

AUTONOMOUS AGENT (LLM-in-the-loop, OpenRouter)
  pageflows agent run "<objective>" [--max-turns 25]
      Drives the browser to achieve an objective.
      Locked to deepseek/deepseek-v4-flash (~$0.005/run with orchestrator).
      Agent uses list_flows + invoke_flow first — saved flows run for free; LLM only fills gaps.
      Requires OPENROUTER_API_KEY env var (or 'pageflows config set openrouterKey <k>').
`);
}

(async () => {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return usage();
  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command: ${cmd}\n\n` + 'run `pageflows help`');
  try { await fn(...args); } catch (e) { die(e.message); }
})();
