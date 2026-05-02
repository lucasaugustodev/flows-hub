import { api, state } from '../core/state.js';
import { esc } from '../core/layout.js';

export async function renderSettings(slug) {
  let proj, members, invites = { invites: [] }, tokens = { tokens: [] }, vars = { vars: [] };
  let rulesData = { rules: [] }, suggestionsData = { suggestions: [] };
  try {
    proj = await api(`/projects/${slug}`, {}, { project: false });
    members = proj.members;
    invites = await api(`/projects/${slug}/invites`, {}, { project: false }).catch(() => ({ invites: [] }));
    tokens = await api('/auth/tokens', {}, { project: false }).catch(() => ({ tokens: [] }));
    vars = await api('/api/project-vars', {}, { project: slug }).catch(() => ({ vars: [] }));
    rulesData = await api('/api/suppression-rules', {}, { project: slug }).catch(() => ({ rules: [] }));
    suggestionsData = await api('/api/rule-suggestions', {}, { project: slug }).catch(() => ({ suggestions: [] }));
  } catch (e) {
    return `<div class="error-banner">${esc(e.message)}</div>`;
  }

  setTimeout(() => bindSettings(slug), 0);

  const myRole = proj.project.role;
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  const membersRows = members.map(m => `
    <tr>
      <td>${esc(m.email)}</td>
      <td>${esc(m.name || '')}</td>
      <td><span class="badge role-${m.role}">${esc(m.role)}</span></td>
      <td class="muted">${esc(m.joined_at)}</td>
      <td>${isAdmin && m.role !== 'owner' ? `<button class="btn small danger" data-rm-member="${esc(m.user_id)}">remove</button>` : ''}</td>
    </tr>
  `).join('');

  const invitesRows = invites.invites.map(i => {
    const used = i.used_at;
    const expired = !used && i.expires_at && new Date(i.expires_at) < new Date();
    const status = used ? 'used' : expired ? 'expired' : 'pending';
    return `
      <tr>
        <td><code>${esc(i.code)}</code></td>
        <td><span class="badge role-${i.role}">${esc(i.role)}</span></td>
        <td><span class="badge ${used ? 'passed' : expired ? 'failed' : 'running'}">${status}</span></td>
        <td class="muted">${esc(i.expires_at)}</td>
        <td>${isAdmin && !used ? `<button class="btn small danger" data-rm-invite="${esc(i.id)}">revoke</button>` : ''}</td>
      </tr>
    `;
  }).join('');

  const tokensRows = tokens.tokens.map(t => `
    <tr>
      <td>${esc(t.name || '<unnamed>')}</td>
      <td><span class="badge">${esc(t.kind)}</span></td>
      <td><code>${esc(t.key_prefix)}…</code></td>
      <td class="muted">${esc(t.last_used_at || 'never')}</td>
      <td class="muted">${esc(t.expires_at || '—')}</td>
      <td><button class="btn small danger" data-rm-token="${esc(t.id)}">revoke</button></td>
    </tr>
  `).join('');

  return `
    <div class="page-title"><h1>settings</h1></div>

    <div class="card">
      <h3>project</h3>
      <div class="text-2 fs-12">name: <b>${esc(proj.project.name)}</b></div>
      <div class="text-2 fs-12">slug: <code>${esc(proj.project.slug)}</code></div>
      <div class="text-2 fs-12">created: ${esc(proj.project.created_at)}</div>
      <div class="text-2 fs-12">your role: <span class="badge role-${myRole}">${myRole}</span></div>
      ${isOwner ? `<button class="btn danger small mt-4" id="del-project">delete project</button>` : ''}
    </div>

    <div class="card">
      <h3>project context</h3>
      <p class="text-2 fs-12">
        Markdown describing your project — tech stack, expected behaviors,
        known quirks. The LLM linter pass uses this to tell real bugs from
        accepted oddities (e.g. "401s on /me are expected for anonymous
        traffic"). Max 16KB. ${isAdmin ? '' : '<i>(read-only — owner/admin can edit)</i>'}
      </p>
      <textarea id="ctx-input" rows="10"
                ${isAdmin ? '' : 'readonly'}
                style="width:100%;font-family:ui-monospace,monospace;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:10px;resize:vertical;"
                placeholder="# Hub Portal&#10;&#10;Tech: SvelteKit + Supabase&#10;&#10;## Known acceptable&#10;- /rest/v1/turma_participantes returns 406 for anon (RLS)&#10;- console: 'Erro ao buscar turmas do usuário' on logged-out home&#10;">${esc(proj.project.context_md || '')}</textarea>
      <div class="actions mt-4" style="display:flex;gap:8px;align-items:center">
        ${isAdmin ? `
          <button class="btn primary" id="ctx-save" type="button">save context</button>
          <span id="ctx-status" class="text-3 fs-12"></span>
        ` : ''}
      </div>
    </div>

    <div class="card">
      <h3>members (${members.length})</h3>
      <table class="table">
        <thead><tr><th>email</th><th>name</th><th>role</th><th>joined</th><th></th></tr></thead>
        <tbody>${membersRows}</tbody>
      </table>
    </div>

    ${isAdmin ? `
    <div class="card">
      <h3>invites</h3>
      ${invites.invites.length === 0 ? '<div class="text-3 fs-12">no invites yet.</div>' : `
        <table class="table">
          <thead><tr><th>code</th><th>role</th><th>status</th><th>expires</th><th></th></tr></thead>
          <tbody>${invitesRows}</tbody>
        </table>
      `}
      <button class="btn primary mt-4" id="new-invite">+ generate invite code</button>
    </div>
    ` : ''}

    <div class="card">
      <h3>project vars</h3>
      <p class="text-2 fs-12">credentials and constants used by flows. auto-merged into replays as defaults — overridable per-run via --var.</p>
      ${vars.vars.length === 0 ? '<div class="text-3 fs-12">no vars yet. add one below.</div>' : `
        <table class="table">
          <thead><tr><th>name</th><th>value</th><th>secret</th><th>updated</th><th></th></tr></thead>
          <tbody>${vars.vars.map(v => `
            <tr>
              <td><code>${esc(v.name)}</code></td>
              <td>${v.is_secret ? '<span class="text-3">••••••••</span>' : `<code>${esc(String(v.value).slice(0, 80))}</code>`}</td>
              <td>${v.is_secret ? '🔒' : ''}</td>
              <td class="muted">${esc(v.updated_at)}</td>
              <td><button class="btn small danger" data-rm-var="${esc(v.name)}">remove</button></td>
            </tr>
          `).join('')}</tbody>
        </table>
      `}
      <button class="btn primary mt-4" id="new-var">+ add var</button>
    </div>

    <div class="card">
      <h3>your api tokens</h3>
      <p class="text-2 fs-12">used by the CLI / agent. tokens are shown only once at creation.</p>
      ${tokens.tokens.length === 0 ? '<div class="text-3 fs-12">no tokens yet.</div>' : `
        <table class="table">
          <thead><tr><th>name</th><th>kind</th><th>prefix</th><th>last used</th><th>expires</th><th></th></tr></thead>
          <tbody>${tokensRows}</tbody>
        </table>
      `}
      <button class="btn primary mt-4" id="new-token">+ create token</button>
    </div>

    ${isAdmin ? `
    <div class="card">
      <h3>suppression rules</h3>
      <p class="text-2 fs-12">JSON DSL: keys are dotted paths on a finding, values are exact / array (any-of) / <code>{$regex}</code> / <code>{$contains}</code> / <code>{$prefix}</code> / <code>{$gte}</code> / <code>{$lte}</code>. Example: <code>{"type":"network_error","evidence.status":406}</code> auto-suppresses any 406 network finding.</p>
      ${suggestionsData.suggestions.length > 0 ? `
        <div class="rule-suggestions">
          <div class="text-2 fs-12 mb-2">💡 suggestions based on your manual triage:</div>
          ${suggestionsData.suggestions.map((s, i) => `
            <div class="rule-suggestion" data-suggest-idx="${i}">
              <div class="text-2 fs-12">
                <b>${esc(s.count)}</b> findings you marked as <span class="badge triage-not_a_bug">not a bug</span>
                share <code>${esc(JSON.stringify(s.suggested_expr))}</code>
              </div>
              <div class="text-3 fs-12">${esc(s.sample_msg)}</div>
              <button class="btn primary fs-12" data-action="accept-suggestion"
                      data-suggest='${esc(JSON.stringify(s))}'>accept rule</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${rulesData.rules.length === 0 ? '<div class="text-3 fs-12">no rules yet.</div>' : `
        <div class="rules-list">
          ${rulesData.rules.map(r => `
            <div class="rule-row" data-rule-id="${esc(r.id)}">
              <div class="rule-hd">
                <b class="rule-name">${esc(r.name)}</b>
                <span class="badge">${r.match_count} ${r.match_count === 1 ? 'match' : 'matches'}</span>
                <label class="schedule-toggle">
                  <input type="checkbox" ${r.enabled ? 'checked' : ''} data-action="toggle-rule"/>
                  <span>${r.enabled ? 'enabled' : 'disabled'}</span>
                </label>
                <button class="btn fs-12" data-action="edit-rule" type="button">edit</button>
                <button class="btn fs-12 danger" data-action="delete-rule" type="button">×</button>
              </div>
              ${r.description ? `<div class="text-3 fs-12">${esc(r.description)}</div>` : ''}
              <pre class="rule-expr">${esc(JSON.stringify(r.expr || {}, null, 2))}</pre>
            </div>
          `).join('')}
        </div>
      `}
      <button class="btn primary mt-4" id="new-rule">+ create rule</button>
    </div>
    ` : ''}

    <div id="modal-bg" class="modal-bg" style="display:none">
      <div class="modal" id="modal-body"></div>
    </div>
  `;
}

function bindSettings(slug) {
  const bg = document.getElementById('modal-bg');
  const body = document.getElementById('modal-body');
  const close = () => { bg.style.display = 'none'; body.innerHTML = ''; };
  bg && (bg.onclick = (e) => { if (e.target === bg) close(); });

  const ctxSave = document.getElementById('ctx-save');
  if (ctxSave) ctxSave.onclick = async () => {
    const ta = document.getElementById('ctx-input');
    const status = document.getElementById('ctx-status');
    const ctx = ta.value;
    ctxSave.disabled = true;
    status.textContent = 'saving…';
    try {
      await api(`/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ context_md: ctx }) }, { project: false });
      status.textContent = 'saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (e) {
      status.textContent = 'error: ' + e.message;
    } finally {
      ctxSave.disabled = false;
    }
  };

  // ---- suppression rules ----
  const newRule = document.getElementById('new-rule');
  if (newRule) newRule.onclick = () => openRuleModal(slug, null, body, bg);

  document.querySelectorAll('[data-rule-id]').forEach(row => {
    const id = row.dataset.ruleId;
    const tog = row.querySelector('[data-action="toggle-rule"]');
    const edit = row.querySelector('[data-action="edit-rule"]');
    const del = row.querySelector('[data-action="delete-rule"]');
    if (tog) tog.onchange = async () => {
      try {
        await api(`/api/suppression-rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: tog.checked }) }, { project: slug });
        const lab = tog.parentElement.querySelector('span');
        if (lab) lab.textContent = tog.checked ? 'enabled' : 'disabled';
      } catch (e) { tog.checked = !tog.checked; alert('toggle failed: ' + e.message); }
    };
    if (edit) edit.onclick = () => openRuleModal(slug, id, body, bg);
    if (del) del.onclick = async () => {
      if (!confirm('delete this rule? auto-triages it created will be cleared.')) return;
      try {
        await api(`/api/suppression-rules/${id}`, { method: 'DELETE' }, { project: slug });
        row.remove();
      } catch (e) { alert('delete failed: ' + e.message); }
    };
  });

  document.querySelectorAll('[data-action="accept-suggestion"]').forEach(btn => {
    btn.onclick = async () => {
      const s = JSON.parse(btn.dataset.suggest);
      btn.disabled = true; btn.textContent = '…';
      try {
        await api('/api/suppression-rules', {
          method: 'POST',
          body: JSON.stringify({ name: s.suggested_name, description: `auto-suggested from ${s.count} manual triages`, expr: s.suggested_expr }),
        }, { project: slug });
        // Re-render so the new rule shows up + suggestion drops off.
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (e) {
        btn.disabled = false; btn.textContent = 'accept rule';
        alert(e.message);
      }
    };
  });

  const newInvite = document.getElementById('new-invite');
  if (newInvite) newInvite.onclick = () => {
    body.innerHTML = `
      <h2>generate invite</h2>
      <form id="ni-form">
        <div class="field"><label>role</label><select name="role"><option value="editor" selected>editor</option><option value="admin">admin</option><option value="viewer">viewer</option></select></div>
        <div class="field"><label>expires in days</label><input name="expiresInDays" type="number" value="14" min="1" max="365"/></div>
        <div class="flex gap-2 mt-4 justify-between">
          <button type="button" class="btn" onclick="document.getElementById('modal-bg').style.display='none'">cancel</button>
          <button class="btn primary" type="submit">generate</button>
        </div>
      </form>
      <div id="ni-err" class="error-banner mt-4" style="display:none"></div>
    `;
    bg.style.display = 'flex';
    document.getElementById('ni-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api(`/projects/${slug}/invites`, { method: 'POST', body: JSON.stringify({ role: fd.get('role'), expiresInDays: parseInt(fd.get('expiresInDays')) }) }, { project: false });
        body.innerHTML = `
          <h2>invite created</h2>
          <p class="text-2 fs-12">share this code with the invitee — they redeem it from the projects page:</p>
          <pre style="font-size:18px;text-align:center;letter-spacing:2px;padding:20px;">${esc(r.code)}</pre>
          <div class="text-3 fs-12">role: ${esc(r.role)} · expires: ${esc(r.expiresAt)}</div>
          <button class="btn primary mt-4 full" onclick="document.getElementById('modal-bg').style.display='none';location.reload()">done</button>
        `;
      } catch (e) {
        const errEl = document.getElementById('ni-err');
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    };
  };

  const newVar = document.getElementById('new-var');
  if (newVar) newVar.onclick = () => {
    body.innerHTML = `
      <h2>add project var</h2>
      <form id="nv-form">
        <div class="field"><label>name</label><input name="name" required autofocus pattern="[A-Za-z][A-Za-z0-9_]*" placeholder="TEST_EMAIL"/></div>
        <div class="field"><label>value</label><textarea name="value" required rows="2"></textarea></div>
        <div class="field"><label>description (optional)</label><input name="description"/></div>
        <div class="field"><label><input type="checkbox" name="is_secret"/> mark as secret (redact in displays)</label></div>
        <div class="flex gap-2 mt-4 justify-between">
          <button type="button" class="btn" onclick="document.getElementById('modal-bg').style.display='none'">cancel</button>
          <button class="btn primary" type="submit">save</button>
        </div>
      </form>
      <div id="nv-err" class="error-banner mt-4" style="display:none"></div>
    `;
    bg.style.display = 'flex';
    document.getElementById('nv-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api(`/api/project-vars/${encodeURIComponent(fd.get('name'))}`, {
          method: 'PUT',
          body: JSON.stringify({ value: fd.get('value'), is_secret: fd.get('is_secret') === 'on', description: fd.get('description') || null }),
        }, { project: slug });
        location.reload();
      } catch (e) {
        const errEl = document.getElementById('nv-err');
        errEl.textContent = e.message; errEl.style.display = 'block';
      }
    };
  };

  document.querySelectorAll('[data-rm-var]').forEach(b => b.onclick = async () => {
    if (!confirm(`remove var "${b.dataset.rmVar}"?`)) return;
    await api(`/api/project-vars/${encodeURIComponent(b.dataset.rmVar)}`, { method: 'DELETE' }, { project: slug });
    location.reload();
  });

  const newToken = document.getElementById('new-token');
  if (newToken) newToken.onclick = () => {
    body.innerHTML = `
      <h2>create api token</h2>
      <form id="nt-form">
        <div class="field"><label>name (e.g. ci, my-laptop)</label><input name="name" required autofocus/></div>
        <div class="field"><label>expires in days (optional)</label><input name="expiresInDays" type="number" placeholder="never expires"/></div>
        <div class="flex gap-2 mt-4 justify-between">
          <button type="button" class="btn" onclick="document.getElementById('modal-bg').style.display='none'">cancel</button>
          <button class="btn primary" type="submit">create</button>
        </div>
      </form>
      <div id="nt-err" class="error-banner mt-4" style="display:none"></div>
    `;
    bg.style.display = 'flex';
    document.getElementById('nt-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const exp = fd.get('expiresInDays');
      try {
        const r = await api('/auth/tokens', {
          method: 'POST',
          body: JSON.stringify({ name: fd.get('name'), expiresInDays: exp ? parseInt(exp) : null }),
        }, { project: false });
        body.innerHTML = `
          <h2>token created</h2>
          <p class="text-2 fs-12">copy this NOW — you won't see it again:</p>
          <pre style="user-select:all;word-break:break-all;">${esc(r.token)}</pre>
          <div class="text-3 fs-12 mt-4">use it via: <code>X-API-Key: ${esc(r.prefix)}…</code> or <code>pageflows tokens use &lt;token&gt;</code></div>
          <button class="btn primary mt-4 full" onclick="document.getElementById('modal-bg').style.display='none';location.reload()">done</button>
        `;
      } catch (e) {
        const errEl = document.getElementById('nt-err');
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    };
  };

  // Inline action buttons
  document.querySelectorAll('[data-rm-member]').forEach(b => b.onclick = async () => {
    if (!confirm('remove member?')) return;
    await api(`/projects/${slug}/members/${b.dataset.rmMember}`, { method: 'DELETE' }, { project: false });
    location.reload();
  });
  document.querySelectorAll('[data-rm-invite]').forEach(b => b.onclick = async () => {
    if (!confirm('revoke invite?')) return;
    await api(`/projects/${slug}/invites/${b.dataset.rmInvite}`, { method: 'DELETE' }, { project: false });
    location.reload();
  });
  document.querySelectorAll('[data-rm-token]').forEach(b => b.onclick = async () => {
    if (!confirm('revoke this token? CLIs/agents using it will stop working.')) return;
    await api(`/auth/tokens/${b.dataset.rmToken}`, { method: 'DELETE' }, { project: false });
    location.reload();
  });

  const delBtn = document.getElementById('del-project');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('delete project? this removes ALL flows, runs, sessions, members. cannot be undone.')) return;
    await api(`/projects/${slug}`, { method: 'DELETE' }, { project: false });
    location.hash = '#/projects';
  };
}

