/**
 * untranslated_string — Detects raw i18n keys that leaked into the rendered UI
 * or that surface as missing-key warnings on the console.
 *
 * Common shapes in the wild:
 *   - "common.button.save"       (dot-namespaced key shown verbatim)
 *   - "{{user.name}}"            (Mustache/Handlebars never interpolated)
 *   - "[i18n.errors.required]"   (debug-mode i18n marker)
 *   - "MISSING_KEY: foo.bar"     (i18next missingKeyHandler default)
 *
 * Only scans rendered text when the page content actually changed this step,
 * to avoid re-flagging the same key on every click. Console/page-error scan
 * runs every step (those are inherently per-step events). Medium severity.
 */
const PATTERNS = [
  { name: 'missing_key_marker', re: /\bMISSING_KEY:\s*[a-z][a-zA-Z0-9_.]+/g, scope: 'both' },
  { name: 'bracket_marker',     re: /\[i18n\.[a-z][a-zA-Z0-9_.]+\]/gi,       scope: 'both' },
  { name: 'mustache_unrendered',re: /\{\{\s*[a-z_][a-zA-Z0-9_.]*\s*\}\}/g,    scope: 'both' },
  // Dot-namespaced i18n key shown verbatim — only when it looks like a key
  // (≥ 2 dots, all-lowercase segments, ≤ 30 chars per segment). Aggressive
  // false-positive guards via extraCheck.
  {
    name: 'dot_key',
    re: /\b[a-z][a-z0-9_]{1,30}(?:\.[a-z][a-z0-9_]{1,30}){2,5}\b/g,
    scope: 'dom',
    extraCheck: (m) => {
      if (/\.(com|net|org|io|dev|co|br|us|app|me|gov|edu|tv)$/i.test(m)) return false;
      if (/^v?\d/.test(m) || /\.\d/.test(m)) return false;
      if (/\b(www|http|https|file|node_modules|min|js|css)\b/i.test(m)) return false;
      return true;
    },
  },
];

const MAX_FINDINGS_PER_STEP = 5;

function scanCorpus(corpus, sources, makeSignature, step, out, seen, contentChanged) {
  for (const { name, re, scope, extraCheck } of PATTERNS) {
    if (scope === 'dom' && !contentChanged) continue;
    re.lastIndex = 0;
    const matches = corpus.match(re);
    if (!matches) continue;
    for (const m of matches) {
      const key = name + ':' + m;
      if (seen.has(key)) continue;
      if (extraCheck && !extraCheck(m)) continue;
      seen.add(key);
      const sig = makeSignature(['untranslated_string', name, m.toLowerCase()]);
      out.push({
        type: 'untranslated_string',
        severity: 'medium',
        signature: sig,
        msg: `Possible untranslated/missing i18n key surfaced: ${m}`,
        evidence: {
          pattern: name,
          match: m,
          source: sources,
          step_action: step.action,
        },
      });
      if (out.length >= MAX_FINDINGS_PER_STEP) return true;
    }
  }
  return false;
}

function detect({ step, before, after, events, makeSignature }) {
  const out = [];
  const seen = new Set();
  const contentChanged = before.contentHash !== after.contentHash;

  // Console/pageerror scan — every step
  const errCorpus = [...events.consoleErrors, ...events.pageErrors].join('\n');
  if (errCorpus) {
    if (scanCorpus(errCorpus, 'console', makeSignature, step, out, seen, contentChanged)) return out;
  }

  // Rendered text scan — only when content actually changed this step
  if (contentChanged && after.content) {
    scanCorpus(after.content, 'dom', makeSignature, step, out, seen, contentChanged);
  }

  return out;
}

module.exports = { detect, PATTERNS };
