import { api, state } from '../core/state.js';
import { esc, fmtTime } from '../core/layout.js';

const SEV_WEIGHT = { high: 3, medium: 2, low: 1 };

// Pick the highest-severity finding on a step so we know which colored stripe
// to put on the step card.
function topSeverity(findings) {
  let best = null, w = 0;
  for (const f of findings || []) {
    const fw = SEV_WEIGHT[f.severity] || 0;
    if (fw > w) { w = fw; best = f.severity; }
  }
  return best;
}

export async function renderRuns(slug) {
  let runs = [];
  try { ({ runs } = await api('/api/runs', {}, { project: slug })); }
  catch (e) { return `<div class="error-banner">${esc(e.message)}</div>`; }

  const rows = runs.map(r => {
    const dur = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's' : '...';
    const fromSchedule = (r.triggered_by || '').startsWith('schedule:');
    return `
      <tr class="clickable" data-href="/p/${slug}/runs/${encodeURIComponent(r.id)}">
        <td><code>${esc(r.id.slice(0, 14))}</code></td>
        <td>${esc(r.flow_name || r.flow_id)} ${fromSchedule ? '<span title="triggered by schedule" class="text-3 fs-12">🕐</span>' : ''}</td>
        <td><span class="badge ${r.status}">${esc(r.status)}</span></td>
        <td class="muted" title="${esc(r.started_at)} UTC">${esc(fmtTime(r.started_at))}</td>
        <td class="muted">${dur}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="page-title"><h1>runs</h1></div>
    ${runs.length === 0 ? `<div class="empty">no runs yet — replay a flow to see history.</div>` : `
      <table class="table">
        <thead><tr><th>id</th><th>flow</th><th>status</th><th>started</th><th>duration</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `}
  `;
}

const TRIAGE_OPTIONS = [
  { status: 'bug',           label: 'bug',           hint: 'Confirmed defect — needs to be fixed' },
  { status: 'investigating', label: 'investigating', hint: 'Looking into it' },
  { status: 'not_a_bug',     label: 'not a bug',     hint: 'Expected behavior — requires a reason' },
  { status: 'accepted_risk', label: 'accept risk',   hint: 'Known issue, accepted as-is' },
];
const EDITOR_ROLES = new Set(['owner', 'admin', 'editor']);

export async function renderRunDetail(slug, id) {
  // Fetch run + project name in parallel so the breadcrumb shows the friendly
  // project name instead of the slug. Role from /projects/:slug determines
  // whether we render the triage buttons (viewers get read-only).
  let run, projectName = slug, role = 'viewer';
  try {
    const [runResp, projResp] = await Promise.all([
      api('/api/runs/' + encodeURIComponent(id), {}, { project: slug }),
      api('/projects/' + encodeURIComponent(slug), { project: false }).catch(() => null),
    ]);
    run = runResp;
    if (projResp?.project?.name) projectName = projResp.project.name;
    if (projResp?.project?.role) role = projResp.project.role;
  } catch (e) {
    return `<div class="error-banner">${esc(e.message)}</div>`;
  }
  const canTriage = EDITOR_ROLES.has(role);

  const result = run.result || {};
  const vars = run.vars || {};
  const steps = result.steps || [];
  const assertions = result.assertions || [];
  const dur = run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) + 's' : '—';

  // Fetch http_calls + audit_entries para mostrar inline embaixo de cada step
  let httpCallsByStep = {};
  let auditEntriesByStep = {};
  try {
    const [hc, ae] = await Promise.all([
      api('/api/runs/' + encodeURIComponent(id) + '/http-calls', {}, { project: slug }).catch(() => ({ calls: [] })),
      api('/api/runs/' + encodeURIComponent(id) + '/audit-entries', {}, { project: slug }).catch(() => ({ entries: [] })),
    ]);
    for (const c of (hc.calls || [])) {
      const k = String(c.step_n);
      (httpCallsByStep[k] = httpCallsByStep[k] || []).push(c);
    }
    // audit entries são correlacionadas pelo trace_id ":<step_n>" — extrair step_n do trace_id
    for (const e of (ae.entries || [])) {
      const m = (e.trace_id || '').match(/:(\d+)$/);
      const k = m ? m[1] : String(e.step_n);
      (auditEntriesByStep[k] = auditEntriesByStep[k] || []).push(e);
    }
  } catch {}

  // Aggregate findings across all steps for the summary pills.
  const allFindings = [];
  for (const s of steps) for (const f of (s.findings || [])) allFindings.push({ ...f, step_n: s.n });
  const sevCount = { high: 0, medium: 0, low: 0 };
  const typeCount = {};
  for (const f of allFindings) {
    sevCount[f.severity] = (sevCount[f.severity] || 0) + 1;
    typeCount[f.type] = (typeCount[f.type] || 0) + 1;
  }

  const findingsSummary = allFindings.length === 0 ? '' : `
    <div class="findings-summary" data-findings-summary>
      <span class="findings-summary-label">findings:</span>
      <button class="finding-pill active" data-filter-sev="all" data-filter-type="all">
        all <span class="pill-count">${allFindings.length}</span>
      </button>
      ${sevCount.high   ? `<button class="finding-pill sev-high"   data-filter-sev="high"   data-filter-type="all">high <span class="pill-count">${sevCount.high}</span></button>`     : ''}
      ${sevCount.medium ? `<button class="finding-pill sev-medium" data-filter-sev="medium" data-filter-type="all">medium <span class="pill-count">${sevCount.medium}</span></button>` : ''}
      ${sevCount.low    ? `<button class="finding-pill sev-low"    data-filter-sev="low"    data-filter-type="all">low <span class="pill-count">${sevCount.low}</span></button>`        : ''}
      <span class="pill-divider"></span>
      ${Object.entries(typeCount).map(([t, c]) => `
        <button class="finding-pill type-pill" data-filter-sev="all" data-filter-type="${esc(t)}">
          ${esc(t)} <span class="pill-count">${c}</span>
        </button>
      `).join('')}
    </div>
  `;

  const stepHtml = steps.map(s => {
    const findings = s.findings || [];
    const topSev = topSeverity(findings);
    const sevClass = topSev ? `severity-${topSev}` : '';
    const shot = s.screenshot ? `<img src="/data/${esc(s.screenshot)}" loading="lazy"/>` : '';
    const okIcon = s.ok ? (s.skipped ? '⊘' : '✓') : '✗';
    const err = s.error ? `<div class="error-banner mt-4">${esc(s.error).split('\n').slice(0, 5).join('<br/>')}</div>` : '';
    const meta = s.var ? `<div class="step-meta">${esc(s.var)} = <code>${esc(String(s.value || ''))}</code></div>` : '';

    // Encode finding metadata on the step element so the filter handler can
    // hide/show without re-rendering.
    const sevs = [...new Set(findings.map(f => f.severity))].join(' ');
    const types = [...new Set(findings.map(f => f.type))].join(' ');

    const findingsHtml = findings.length === 0 ? '' : `
      <div class="step-findings">
        ${findings.map(f => {
          const triageStatus = f.triage?.status || '';
          const triageBadge = f.triage
            ? `<span class="badge triage-${esc(triageStatus)}" data-triage-badge title="${esc(f.triage.reason || '')}">${esc(triageStatus.replace(/_/g, ' '))}</span>`
            : `<span class="badge triage-untriaged" data-triage-badge style="display:none"></span>`;
          const llmBadge = f.llm
            ? `<span class="badge llm-${esc(f.llm.verdict)}" title="🤖 ${esc(f.llm.model || 'llm')}: ${esc(f.llm.reason || '')}">🤖 ${esc(f.llm.verdict)}</span>`
            : '';
          // Show the notes toggle when there are existing notes OR when the
          // viewer can post (so they can start a thread on a fresh finding).
          const notesCount = f.notes_count || 0;
          const notesToggle = (notesCount > 0 || canTriage)
            ? `<button class="notes-toggle" data-action="toggle-notes" data-loaded="0" type="button">💬 <span data-notes-count>${notesCount}</span> ${notesCount === 1 ? 'note' : 'notes'}</button>`
            : '';

          const triageActions = canTriage ? `
            <div class="triage-actions" data-triage-actions>
              ${TRIAGE_OPTIONS.map(opt => `
                <button class="triage-btn ${opt.status === triageStatus ? 'active' : ''}"
                        data-action="triage"
                        data-status="${opt.status}"
                        title="${esc(opt.hint)}">${esc(opt.label)}</button>
              `).join('')}
            </div>
          ` : '';

          return `
            <div class="finding-card sev-${esc(f.severity)} ${f.triage ? `triaged-${esc(triageStatus)}` : ''}"
                 data-finding-card
                 data-sig="${esc(f.signature)}"
                 data-run-id="${esc(id)}">
              <div class="finding-card-hd">
                <span class="finding-sev sev-${esc(f.severity)}">${esc(f.severity)}</span>
                <span class="finding-type">${esc(f.type)}</span>
                ${triageBadge}
                ${llmBadge}
                ${notesToggle}
                <code class="finding-sig">${esc(f.signature)}</code>
              </div>
              <div class="finding-msg">${esc(f.msg)}</div>
              ${f.evidence ? `<details class="finding-ev"><summary>evidence</summary><pre>${esc(JSON.stringify(f.evidence, null, 2))}</pre></details>` : ''}
              ${triageActions}
              <div class="notes-thread" data-notes-thread style="display:none"></div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Inline render http_calls + audit_entries deste step
    const stepKey = String(s.n);
    const httpCalls = httpCallsByStep[stepKey] || [];
    const auditEntries = auditEntriesByStep[stepKey] || [];

    const httpHtml = httpCalls.map(c => {
      const statusClass = c.response_status >= 200 && c.response_status < 300 ? 'ok'
        : c.response_status >= 400 ? 'fail' : 'warn';
      return `
        <div class="step-http-call">
          <span class="badge http-method">${esc(c.method)}</span>
          <code class="http-url">${esc(c.url)}</code>
          <span class="badge status-${statusClass}">${esc(c.response_status ?? '—')}</span>
          <span class="text-3">${esc(c.latency_ms)}ms</span>
          ${c.error ? `<span class="text-3" style="color:var(--err)">${esc(c.error)}</span>` : ''}
        </div>
      `;
    }).join('');

    const auditHtml = auditEntries.map(e => {
      const statusClass = e.status === 'success' ? 'ok' : 'fail';
      return `
        <div class="step-audit-entry">
          <span class="step-audit-label">↳ backend audit</span>
          <code class="audit-action">${esc(e.action)}</code>
          <span class="badge status-${statusClass}">${esc(e.http_status)}</span>
          <span class="badge ${esc(e.status)}">${esc(e.status)}</span>
          <span class="text-3">${esc(e.latency_ms)}ms</span>
          ${e.user_id ? `<span class="text-3">user <code>${esc(e.user_id.slice(0, 8))}</code></span>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="step-card ${!s.ok ? 'fail' : ''} ${sevClass}"
           data-step-sevs="${esc(sevs)}"
           data-step-types="${esc(types)}"
           data-has-findings="${findings.length > 0 ? '1' : '0'}">
        <div class="step-card-hd">
          <b>${okIcon} ${esc(s.n)}. ${esc(s.action)}</b>
          <span class="text-3">${esc(s.durationMs)}ms</span>
        </div>
        ${meta}
        ${err}
        ${httpHtml}
        ${auditHtml}
        ${findingsHtml}
        ${shot}
      </div>
    `;
  }).join('');

  const assertionHtml = assertions.map(a => `
    <div class="run-event ${a.passed ? 'var-resolved' : 'step-end-fail'}">
      ${a.passed ? '✓' : '✗'} ${esc(a.type)}
      ${a.fragment ? '<code>' + esc(a.fragment) + '</code>' : ''}
      ${a.text ? '<code>' + esc(a.text) + '</code>' : ''}
      ${a.flow ? '<span class="text-3">[' + esc(a.flow) + ']</span>' : ''}
    </div>
  `).join('');

  // Redact secrets
  const redacted = Object.fromEntries(Object.entries(vars).map(([k, v]) =>
    [k, /password|secret|token/i.test(k) ? '<redacted>' : v]));

  // Bind the filter + triage + notes + LLM-lint + run-detail tabs handlers after HTML lands.
  setTimeout(() => {
    bindFindingsFilter();
    if (canTriage) bindFindingsTriage(slug, id);
    bindFindingsNotes(slug, id, canTriage);
    if (canTriage) bindLLMLint(slug, id);
    bindRunDetailTabs(slug, id);
  }, 0);

  return `
    <nav class="breadcrumb">
      <a href="#/projects">${esc(projectName)}</a>
      <span class="bc-sep">›</span>
      <a href="#/p/${esc(slug)}/flows/${encodeURIComponent(run.flow_id)}">${esc(run.flow_name || run.flow_id)}</a>
      <span class="bc-sep">›</span>
      <span>run <code>${esc(id.slice(0, 12))}</code></span>
    </nav>

    <div class="page-title">
      <h1>run <code>${esc(id.slice(0, 14))}</code></h1>
      <div class="actions">
        <a class="btn" href="#/p/${esc(slug)}/runs">← back</a>
        <a class="btn" target="_blank" href="/runs/${esc(id)}">↗ public viewer</a>
        ${canTriage && allFindings.length > 0 ? `<button class="btn" id="llm-lint-btn" type="button" title="Re-run LLM verdicts using current project context">🤖 lint with AI</button>` : ''}
      </div>
    </div>
    <div class="text-2 mb-4">
      <span class="badge ${esc(run.status)}">${esc(run.status)}</span>
      &middot; flow <code>${esc(run.flow_id)}</code>
      &middot; <span title="${esc(run.started_at)} UTC">${esc(fmtTime(run.started_at))}</span>
      ${run.finished_at ? ` → <span title="${esc(run.finished_at)} UTC">${esc(fmtTime(run.finished_at))}</span>` : ''}
      &middot; ${dur}
    </div>
    ${run.error ? `<div class="error-banner">${esc(run.error)}</div>` : ''}

    ${findingsSummary}

    ${Object.keys(redacted).length ? `
      <div class="card">
        <h3>vars</h3>
        <pre>${esc(JSON.stringify(redacted, null, 2))}</pre>
      </div>
    ` : ''}

    ${assertions.length ? `
      <div class="card">
        <h3>assertions</h3>
        ${assertionHtml}
      </div>
    ` : ''}

    <div class="card" data-steps-card>
      <h3>steps (${steps.length})</h3>
      ${stepHtml}
    </div>

    <div class="card" data-run-detail-tabs>
      <div class="run-tabs">
        <button class="tab-btn active" data-tab="api-calls">API Calls</button>
        <button class="tab-btn" data-tab="audit-log">Audit Log</button>
      </div>

      <div class="tab-panel" data-panel="api-calls">
        <table class="table" id="apiCallsTable">
          <thead>
            <tr>
              <th>Step</th>
              <th>Method</th>
              <th>URL</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Trace ID</th>
            </tr>
          </thead>
          <tbody><tr><td colspan="6" class="muted" style="text-align:center;padding:16px;">click to load…</td></tr></tbody>
        </table>
      </div>

      <div class="tab-panel" data-panel="audit-log" style="display:none">
        <table class="table" id="auditLogTable">
          <thead>
            <tr>
              <th>Step</th>
              <th>Action</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Latency</th>
              <th>User</th>
              <th>Trace ID</th>
            </tr>
          </thead>
          <tbody><tr><td colspan="7" class="muted" style="text-align:center;padding:16px;">click to load…</td></tr></tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Wire the findings-summary pills so clicking one filters which step cards are
 * visible. Filter is in-memory; clicking "all" or the active pill clears it.
 */
function bindFindingsFilter() {
  const summary = document.querySelector('[data-findings-summary]');
  if (!summary) return;
  const pills = summary.querySelectorAll('.finding-pill');
  const cards = document.querySelectorAll('.step-card');

  function applyFilter(sev, type) {
    for (const c of cards) {
      const hasFindings = c.dataset.hasFindings === '1';
      const sevs = (c.dataset.stepSevs || '').split(/\s+/).filter(Boolean);
      const types = (c.dataset.stepTypes || '').split(/\s+/).filter(Boolean);
      const sevOk = sev === 'all' || sevs.includes(sev);
      const typeOk = type === 'all' || types.includes(type);
      const showAll = sev === 'all' && type === 'all';
      // When a non-"all" filter is active, hide steps without any findings.
      const visible = showAll || (hasFindings && sevOk && typeOk);
      c.style.display = visible ? '' : 'none';
    }
  }

  for (const p of pills) {
    p.addEventListener('click', () => {
      for (const o of pills) o.classList.remove('active');
      p.classList.add('active');
      applyFilter(p.dataset.filterSev, p.dataset.filterType);
    });
  }
}

/**
 * Wire the inline triage buttons. Clicking the active button clears the triage
 * (DELETE); clicking a different one upserts (POST). 'not_a_bug' prompts for a
 * required reason. Updates the finding card optimistically — badge, dimming,
 * and active button state — without re-fetching the whole run.
 */
function bindFindingsTriage(slug, runId) {
  const cards = document.querySelectorAll('[data-finding-card]');
  for (const card of cards) {
    const buttons = card.querySelectorAll('[data-action="triage"]');
    for (const btn of buttons) {
      btn.addEventListener('click', () => triageClicked(card, btn, slug, runId));
    }
  }
}

async function triageClicked(card, btn, slug, runId) {
  const sig = card.dataset.sig;
  const status = btn.dataset.status;
  const wasActive = btn.classList.contains('active');
  const buttons = card.querySelectorAll('[data-action="triage"]');
  const badge = card.querySelector('[data-triage-badge]');

  // Disable all triage buttons in this card while the request flies.
  for (const b of buttons) b.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = '…';

  try {
    if (wasActive) {
      // Clear current triage
      await api(`/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/triage`,
        { method: 'DELETE', project: slug });
      // Optimistic UI update
      for (const b of buttons) b.classList.remove('active');
      hideTriageBadge(badge);
      card.classList.remove('triaged-bug', 'triaged-investigating', 'triaged-not_a_bug', 'triaged-accepted_risk');
    } else {
      let reason = null;
      if (status === 'not_a_bug') {
        reason = window.prompt('Reason for marking as "not a bug":');
        if (!reason || !reason.trim()) {
          // User cancelled — bail without changing anything
          for (const b of buttons) b.disabled = false;
          btn.textContent = prevText;
          return;
        }
        reason = reason.trim();
      }
      await api(`/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/triage`,
        { method: 'POST', body: JSON.stringify({ status, reason }), project: slug });
      // Optimistic UI update
      for (const b of buttons) b.classList.remove('active');
      btn.classList.add('active');
      showTriageBadge(badge, status, reason);
      // Refresh dimming class
      card.classList.remove('triaged-bug', 'triaged-investigating', 'triaged-not_a_bug', 'triaged-accepted_risk');
      card.classList.add(`triaged-${status}`);
    }
  } catch (e) {
    alert('Triage failed: ' + (e.message || e));
  } finally {
    for (const b of buttons) b.disabled = false;
    btn.textContent = prevText;
  }
}

function showTriageBadge(badge, status, reason) {
  if (!badge) return;
  badge.style.display = '';
  badge.className = 'badge triage-' + status;
  badge.textContent = status.replace(/_/g, ' ');
  if (reason) badge.title = reason;
}

function hideTriageBadge(badge) {
  if (!badge) return;
  badge.style.display = 'none';
  badge.className = 'badge triage-untriaged';
  badge.textContent = '';
  badge.title = '';
}

/**
 * Wire the "💬 N notes" toggle on each finding-card. First click fetches the
 * thread; subsequent clicks just hide/show. The thread itself contains a list
 * of notes (with author-only delete) plus a post form when canPost.
 */
function bindFindingsNotes(slug, runId, canPost) {
  const cards = document.querySelectorAll('[data-finding-card]');
  for (const card of cards) {
    const btn = card.querySelector('[data-action="toggle-notes"]');
    if (!btn) continue;
    btn.addEventListener('click', () => toggleNotes(card, btn, slug, runId, canPost));
  }
}

async function toggleNotes(card, btn, slug, runId, canPost) {
  const thread = card.querySelector('[data-notes-thread]');
  if (!thread) return;
  if (thread.style.display !== 'none') {
    thread.style.display = 'none';
    return;
  }
  thread.style.display = '';
  if (btn.dataset.loaded === '1') return;
  thread.innerHTML = '<div class="notes-loading">loading…</div>';
  try {
    const sig = card.dataset.sig;
    const { notes } = await api(
      `/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/notes`,
      { project: slug }
    );
    renderNotesThread(thread, notes, runId, sig, slug, canPost);
    btn.dataset.loaded = '1';
  } catch (e) {
    thread.innerHTML = `<div class="error-banner">${esc(e.message)}</div>`;
  }
}

function renderNotesThread(thread, notes, runId, sig, slug, canPost) {
  const myId = state.user?.id;
  const list = notes.length === 0
    ? '<div class="notes-empty">no notes yet.</div>'
    : notes.map(n => `
        <div class="note-item" data-note-id="${esc(n.id)}">
          <div class="note-hd">
            <span class="note-author">${esc(n.author_name || n.author_email || 'unknown')}</span>
            <span class="note-time">${esc(n.created_at || '')}</span>
            ${n.author_id === myId ? `<button class="note-del" data-action="delete-note" type="button" title="delete">×</button>` : ''}
          </div>
          <div class="note-body">${esc(n.body)}</div>
        </div>
      `).join('');

  thread.innerHTML = `
    <div class="notes-list">${list}</div>
    ${canPost ? `
      <div class="notes-form">
        <textarea data-note-input rows="2" placeholder="add a note…" maxlength="2000"></textarea>
        <button class="btn primary" data-action="post-note" type="button">post</button>
      </div>
    ` : ''}
  `;

  // wire delete + post handlers
  for (const del of thread.querySelectorAll('[data-action="delete-note"]')) {
    del.addEventListener('click', () => deleteNote(thread, del, runId, sig, slug));
  }
  const post = thread.querySelector('[data-action="post-note"]');
  if (post) post.addEventListener('click', () => postNote(thread, runId, sig, slug));
}

async function postNote(thread, runId, sig, slug) {
  const ta = thread.querySelector('[data-note-input]');
  const btn = thread.querySelector('[data-action="post-note"]');
  if (!ta || !btn) return;
  const body = (ta.value || '').trim();
  if (!body) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    await api(
      `/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/notes`,
      { method: 'POST', body: JSON.stringify({ body }), project: slug }
    );
    ta.value = '';
    // Refetch to keep the list authoritative (server-assigned id, timestamp).
    const { notes } = await api(
      `/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/notes`,
      { project: slug }
    );
    renderNotesThread(thread, notes, runId, sig, slug, true);
    bumpNotesCount(thread, +1);
  } catch (e) {
    alert('failed to post note: ' + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = 'post';
  }
}

async function deleteNote(thread, btn, runId, sig, slug) {
  const item = btn.closest('[data-note-id]');
  const noteId = item?.dataset?.noteId;
  if (!noteId) return;
  btn.disabled = true;
  try {
    await api(
      `/api/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(sig)}/notes/${encodeURIComponent(noteId)}`,
      { method: 'DELETE', project: slug }
    );
    item.remove();
    bumpNotesCount(thread, -1);
    const list = thread.querySelector('.notes-list');
    if (list && list.children.length === 0) list.innerHTML = '<div class="notes-empty">no notes yet.</div>';
  } catch (e) {
    alert('failed to delete: ' + (e.message || e));
    btn.disabled = false;
  }
}

function bindLLMLint(slug, runId) {
  const btn = document.getElementById('llm-lint-btn');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '🤖 thinking…';
    try {
      const r = await api(`/api/runs/${encodeURIComponent(runId)}/llm-lint`, { method: 'POST', project: slug });
      if (r.skipped) {
        alert('LLM linter skipped: ' + r.skipped);
      } else if (r.error) {
        alert('LLM linter error: ' + r.error);
      } else {
        // Reload the page to show the new verdicts
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    } catch (e) {
      alert('LLM lint failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  };
}

/**
 * Wire the API Calls / Audit Log tabs in the run detail page.
 * First click fetches data and populates the table; subsequent clicks just
 * toggle visibility without re-fetching.
 */
function bindRunDetailTabs(slug, runId) {
  const container = document.querySelector('[data-run-detail-tabs]');
  if (!container) return;

  const btns = container.querySelectorAll('.tab-btn');
  const panels = container.querySelectorAll('.tab-panel');

  // Track which panels have already been loaded.
  const loaded = {};

  // Auto-load the initially visible panel (api-calls).
  loadApiCalls(container, slug, runId, loaded);

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      // Update active button
      btns.forEach(b => b.classList.toggle('active', b === btn));

      // Show/hide panels
      panels.forEach(p => {
        p.style.display = p.dataset.panel === target ? '' : 'none';
      });

      // Lazy-load on first click
      if (target === 'api-calls' && !loaded['api-calls']) {
        loadApiCalls(container, slug, runId, loaded);
      }
      if (target === 'audit-log' && !loaded['audit-log']) {
        loadAuditEntries(container, slug, runId, loaded);
      }
    });
  });
}

async function loadApiCalls(container, slug, runId, loaded) {
  const tbody = container.querySelector('#apiCallsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:16px;">loading…</td></tr>';
  try {
    const { calls } = await api(`/api/runs/${encodeURIComponent(runId)}/http-calls`, { project: slug });
    loaded['api-calls'] = true;
    if (!calls || calls.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:16px;">no HTTP calls recorded for this run.</td></tr>';
      return;
    }
    tbody.innerHTML = calls.map(c => `
      <tr>
        <td>${esc(c.step_n)}</td>
        <td><code>${esc(c.method)}</code></td>
        <td style="max-width:320px;word-break:break-all;"><code>${esc(c.url)}</code></td>
        <td>${c.response_status != null ? esc(String(c.response_status)) : '—'}</td>
        <td class="muted">${esc(c.latency_ms)}ms</td>
        <td class="muted"><code>${esc(c.trace_id)}</code></td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="error-banner">${esc(e.message)}</div></td></tr>`;
  }
}

async function loadAuditEntries(container, slug, runId, loaded) {
  const tbody = container.querySelector('#auditLogTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:16px;">loading…</td></tr>';
  try {
    const { entries } = await api(`/api/runs/${encodeURIComponent(runId)}/audit-entries`, { project: slug });
    loaded['audit-log'] = true;
    if (!entries || entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:16px;">no audit entries for this run.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(e => `
      <tr>
        <td>${esc(e.step_n)}</td>
        <td><code>${esc(e.action)}</code></td>
        <td><span class="badge ${esc(e.status)}">${esc(e.status)}</span></td>
        <td>${e.http_status != null ? esc(String(e.http_status)) : '—'}</td>
        <td class="muted">${esc(e.latency_ms)}ms</td>
        <td class="muted"><code>${esc((e.user_id || '').slice(0, 8))}</code></td>
        <td class="muted"><code>${esc(e.trace_id)}</code></td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="error-banner">${esc(e.message)}</div></td></tr>`;
  }
}

function bumpNotesCount(thread, delta) {
  // Walk up to the finding-card and update the toggle button's count.
  const card = thread.closest('[data-finding-card]');
  if (!card) return;
  const counter = card.querySelector('[data-notes-count]');
  if (!counter) return;
  const cur = parseInt(counter.textContent, 10) || 0;
  const next = Math.max(0, cur + delta);
  counter.textContent = String(next);
  // Update label singular/plural
  const toggle = card.querySelector('[data-action="toggle-notes"]');
  if (toggle) {
    const labelText = next === 1 ? 'note' : 'notes';
    // toggle innerHTML pattern: "💬 <span>N</span> note(s)"
    toggle.innerHTML = `💬 <span data-notes-count>${next}</span> ${labelText}`;
    // Re-bind the click handler since we replaced innerHTML
    // (the listener is on the button itself, not the span — innerHTML replacement
    // doesn't drop button-level listeners, so no rebind needed)
  }
}