async function openRuleModal(slug, ruleId, body, bg) {
  // Pre-fill if editing
  let rule = { name: '', description: '', expr: { type: 'network_error' }, enabled: true };
  if (ruleId) {
    try {
      const { rules } = await api('/api/suppression-rules', {}, { project: slug });
      const found = rules.find(r => r.id === ruleId);
      if (found) rule = { name: found.name, description: found.description || '', expr: found.expr || {}, enabled: !!found.enabled };
    } catch {}
  }
  body.innerHTML = `
    <h2>${ruleId ? 'edit' : 'new'} suppression rule</h2>
    <div class="field">
      <label>name</label>
      <input id="rl-name" value="${esc(rule.name)}" placeholder="e.g. supabase RLS 406"/>
    </div>
    <div class="field">
      <label>description (optional)</label>
      <input id="rl-desc" value="${esc(rule.description)}" placeholder="why this is acceptable"/>
    </div>
    <div class="field">
      <label>expression (JSON)</label>
      <textarea id="rl-expr" rows="8" style="width:100%;font-family:ui-monospace,monospace;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;">${esc(JSON.stringify(rule.expr, null, 2))}</textarea>
    </div>
    <div class="field" style="display:flex;gap:6px;align-items:center">
      <input type="checkbox" id="rl-enabled" ${rule.enabled ? 'checked' : ''}/>
      <label for="rl-enabled" style="margin:0">enabled</label>
    </div>
    <div class="actions mt-4" style="display:flex;gap:8px;justify-content:space-between">
      <button type="button" class="btn" id="rl-cancel">cancel</button>
      <button class="btn primary" id="rl-save" type="button">${ruleId ? 'save' : 'create'}</button>
    </div>
    <div id="rl-err" class="error-banner mt-4" style="display:none"></div>
  `;
  bg.style.display = 'flex';
  document.getElementById('rl-cancel').onclick = () => { bg.style.display = 'none'; };
  document.getElementById('rl-save').onclick = async () => {
    const name = document.getElementById('rl-name').value.trim();
    const description = document.getElementById('rl-desc').value.trim();
    const exprText = document.getElementById('rl-expr').value;
    const enabled = document.getElementById('rl-enabled').checked;
    const errEl = document.getElementById('rl-err');
    errEl.style.display = 'none';
    let expr;
    try { expr = JSON.parse(exprText); }
    catch (e) { errEl.textContent = 'expr must be valid JSON: ' + e.message; errEl.style.display = ''; return; }
    if (!name) { errEl.textContent = 'name required'; errEl.style.display = ''; return; }
    try {
      if (ruleId) {
        await api(`/api/suppression-rules/${ruleId}`, { method: 'PATCH', body: JSON.stringify({ name, description, expr, enabled }) }, { project: slug });
      } else {
        await api('/api/suppression-rules', { method: 'POST', body: JSON.stringify({ name, description, expr, enabled }) }, { project: slug });
      }
      bg.style.display = 'none';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
    }
  };
}
