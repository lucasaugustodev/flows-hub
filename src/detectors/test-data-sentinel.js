/**
 * test_data_sentinel — Test/staging/placeholder data that leaked into a flow
 * that's supposed to behave like production.
 *
 * Catches the classic "we forgot to scrub the seed data before going live"
 * bug, plus dev-only sentinel strings that should never reach the user.
 *
 * Patterns checked (only when DOM content actually changed this step):
 *   - Lorem ipsum                  (any first ~30 chars of the standard string)
 *   - TODO / FIXME / XXX markers   (developer notes shown raw)
 *   - "@example.com" / "@test.com" (RFC 2606 reserved test domains)
 *   - "test test test", "asdf", "qwerty"   (placeholder typing)
 *   - Common placeholder names     ("John Doe", "Jane Doe", "Foo Bar")
 *   - All-9s identifier            ("999.999.999-99", "00000000000")
 *   - Common test card brands      ("4444 4444 4444 4444", "5555 5555 5555 4444")
 *
 * Medium severity. Each pattern signs independently so triage of "we ARE on
 * sandbox, this is fine" can suppress per-pattern.
 */
const PATTERNS = [
  { name: 'lorem_ipsum',         re: /\bLorem ipsum dolor sit amet\b/i },
  { name: 'todo_marker',         re: /\b(TODO|FIXME|XXX)(?::|\s+[A-Z])/ },
  { name: 'reserved_test_email', re: /[a-z0-9._%+-]+@(example\.(com|org|net)|test\.com|localhost)\b/i },
  { name: 'placeholder_text',    re: /\b(asdfasdf|qwerty(?:123)?|test test test|1234567890|aaaaaa)\b/i },
  { name: 'placeholder_name',    re: /\b(John Doe|Jane Doe|Foo Bar|Test User|Usuário Teste|Fulano de Tal)\b/i },
  { name: 'all_nines_cpf',       re: /\b999\.999\.999-99\b/ },
  { name: 'all_zeros_cpf',       re: /\b000\.000\.000-00\b/ },
  { name: 'test_credit_card',    re: /\b(?:4444[\s-]?){3}4444\b|\b5555[\s-]?5555[\s-]?5555[\s-]?4444\b|\b4242[\s-]?4242[\s-]?4242[\s-]?4242\b/ },
  { name: 'sandbox_marker',      re: /\b(SANDBOX|STAGING|DEV-ONLY|DO NOT USE IN PROD)\b/ },
];

const MAX_FINDINGS_PER_STEP = 5;

function detect({ step, before, after, makeSignature }) {
  const out = [];
  const seen = new Set();

  const contentChanged = before.contentHash !== after.contentHash;
  if (!contentChanged || !after.content) return out;

  const text = after.content;

  for (const { name, re } of PATTERNS) {
    const match = text.match(re);
    if (!match) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const sig = makeSignature(['test_data_sentinel', name, after.url]);
    out.push({
      type: 'test_data_sentinel',
      severity: 'medium',
      signature: sig,
      msg: `Test/placeholder data visible: ${name.replace(/_/g, ' ')} — "${match[0].slice(0, 60)}"`,
      evidence: {
        pattern: name,
        match: match[0],
        url: after.url,
        step_action: step.action,
      },
    });
    if (out.length >= MAX_FINDINGS_PER_STEP) return out;
  }

  return out;
}

module.exports = { detect, PATTERNS };
