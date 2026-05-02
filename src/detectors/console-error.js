/**
 * console_error — Anything that arrives via console.error or as a pageerror during a step.
 * One finding per unique error message (deduped within a step). Medium severity.
 */
const NOISY_PATTERNS = [
  /^favicon\.ico/i,
  /Failed to load resource: the server responded with a status of 404/i, // covered by network_error
];

function isNoise(msg) {
  return NOISY_PATTERNS.some(re => re.test(msg));
}

function detect({ step, events, makeSignature }) {
  const out = [];
  const seen = new Set();
  const errors = [
    ...events.consoleErrors.map(e => ({ kind: 'console.error', msg: e })),
    ...events.pageErrors.map(e => ({ kind: 'pageerror', msg: e })),
  ];
  for (const e of errors) {
    if (isNoise(e.msg)) continue;
    if (seen.has(e.msg)) continue;
    seen.add(e.msg);
    const sig = makeSignature(['console_error', e.msg.slice(0, 100)]);
    out.push({
      type: 'console_error',
      severity: 'medium',
      signature: sig,
      msg: `${e.kind}: ${e.msg.slice(0, 200)}`,
      evidence: {
        kind: e.kind,
        full_message: e.msg.slice(0, 1000),
        step_action: step.action,
      },
    });
  }
  return out;
}

module.exports = { detect };
