/**
 * network_error — Captures HTTP responses with status >= 400 and outright failures
 * (DNS, connection refused, aborted, etc) that happened during a step.
 *
 * Dedupes by (status + url-path-shape) within a step so that a flapping endpoint
 * counts once. Severity:
 *   - 5xx, 0 (failure): high
 *   - 4xx: medium
 *   - 401/403/404 to non-API paths: low (often expected during auth flows)
 */
const NOISE_HOSTS = [
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)sentry\.io$/i,
];

const NOISE_PATHS = [
  /\/favicon\.ico$/i,
  /\/robots\.txt$/i,
];

function isNoise(u) {
  try {
    const url = new URL(u);
    if (NOISE_HOSTS.some(re => re.test(url.hostname))) return true;
    if (NOISE_PATHS.some(re => re.test(url.pathname))) return true;
  } catch {}
  return false;
}

/**
 * Reduce a URL to a stable "shape" so /api/users/123 and /api/users/456
 * sign as the same finding.
 */
function urlShape(u) {
  try {
    const url = new URL(u);
    const path = url.pathname
      .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:uuid')
      .replace(/\/\d{3,}/g, '/:id')
      .replace(/\/[a-f0-9]{16,}/gi, '/:hash');
    return url.host + path;
  } catch {
    return String(u).slice(0, 100);
  }
}

function severityFor(status) {
  if (status === 0 || status >= 500) return 'high';
  if (status >= 400) return 'medium';
  return 'low';
}

function detect({ step, events, makeSignature }) {
  const out = [];
  const seen = new Set();

  const items = [
    ...events.networkResponses.map(r => ({
      kind: 'http_error',
      url: r.url,
      status: r.status,
      method: r.method,
      resourceType: r.resourceType,
    })),
    ...events.networkFailures.map(f => ({
      kind: 'request_failed',
      url: f.url,
      status: 0,
      method: f.method,
      resourceType: f.resourceType,
      failure: f.failure,
    })),
  ];

  for (const it of items) {
    if (isNoise(it.url)) continue;
    const shape = urlShape(it.url);
    const dedupKey = it.status + ':' + shape;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const sig = makeSignature(['network_error', it.status, shape]);
    const statusLabel = it.status === 0 ? `failed (${it.failure || 'unknown'})` : String(it.status);

    out.push({
      type: 'network_error',
      severity: severityFor(it.status),
      signature: sig,
      msg: `${it.method} ${shape} → ${statusLabel}`,
      evidence: {
        kind: it.kind,
        url: it.url,
        url_shape: shape,
        status: it.status,
        method: it.method,
        resource_type: it.resourceType,
        failure: it.failure,
        step_action: step.action,
      },
    });
  }

  return out;
}

module.exports = { detect };
