import { api, apiStream } from '../core/state.js';
import { esc, fmtTime } from '../core/layout.js';

export async function renderFlows(slug) {
  let flows = [];
  try { ({ flows } = await api('/api/flows', {}, { project: slug })); }
  catch (e) { return `<div class="error-banner">${esc(e.message)}</div>`; }

  // Sub-flows / helpers (kind: helper) são reutilizáveis por outros flows via invoke_flow.
  // Separá-los visualmente para descoberta — o flow principal em si não roda standalone.
  const helpers = flows.filter(f => f.kind === 'helper' || f.kind === 'subflow');
  const main = flows.filter(f => !(f.kind === 'helper' || f.kind === 'subflow'));

  const flowRow = (f) => `
    <tr class="clickable" data-href="/p/${slug}/flows/${encodeURIComponent(f.id)}">
      <td><code>${esc(f.id)}</code></td>
      <td>${esc(f.name)}</td>
      <td class="muted">${esc(f.description || '')}</td>
      <td class="muted">${esc(f.updated_at)}</td>
    </tr>
  `;

  const helperRow = (f) => `
    <tr class="clickable" data-href="/p/${slug}/flows/${encodeURIComponent(f.id)}">
      <td><code>${esc(f.id)}</code> <span class="badge" style="background:#eef2ff;color:#4338ca">${esc(f.kind || 'helper')}</span></td>
      <td class="muted">${esc(f.description || '')}</td>
      <td>${(f.vars || []).map(v => `<code class="text-2" style="font-size:11px;margin-right:4px">${esc(v)}</code>`).join('')}</td>
    </tr>
  `;

  const helpersSection = helpers.length === 0 ? '' : `
    <div class="card">
      <h3>sub-flows / helpers <span class="text-3 fs-12">(${helpers.length}) — invoque via <code>action: invoke_flow</code></span></h3>
      <table class="table">
        <thead><tr><th style="width:280px">id</th><th>description</th><th style="width:40%">vars exportadas</th></tr></thead>
        <tbody>${helpers.map(helperRow).join('')}</tbody>
      </table>
    </div>
  `;

  const mainSection = main.length === 0 ? `
    <div class="empty">no flows yet. record one via the CLI: <code>pageflows session new</code> → ... → <code>pageflows save my-flow</code></div>
  ` : `
    <table class="table">
      <thead><tr><th>id</th><th>name</th><th>description</th><th>updated</th></tr></thead>
      <tbody>${main.map(flowRow).join('')}</tbody>
    </table>
  `;

  return `
    <div class="page-title">
      <h1>flows</h1>
      <div class="actions">
        <span class="text-2 fs-12">${flows.length} flow${flows.length !== 1 ? 's' : ''} in <code>${esc(slug)}</code>${helpers.length ? ` (${helpers.length} helper${helpers.length !== 1 ? 's' : ''})` : ''}</span>
      </div>
    </div>
    ${helpersSection}
    ${mainSection}
  `;
}

export async function renderFlowDetail(slug, id) {
  let flow, schedules = [];
  try {
    [flow, { schedules }] = await Promise.all([
      api('/api/flows/' + encodeURIComponent(id), {}, { project: slug }),
      api('/api/schedules', {}, { project: slug }).catch(() => ({ schedules: [] })),
    ]);
  } catch (e) { return `<div class="error-banner">${esc(e.message)}</div>`; }
  // Filter to schedules for this flow only.
  schedules = schedules.filter(s => s.flow_id === id);

  const j = flow.json || {};
  const vars = j.vars || [];
  const steps = j.steps || [];
  const assertions = j.assertions || [];

  const varRows = vars.map(v => `
    <tr>
      <td><code>${esc(v.name)}</code></td>
      <td><span class="badge">${esc(v.resolver)}</span></td>
      <td>${v.args ? `<code>${esc(JSON.stringify(v.args))}</code>` : ''}</td>
    </tr>
  `).join('');

  const stepRows = steps.map(s => `
    <tr>
      <td class="muted">${esc(s.n)}</td>
      <td><code>${esc(s.action)}</code>${s.when ? ` <span class="text-3 fs-12">when ${esc(s.when)}</span>` : ''}</td>
      <td><code class="text-2" style="font-size:11px">${esc(JSON.stringify(s.args || {})).slice(0, 200)}</code></td>
    </tr>
  `).join('');

  const assertRows = assertions.map(a =>
    `<li>${esc(a.type)} <code>${esc(a.fragment || a.text || '')}</code></li>`
  ).join('');

  const overrideInputs = vars.map(v => `
    <div class="field">
      <label>${esc(v.name)} <span class="text-3">${esc(v.resolver)}</span></label>
      <input data-var="${esc(v.name)}" placeholder="${esc((v.args && v.args.value !== undefined) ? '(default: ' + v.args.value + ')' : '(use resolver default)')}"/>
    </div>
  `).join('');

  setTimeout(() => { bindReplay(slug, id); bindSchedules(slug, id); }, 0);

  const schedulesHtml = `
    <div class="card">
      <div class="card-hd-row">
        <h3>schedules</h3>
        <button class="btn primary fs-12" id="add-schedule-btn" type="button">+ schedule</button>
      </div>
      <div id="schedules-list">
        ${schedules.length === 0 ? '<div class="text-3 fs-12">no schedules. add one to run this flow on a cron.</div>' : schedules.map(s => renderScheduleRow(s)).join('')}
      </div>
    </div>
  `;

  return `
    <div class="page-title">
      <h1>${esc(flow.name)}</h1>
      <div class="actions">
        <a class="btn" href="#/p/${esc(slug)}/flows">← back</a>
      </div>
    </div>
    <div class="text-2 mb-4">${esc(flow.description || '')} <code class="ml-2">${esc(flow.id)}</code></div>

    <div class="card">
      <h3>▶ replay</h3>
      <div class="text-2 fs-12 mb-2">override variables (leave blank to use resolver default):</div>
      <div id="override-fields">${overrideInputs || '<div class="text-3">(no vars)</div>'}</div>
      <button class="btn primary mt-4" id="replay-btn">▶ run flow</button>
    </div>

    <div id="run-output" style="display:none" class="card mt-4">
      <h3>live run</h3>
      <div id="run-events"></div>
    </div>

    ${schedulesHtml}

    ${vars.length ? `
    <div class="card">
      <h3>variables</h3>
      <table class="table">
        <thead><tr><th>name</th><th>resolver</th><th>args</th></tr></thead>
        <tbody>${varRows}</tbody>
      </table>
    </div>
    ` : ''}

    <div class="card">
      <h3>steps (${steps.length})</h3>
      <table class="table">
        <thead><tr><th style="width:48px">#</th><th style="width:160px">action</th><th>args</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </div>

    ${assertions.length ? `
    <div class="card">
      <h3>assertions</h3>
      <ul>${assertRows}</ul>
    </div>
    ` : ''}
  `;
}

