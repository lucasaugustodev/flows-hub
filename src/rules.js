/**
 * Suppression rules — declarative DSL for auto-triaging findings as
 * "not_a_bug" when they match a project-defined pattern.
 *
 * A rule's expression is a JSON object. All clauses are ANDed; each clause
 * matches one path on the finding against one value spec.
 *
 *   {
 *     "type": "network_error",                              // exact match
 *     "severity": ["medium", "low"],                        // any-of
 *     "evidence.status": 406,                                // exact (number)
 *     "evidence.url_shape": { "$regex": "supabase\\.co" }   // regex
 *     "evidence.match":     { "$contains": "lorem" },       // substring
 *     "evidence.url":       { "$prefix": "https://" }       // prefix
 *   }
 *
 * Keys with dots traverse nested objects (`evidence.status` → finding.evidence.status).
 *
 * When a rule matches a finding, we upsert finding_triage with status='not_a_bug',
 * triaged_by='rule', rule_id=<id>, reason='matched rule "<name>"'. Idempotent on
 * conflict (re-applying doesn't duplicate). Manual triage by a human always
 * wins — applyRules skips signatures that are already triaged by a person.
 */
const db = require('./db');

function getPath(obj, path) {
  if (!obj) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function matchValue(actual, spec) {
  if (spec === null) return actual == null;
  if (typeof spec !== 'object') return actual === spec;
  if (Array.isArray(spec)) return spec.some(v => matchValue(actual, v));
  // Operator object
  if ('$regex' in spec) {
    if (typeof actual !== 'string') return false;
    try { return new RegExp(spec.$regex, spec.$flags || '').test(actual); }
    catch { return false; }
  }
  if ('$contains' in spec) {
    if (typeof actual !== 'string') return false;
    return actual.includes(String(spec.$contains));
  }
  if ('$prefix' in spec) {
    if (typeof actual !== 'string') return false;
    return actual.startsWith(String(spec.$prefix));
  }
  if ('$in' in spec) {
    return Array.isArray(spec.$in) && spec.$in.includes(actual);
  }
  if ('$gte' in spec) return typeof actual === 'number' && actual >= spec.$gte;
  if ('$lte' in spec) return typeof actual === 'number' && actual <= spec.$lte;
  // Unknown operator — treat as no-match to be safe
  return false;
}

/**
 * Validate that an expression is well-formed. Throws on malformed input;
 * returns the parsed expr otherwise.
 */
function parseExpr(input) {
  let expr = input;
  if (typeof input === 'string') {
    try { expr = JSON.parse(input); }
    catch (e) { throw new Error('rule expr must be valid JSON: ' + e.message); }
  }
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) {
    throw new Error('rule expr must be a JSON object');
  }
  // Sanity-check $regex compilations up front so a bad rule fails on save,
  // not on every replay.
  for (const v of Object.values(expr)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && '$regex' in v) {
      try { new RegExp(v.$regex, v.$flags || ''); }
      catch (e) { throw new Error(`invalid $regex: ${e.message}`); }
    }
  }
  return expr;
}

function matchesRule(finding, expr) {
  for (const [key, want] of Object.entries(expr)) {
    const actual = getPath(finding, key);
    if (!matchValue(actual, want)) return false;
  }
  return true;
}

/**
 * For each finding in `findings`, evaluate enabled rules of `projectId`.
 * On the first match, upsert a finding_triage row tagged with the rule
 * (unless the signature already has a manual triage). Mutates findings in
 * place to attach `f.triage` and returns count of newly suppressed findings.
 */
function applyRules(findings, projectId) {
  if (!findings || findings.length === 0) return 0;

  const rules = db.prepare(`
    SELECT id, name, expr_json FROM suppression_rules
    WHERE project_id = ? AND enabled = 1
  `).all(projectId);
  if (rules.length === 0) return 0;

  // Compile rule exprs once; skip ones that fail to parse.
  const compiled = [];
  for (const r of rules) {
    try { compiled.push({ ...r, expr: parseExpr(r.expr_json) }); }
    catch { /* skip — admin will see the rule is invalid via the UI */ }
  }

  // Cache existing triage per signature so we don't overwrite human triage.
  const sigs = [...new Set(findings.map(f => f.signature))];
  const placeholders = sigs.map(() => '?').join(',');
  const existing = sigs.length === 0 ? [] : db.prepare(
    `SELECT finding_signature, status, triaged_by FROM finding_triage WHERE project_id = ? AND finding_signature IN (${placeholders})`
  ).all(projectId, ...sigs);
  const triagedBy = new Map(existing.map(t => [t.finding_signature, t.triaged_by]));

  const upsert = db.prepare(`
    INSERT INTO finding_triage (finding_signature, project_id, status, reason, rule_id, triaged_by, triaged_at)
    VALUES (?, ?, 'not_a_bug', ?, ?, 'rule', CURRENT_TIMESTAMP)
    ON CONFLICT (finding_signature, project_id) DO UPDATE SET
      status = CASE WHEN finding_triage.triaged_by = 'rule' THEN excluded.status ELSE finding_triage.status END,
      reason = CASE WHEN finding_triage.triaged_by = 'rule' THEN excluded.reason ELSE finding_triage.reason END,
      rule_id = CASE WHEN finding_triage.triaged_by = 'rule' THEN excluded.rule_id ELSE finding_triage.rule_id END
  `);

  let applied = 0;
  for (const f of findings) {
    // Don't override a person's call.
    const tb = triagedBy.get(f.signature);
    if (tb && tb !== 'rule') continue;
    for (const rule of compiled) {
      if (!matchesRule(f, rule.expr)) continue;
      const reason = `matched rule "${rule.name || rule.id}"`;
      upsert.run(f.signature, projectId, reason, rule.id);
      f.triage = { status: 'not_a_bug', reason, rule_id: rule.id, triaged_by: 'rule' };
      applied++;
      break; // first rule wins
    }
  }
  return applied;
}

module.exports = { applyRules, parseExpr, matchesRule, matchValue, getPath };
