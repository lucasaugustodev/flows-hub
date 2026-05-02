/**
 * id_leak — Internal/raw identifiers that leaked into user-visible UI.
 *
 * Production UIs should show human-readable references ("Pedido #4521",
 * "Lucas Augusto"), not raw database keys. When a UUID, ObjectId, or random
 * 24+ char hash shows up in body text, it's almost always a missing-display
 * bug. Same for unix epochs and ISO timestamps shown verbatim instead of
 * formatted.
 *
 * Patterns checked (only scanned when DOM content actually changed this step):
 *   - UUID v1-v5             ("3b1c…-…-…-…-…")
 *   - Mongo ObjectId         (24 lowercase hex)
 *   - Long hex/base64 hash   (≥32 hex or base64 chars in a row)
 *   - Unix epoch             (10-digit timestamp around current decade)
 *   - ISO timestamp          ("2025-04-12T14:33:21.123Z" raw)
 *
 * Medium severity. Bounded to 5 findings per step to avoid screen explosions.
 */
const PATTERNS = [
  {
    name: 'uuid',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  },
  {
    name: 'mongo_objectid',
    re: /\b[0-9a-f]{24}\b/gi,
    extraCheck: (m) => /[0-9]/.test(m) && /[a-f]/i.test(m), // not all-digit, not all-letter
  },
  {
    name: 'long_hex',
    re: /\b[0-9a-f]{32,64}\b/gi,
    extraCheck: (m) => /[0-9]/.test(m) && /[a-f]/i.test(m),
  },
  {
    name: 'unix_epoch',
    // 10-digit number that falls roughly in 2001..2050 → highly suspicious if shown raw
    re: /\b1[0-9]{9}\b/g,
    extraCheck: (m) => {
      const n = Number(m);
      // 2001-09-09 ≈ 1000000000, 2033-05 ≈ 2000000000
      return n > 1_000_000_000 && n < 2_500_000_000;
    },
  },
  {
    name: 'iso_timestamp',
    re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
  },
];

const MAX_FINDINGS_PER_STEP = 5;

function detect({ step, before, after, makeSignature }) {
  const out = [];
  const seen = new Set();

  // Only scan when DOM content actually changed — otherwise we'd re-flag the
  // same leaked ID on every click on the same page.
  const contentChanged = before.contentHash !== after.contentHash;
  if (!contentChanged || !after.content) return out;

  const text = after.content;

  for (const { name, re, extraCheck } of PATTERNS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (!matches) continue;
    for (const m of matches) {
      if (extraCheck && !extraCheck(m)) continue;
      const key = name + ':' + m;
      if (seen.has(key)) continue;
      seen.add(key);

      // Sign by pattern + url so the same UUID showing up twice in a run
      // dedupes, but the same kind of leak on a different page is its own.
      const sig = makeSignature(['id_leak', name, after.url, m.slice(0, 40)]);
      out.push({
        type: 'id_leak',
        severity: 'medium',
        signature: sig,
        msg: `Raw ${name.replace('_', ' ')} visible in UI: ${m.slice(0, 60)}`,
        evidence: {
          pattern: name,
          match: m,
          url: after.url,
          step_action: step.action,
        },
      });
      if (out.length >= MAX_FINDINGS_PER_STEP) return out;
    }
  }

  return out;
}

module.exports = { detect, PATTERNS };