function bindReplay(slug, id) {
  const btn = document.getElementById('replay-btn');
  if (!btn) return;
  btn.onclick = async () => {
    const fields = document.querySelectorAll('#override-fields [data-var]');
    const vars = {};
    for (const f of fields) {
      if (f.value.trim()) vars[f.dataset.var] = f.value.trim();
    }
    const out = document.getElementById('run-output');
    const evs = document.getElementById('run-events');
    out.style.display = 'block';
    evs.innerHTML = '<div class="run-event"><span class="spinner"></span>starting...</div>';
    btn.disabled = true; btn.textContent = '▶ running...';

    let runId = null;
    try {
      await apiStream(`/api/flows/${encodeURIComponent(id)}/replay?stream=true`, {
        method: 'POST', body: JSON.stringify({ vars }),
      }, (event, data) => {
        const line = renderEvent(event, data);
        if (line) {
          evs.insertAdjacentHTML('beforeend', line);
          evs.scrollTop = evs.scrollHeight;
        }
        if (event === 'run_start') runId = data.runId;
        if (event === 'done' && data.runUrl) {
          evs.insertAdjacentHTML('beforeend', `<div class="run-event"><a href="#/p/${slug}/runs/${data.runId}">→ open run detail</a></div>`);
        }
      });
    } catch (e) {
      evs.insertAdjacentHTML('beforeend', `<div class="run-event step-end-fail">✗ ${esc(e.message)}</div>`);
    } finally {
      btn.disabled = false; btn.textContent = '▶ run flow';
    }
  };
}

function renderEvent(event, d) {
  switch (event) {
    case 'run_start': return `<div class="run-event">▶ run ${esc(d.runId)} (${d.totalSteps} steps)</div>`;
    case 'var_resolving': return `<div class="run-event">  ⟳ ${esc(d.name)} via ${esc(d.resolver)}</div>`;
    case 'var_resolved': return `<div class="run-event var-resolved">  ✓ ${esc(d.name)} = ${esc(String(d.value).slice(0, 80))}</div>`;
    case 'var_failed': return `<div class="run-event step-end-fail">  ✗ ${esc(d.name)}: ${esc(d.error)}</div>`;
    case 'step_start': return `<div class="run-event">  → ${esc(d.n)}. ${esc(d.action)} ${esc(JSON.stringify(d.args).slice(0, 80))}</div>`;
    case 'step_end': return `<div class="run-event ${d.ok ? '' : 'step-end-fail'}">    ${d.ok ? '✓' : '✗'} ${d.durationMs}ms${d.error ? ' ' + esc(d.error) : ''}</div>`;
    case 'step_skipped': return `<div class="run-event text-3">    ⊘ skipped (when: ${esc(d.when)})</div>`;
    case 'invoke_flow_start': return `<div class="run-event invoke">▼ invoking ${esc(d.flow)}</div>`;
    case 'invoke_flow_end': return `<div class="run-event invoke">▲ ${esc(d.flow)} done (${d.durationMs}ms)</div>`;
    case 'assertion': return `<div class="run-event ${d.passed ? 'var-resolved' : 'step-end-fail'}">  ${d.passed ? '✓' : '✗'} assert ${esc(d.type)}</div>`;
    case 'run_end': return `<div class="run-event ${d.status === 'passed' ? 'var-resolved' : 'step-end-fail'}">◼ ${esc(d.status)}${d.error ? ' ' + esc(d.error) : ''}</div>`;
    case 'done': return '';
    case 'error': return `<div class="run-event step-end-fail">✗ ${esc(d.error)}</div>`;
    default: return '';
  }
}

