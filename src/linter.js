/**
 * Linter — observation layer that runs alongside the replay engine to detect anomalies.
 *
 * Lifecycle per step:
 *   const ctx = await linter.beforeStep(session, step);  // snapshots URL/DOM, attaches listeners
 *   await handler(session, args);                         // existing replay logic
 *   const findings = await linter.afterStep(session, step, args, result, ctx);
 *
 * Each detector is a pure function that examines (before, after, events, step, args)
 * and returns an array of findings. Findings ride along inside the run's result_json.
 *
 * Cross-run state (triage, suppressions) lives in finding_triage and is merged when the
 * API returns a run — see src/server.js GET /api/runs/:id.
 */
const crypto = require('crypto');

const DETECTORS = [
  require('./detectors/dead-click'),
  require('./detectors/console-error'),
  require('./detectors/network-error'),
  require('./detectors/untranslated-string'),
  require('./detectors/id-leak'),
  require('./detectors/test-data-sentinel'),
];

const FINDING_ID_BYTES = 4;

function newFindingId() {
  return 'f_' + crypto.randomBytes(FINDING_ID_BYTES).toString('hex');
}

function makeSignature(parts) {
  const str = parts.map(p => String(p == null ? '' : p)).join(':');
  return 'sig_' + crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
}

/**
 * Take a stable hash of the visible page state. We intentionally use innerText + URL
 * (NOT outerHTML) so that ephemeral attribute changes (data-state=open, animation classes,
 * focus outlines) don't trip the dead_click detector.
 */
// Cap retained text per snapshot so a giant SPA doesn't blow up memory in
// long runs. 32KB is plenty for human-visible text on a single page.
const MAX_CONTENT_BYTES = 32 * 1024;

async function snapshotPage(page) {
  try {
    const data = await page.evaluate(() => ({
      url: location.href,
      // body.innerText already collapses whitespace and ignores hidden elements
      content: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
    }));
    const contentHash = crypto.createHash('sha1').update(data.content).digest('hex').slice(0, 16);
    const content = data.content.slice(0, MAX_CONTENT_BYTES);
    return { url: data.url, contentHash, content };
  } catch {
    return { url: '', contentHash: '', content: '' };
  }
}

/**
 * Install per-step listeners. Returns the ctx (and an `events` accumulator that detectors
 * read after the step finishes).
 */
async function beforeStep(session, step) {
  const before = await snapshotPage(session.page);
  const events = {
    consoleErrors: [],
    pageErrors: [],
    networkRequests: [],
    networkResponses: [],
    networkFailures: [],
  };

  const onConsole = (msg) => {
    try {
      if (msg.type() === 'error') events.consoleErrors.push(msg.text().slice(0, 1000));
    } catch {}
  };
  const onPageError = (err) => {
    try { events.pageErrors.push((err.message || String(err)).slice(0, 1000)); } catch {}
  };
  const onRequest = (req) => {
    try {
      const u = req.url();
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      events.networkRequests.push({
        url: u.slice(0, 300),
        method: req.method(),
        resourceType: req.resourceType(),
      });
    } catch {}
  };
  const onResponse = (resp) => {
    try {
      const u = resp.url();
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      const status = resp.status();
      if (status < 400) return; // only keep error responses
      events.networkResponses.push({
        url: u.slice(0, 300),
        status,
        method: resp.request()?.method?.() || 'GET',
        resourceType: resp.request()?.resourceType?.() || 'other',
      });
    } catch {}
  };
  const onRequestFailed = (req) => {
    try {
      const u = req.url();
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      events.networkFailures.push({
        url: u.slice(0, 300),
        method: req.method(),
        resourceType: req.resourceType(),
        failure: req.failure?.()?.errorText || 'unknown',
      });
    } catch {}
  };

  session.page.on('console', onConsole);
  session.page.on('pageerror', onPageError);
  session.page.on('request', onRequest);
  session.page.on('response', onResponse);
  session.page.on('requestfailed', onRequestFailed);

  return {
    before,
    events,
    listeners: { onConsole, onPageError, onRequest, onResponse, onRequestFailed },
  };
}

/**
 * Run all detectors, return the array of findings (possibly empty).
 * Always uninstalls the listeners.
 */
async function afterStep(session, step, args, result, ctx) {
  if (!ctx) return [];
  const after = await snapshotPage(session.page);
  // Filter network requests to "interesting" ones (skip same-document/static fetches when possible)
  // For now we keep them all; detectors can filter further.

  // Uninstall listeners
  try {
    session.page.off('console', ctx.listeners.onConsole);
    session.page.off('pageerror', ctx.listeners.onPageError);
    session.page.off('request', ctx.listeners.onRequest);
    session.page.off('response', ctx.listeners.onResponse);
    session.page.off('requestfailed', ctx.listeners.onRequestFailed);
  } catch {}

  const findings = [];
  const detectorCtx = {
    step, args, result,
    before: ctx.before,
    after,
    events: ctx.events,
    makeSignature,
  };
  for (const det of DETECTORS) {
    try {
      const out = det.detect(detectorCtx);
      if (Array.isArray(out)) {
        for (const f of out) findings.push({ id: newFindingId(), detected_at: Date.now(), ...f });
      }
    } catch (e) {
      // A buggy detector shouldn't crash the run
      // eslint-disable-next-line no-console
      console.warn('[linter] detector failed:', det.detect?.name || det, e.message);
    }
  }
  return findings;
}

module.exports = { beforeStep, afterStep, makeSignature, DETECTORS };
