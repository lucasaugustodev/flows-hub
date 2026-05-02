import { api } from '../core/state.js';
import { esc, fmtTime } from '../core/layout.js';

/**
 * Cross-project health dashboard. One row per project the user belongs to,
 * showing pass-rate over the last 7d (configurable), open findings, schedules
 * and rules counts, and the most recent failure. Click a row to drill into the
 * project's runs.
 */
export async function renderDashboard() {
  const days = parseInt(new URLSearchParams(location.hash.split('?')[1] || '').get('days') || '7', 10);
  let data;
  try { data = await api(`/api/dashboard?days=${days}`, {}, { project: false }); }
  catch (e) { return `<div class="error-banner">${esc(e.message)}</div>`; }

  const projects = data.projects || [];
  if (projects.length === 0) {
    return `<div class="page-title"><h1>health</h1></div>
            <div class="empty">no projects yet — <a href="#/projects">create one</a> to see metrics.</div>`;
  }

  // Sort projects: most-broken first (fail rate, then open findings).
  projects.sort((a, b) => {
    const fa = a.metrics.failed; const fb = b.metrics.failed;
    if (fa !== fb) return fb - fa;
    return b.metrics.open_findings - a.metrics.open_findings;
  });

  const rows = projects.map(p => {
    const m = p.metrics;
    const pr = m.pass_rate;
    const passClass = pr == null ? 'unknown' : pr === 100 ? 'good' : pr >= 80 ? 'warn' : 'bad';
    const passLabel = pr == null ? '—' : pr + '%';

    const findingsClass = m.open_high > 0 ? 'bad' : m.open_findings > 0 ? 'warn' : 'good';
    const findingsLabel = m.open_findings === 0
      ? '0'
      : m.open_high > 0
        ? `${m.open_findings} <span class="health-sub">(${m.open_high} high)</span>`
        : String(m.open_findings);

    const failureCell = m.last_failure ? `
      <a href="#/p/${esc(p.project.slug)}/runs/${esc(m.last_failure.run_id)}"
         class="health-failure" title="${esc(m.last_failure.error || '')}">
        ${esc(m.last_failure.flow_name || m.last_failure.flow_id)}
        <span class="health-sub">${esc(fmtTime(m.last_failure.started_at))}</span>
      </a>` : '<span class="text-3 fs-12">—</span>';

    return `
      <tr class="health-row clickable" data-href="/p/${esc(p.project.slug)}/runs">
        <td>
          <div class="health-name">
            <b>${esc(p.project.name)}</b>
            <span class="badge role-${esc(p.project.role)}">${esc(p.project.role)}</span>
          </div>
          <div class="text-3 fs-12">${esc(p.project.slug)}</div>
        </td>
        <td><span class="health-pill ${passClass}">${passLabel}</span></td>
        <td class="text-2">${m.runs} <span class="health-sub">(${m.passed}✓ ${m.failed}✗)</span></td>
        <td><span class="health-pill ${findingsClass}">${findingsLabel}</span></td>
        <td class="text-2 fs-12">${m.flows} flows · ${m.schedules} sched · ${m.rules} rules</td>
        <td>${failureCell}</td>
      </tr>
    `;
  }).join('');

  // Aggregate row across all projects so the user has a single number to glance at.
  const totals = projects.reduce((a, p) => ({
    runs: a.runs + p.metrics.runs,
    passed: a.passed + p.metrics.passed,
    failed: a.failed + p.metrics.failed,
    open: a.open + p.metrics.open_findings,
    high: a.high + p.metrics.open_high,
  }), { runs: 0, passed: 0, failed: 0, open: 0, high: 0 });
  const aggPass = totals.runs > 0 ? Math.round((totals.passed / totals.runs) * 100) : null;

  return `
    <div class="page-title">
      <h1>health</h1>
      <div class="actions">
        <select id="health-days" class="health-days">
          <option value="1"  ${days===1?'selected':''}>last 24h</option>
          <option value="7"  ${days===7?'selected':''}>last 7d</option>
          <option value="14" ${days===14?'selected':''}>last 14d</option>
          <option value="30" ${days===30?'selected':''}>last 30d</option>
        </select>
      </div>
    </div>

    <div class="health-summary">
      <div class="health-summary-card">
        <div class="health-summary-label">overall pass-rate (${days}d)</div>
        <div class="health-summary-value ${aggPass==null?'unknown':aggPass===100?'good':aggPass>=80?'warn':'bad'}">${aggPass==null?'—':aggPass+'%'}</div>
        <div class="health-summary-sub">${totals.runs} runs · ${totals.passed}✓ ${totals.failed}✗</div>
      </div>
      <div class="health-summary-card">
        <div class="health-summary-label">open findings</div>
        <div class="health-summary-value ${totals.high>0?'bad':totals.open>0?'warn':'good'}">${totals.open}</div>
        <div class="health-summary-sub">${totals.high} high · across ${projects.length} project${projects.length===1?'':'s'}</div>
      </div>
    </div>

    <table class="table health-table">
      <thead>
        <tr>
          <th>project</th>
          <th>pass</th>
          <th>runs (${days}d)</th>
          <th>open findings</th>
          <th>config</th>
          <th>last failure</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Wire the days selector on the toolbar
export function bindDashboard() {
  const sel = document.getElementById('health-days');
  if (sel) sel.onchange = () => {
    const days = sel.value;
    location.hash = '#/dashboard?days=' + days;
  };
}