// ----- schedules -----

function renderScheduleRow(s) {
  const enabled = !!s.enabled;
  const lastBadge = s.last_status
    ? `<span class="badge ${esc(s.last_status)}">${esc(s.last_status)}</span>`
    : '<span class="text-3 fs-12">never run</span>';
  const lastRunLink = s.last_run_id
    ? `<a class="text-3 fs-12" href="#/p/${state_slug()}/runs/${esc(s.last_run_id)}">last run</a>`
    : '';
  const nextStr = s.next_fire ? fmtTime(s.next_fire) + ' (BRT)' : '—';
  return `
    <div class="schedule-row" data-schedule-id="${esc(s.id)}">
      <div class="schedule-hd">
        <code class="schedule-cron">${esc(s.cron_expr)}</code>
        ${s.name ? `<span class="schedule-name">${esc(s.name)}</span>` : ''}
        <label class="schedule-toggle">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-action="toggle-schedule"/>
          <span>${enabled ? 'enabled' : 'disabled'}</span>
        </label>
        <button class="btn fs-12" data-action="delete-schedule" type="button">×</button>
      </div>
      <div class="schedule-meta">
        ${lastBadge} ${lastRunLink}
        <span class="text-3 fs-12">next: ${esc(nextStr)}</span>
        ${s.last_error ? `<span class="text-3 fs-12" title="${esc(s.last_error)}">⚠ last error</span>` : ''}
      </div>
    </div>
  `;
}

// Read the slug out of the current hash so the "last run" link doesn't need
// the schedule render to take it as a param.
function state_slug() {
  const m = (location.hash || '').match(/^#\/p\/([^\/]+)/);
  return m ? m[1] : '';
}

function bindSchedules(slug, flowId) {
  const addBtn = document.getElementById('add-schedule-btn');
  if (addBtn) addBtn.onclick = () => openScheduleModal(slug, flowId);

  document.querySelectorAll('[data-schedule-id]').forEach(row => {
    const id = row.dataset.scheduleId;
    const tog = row.querySelector('[data-action="toggle-schedule"]');
    const del = row.querySelector('[data-action="delete-schedule"]');
    if (tog) tog.onchange = async () => {
      try {
        await api(`/api/schedules/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: tog.checked }),
          project: slug,
        });
        const label = tog.parentElement.querySelector('span');
        if (label) label.textContent = tog.checked ? 'enabled' : 'disabled';
      } catch (e) {
        tog.checked = !tog.checked;
        alert('toggle failed: ' + e.message);
      }
    };
    if (del) del.onclick = async () => {
      if (!confirm(`delete this schedule?`)) return;
      try {
        await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE', project: slug });
        row.remove();
      } catch (e) { alert('delete failed: ' + e.message); }
    };
  });
}

function openScheduleModal(slug, flowId) {
  let bg = document.getElementById('modal-bg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'modal-bg';
    bg.className = 'modal-bg';
    document.body.appendChild(bg);
  }
  bg.innerHTML = `
    <div class="modal">
      <h3>schedule run</h3>
      <div class="text-2 fs-12 mb-2">cron expression (UTC). presets: <code>@hourly</code>, <code>@daily</code>, <code>@weekly</code>, or 5-field cron.</div>
      <input id="sched-cron" placeholder="0 9 * * 1-5 (9am Mon-Fri UTC)" value="@daily" style="width:100%"/>
      <div class="field mt-2">
        <label>name (optional)</label>
        <input id="sched-name" placeholder="e.g. nightly smoke"/>
      </div>
      <div class="actions mt-4">
        <button class="btn" type="button" id="sched-cancel">cancel</button>
        <button class="btn primary" type="button" id="sched-save">save</button>
      </div>
      <div id="sched-err" class="error-banner mt-2" style="display:none"></div>
    </div>
  `;
  bg.style.display = 'flex';
  bg.onclick = (e) => { if (e.target === bg) bg.style.display = 'none'; };
  document.getElementById('sched-cancel').onclick = () => { bg.style.display = 'none'; };
  document.getElementById('sched-save').onclick = async () => {
    const cron_expr = document.getElementById('sched-cron').value.trim();
    const name = document.getElementById('sched-name').value.trim();
    const errEl = document.getElementById('sched-err');
    errEl.style.display = 'none';
    if (!cron_expr) { errEl.textContent = 'cron required'; errEl.style.display = ''; return; }
    try {
      await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ flow_id: flowId, cron_expr, name }),
        project: slug,
      });
      bg.style.display = 'none';
      // Re-render the page so the new schedule shows up
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
    }
  };
}

