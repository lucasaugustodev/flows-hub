/**
 * LLM linter — post-run pass that asks DeepSeek to triage findings against the
 * project's context_md.
 *
 * Flow:
 *   1. After a replay finishes, gather findings from the run + the project's
 *      context_md.
 *   2. Send a single prompt: "given this project context, classify each finding
 *      as kept | downgraded | suppressed with a brief reason."
 *   3. Persist verdicts in finding_llm_verdicts (separate from finding_triage so
 *      we never overwrite a human's manual triage). Verdicts are advisory until
 *      the user accepts them via the UI.
 *
 * Disabled when OPENROUTER_API_KEY is unset, when the project has no
 * context_md, or when DISABLE_LLM_LINTER=1.
 */
const db = require('./db');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'deepseek/deepseek-v4-flash';
const SITE_URL = process.env.PUBLIC_BASE_URL || 'https://pageflows.somosahub.us';

// Cap the prompt size so a flow that produces hundreds of findings doesn't
// blow the context window. We slice oldest-first and trust the dedup at the
// detector layer to keep variety high.
const MAX_FINDINGS_PER_CALL = 25;
const MAX_CONTEXT_BYTES = 12 * 1024;
const MAX_FINDING_MSG = 240;

const SYSTEM_PROMPT = `You are a QA triage assistant. Given a project's context (markdown describing tech stack, expected behaviors, known acceptable quirks) and a list of findings raised during an automated browser-replay test, classify each finding into one of three verdicts:

- "kept": looks like a genuine defect that should be investigated.
- "downgraded": real signal but lower severity than the detector flagged (e.g. the underlying issue is acknowledged but minor).
- "suppressed": explicitly expected per the project context (e.g. context says "401 on /me is normal for anon traffic" and the finding is exactly that).

Be conservative: when unsure, prefer "kept". Suppress only with strong evidence in the context. Each reason should be ≤ 200 chars and reference the context section that supports your call when applicable.

Respond with a JSON array of objects: [{"signature": "...", "verdict": "kept"|"downgraded"|"suppressed", "reason": "..."}]. No prose, no markdown fences.`;

function isEnabled() {
  if (!OPENROUTER_KEY) return false;
  if (process.env.DISABLE_LLM_LINTER === '1') return false;
  return true;
}

async function callLLM({ contextMd, findings }) {
  const trimmedCtx = (contextMd || '').slice(0, MAX_CONTEXT_BYTES);
  const slim = findings.slice(0, MAX_FINDINGS_PER_CALL).map(f => ({
    signature: f.signature,
    type: f.type,
    severity: f.severity,
    msg: (f.msg || '').slice(0, MAX_FINDING_MSG),
    evidence: pickEvidence(f.evidence),
  }));

  const userMsg = `PROJECT CONTEXT:\n\`\`\`md\n${trimmedCtx || '(no context provided)'}\n\`\`\`\n\nFINDINGS (${slim.length}):\n${JSON.stringify(slim, null, 2)}`;

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE_URL,
      'X-Title': 'pageflows-llm-linter',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error('openrouter non-json: ' + text.slice(0, 300)); }
  if (!r.ok || json.error) throw new Error('openrouter ' + r.status + ': ' + (json.error?.message || text.slice(0, 300)));
  const content = json.choices?.[0]?.message?.content || '';
  return parseVerdicts(content);
}

/**
 * Strip evidence to a sane subset before sending to the LLM. Keep the keys most
 * useful for triage; drop big payloads or PII-ish stuff.
 */
function pickEvidence(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const keep = ['url', 'url_shape', 'status', 'method', 'pattern', 'match', 'kind', 'step_action', 'target'];
  const out = {};
  for (const k of keep) if (ev[k] !== undefined) out[k] = typeof ev[k] === 'string' ? ev[k].slice(0, 200) : ev[k];
  return out;
}

/**
 * Tolerate slightly off-spec LLM output: try to find the JSON array even if it's
 * wrapped in {"verdicts": [...]} or has stray prose.
 */
function parseVerdicts(content) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch {
    // Try to extract a top-level array
    const m = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!m) throw new Error('LLM did not return parseable JSON');
    parsed = JSON.parse(m[0]);
  }
  // Accept either an array directly or an object with array values
  let arr;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object') {
    arr = Object.values(parsed).find(v => Array.isArray(v));
  }
  if (!Array.isArray(arr)) throw new Error('LLM response did not contain an array of verdicts');
  const out = [];
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue;
    const sig = String(v.signature || '').trim();
    const verdict = String(v.verdict || '').toLowerCase();
    if (!sig) continue;
    if (!['kept', 'downgraded', 'suppressed'].includes(verdict)) continue;
    out.push({ signature: sig, verdict, reason: String(v.reason || '').slice(0, 500) });
  }
  return out;
}

/**
 * Run the LLM pass for a given run. Returns { ranAt, count, error? }.
 * Idempotent w.r.t. previous verdicts on the same signatures (overwrites them
 * — newer verdict reflects newer model + newer context).
 */
async function lintRun({ runId, projectId }) {
  if (!isEnabled()) return { skipped: 'disabled' };
  const run = db.prepare('SELECT result_json FROM runs WHERE id = ? AND project_id = ?').get(runId, projectId);
  if (!run) return { skipped: 'run not found' };
  const result = run.result_json ? JSON.parse(run.result_json) : null;
  if (!result?.steps) return { skipped: 'no steps' };

  const findings = [];
  for (const s of result.steps) for (const f of (s.findings || [])) findings.push(f);
  if (findings.length === 0) return { skipped: 'no findings' };

  const proj = db.prepare('SELECT context_md FROM projects WHERE id = ?').get(projectId);
  if (!proj?.context_md) return { skipped: 'no project context' };

  let verdicts;
  try { verdicts = await callLLM({ contextMd: proj.context_md, findings }); }
  catch (e) { return { error: e.message }; }

  const upsert = db.prepare(`
    INSERT INTO finding_llm_verdicts (finding_signature, project_id, verdict, reason, model, ran_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(finding_signature, project_id) DO UPDATE SET
      verdict = excluded.verdict,
      reason = excluded.reason,
      model = excluded.model,
      ran_at = CURRENT_TIMESTAMP
  `);
  let count = 0;
  for (const v of verdicts) {
    upsert.run(v.signature, projectId, v.verdict, v.reason, MODEL);
    count++;
  }
  return { ranAt: new Date().toISOString(), count };
}

module.exports = { lintRun, isEnabled, parseVerdicts };
