/**
 * dead_click — A click action returned ok, but the page did NOTHING:
 *   - URL didn't change
 *   - DOM text content (after stripping ephemeral state) is identical
 *   - No console errors fired during the step
 *   - No outbound network requests fired during the step
 *
 * Triggers after step.action ∈ { 'click', 'toggle' }. High severity.
 */
const TRIGGER_ACTIONS = new Set(['click', 'toggle']);

function detect({ step, args, before, after, events, makeSignature }) {
  if (!TRIGGER_ACTIONS.has(step.action)) return [];

  const urlChanged = before.url !== after.url;
  const domChanged = before.contentHash !== after.contentHash;
  const hadConsoleError = events.consoleErrors.length > 0;
  const hadNetwork = events.networkRequests.length > 0;

  if (urlChanged || domChanged || hadConsoleError || hadNetwork) return [];

  const target = args?.text || args?.label || args?.target || '<unknown>';
  const sig = makeSignature(['dead_click', step.action, String(target).slice(0, 60), before.url]);

  return [{
    type: 'dead_click',
    severity: 'high',
    signature: sig,
    msg: 'Click recognized but the page did nothing — no URL change, no DOM change, no console error, no network request.',
    evidence: {
      url_before: before.url,
      url_after: after.url,
      target: String(target).slice(0, 200),
      action: step.action,
    },
  }];
}

module.exports = { detect, TRIGGER_ACTIONS };
