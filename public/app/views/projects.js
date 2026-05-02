import { api, state } from '../core/state.js';
import { esc } from '../core/layout.js';

export async function renderProjects() {
  let projects = [];
  try { ({ projects } = await api('/projects', {}, { project: false })); }
  catch (e) { return `<div class="error-banner">${esc(e.message)}</div>`; }

  // attach handlers after render
  setTimeout(bindHandlers, 0);

  const cards = projects.map(p => `
    <div class="card" data-href="/p/${p.slug}/flows">
      <div class="flex justify-between items-center">
        <h3>${esc(p.name)}</h3>
        <span class="badge role-${p.role}">${p.role}</span>
      </div>
      <div class="text-2 fs-12">${esc(p.description || '')}</div>
      <div class="text-3 fs-12 mt-4"><code>${esc(p.slug)}</code></div>
    </div>
  `).join('');

  return `
    <div class="page-title">
      <h1>your projects</h1>
      <div class="actions">
        <button class="btn" id="join-btn">↗ redeem invite</button>
        <button class="btn primary" id="new-btn">+ new project</button>
      </div>
    </div>
    ${projects.length === 0 ? `
      <div class="empty">no projects yet. create one or redeem an invite code.</div>
    ` : `<div class="card-grid">${cards}</div>`}

    <div id="modal-bg" class="modal-bg" style="display:none">
      <div class="modal" id="modal-body"></div>
    </div>
  `;
}

function bindHandlers() {
  const newBtn = document.getElementById('new-btn');
  const joinBtn = document.getElementById('join-btn');
  const bg = document.getElementById('modal-bg');
  const body = document.getElementById('modal-body');
  if (!newBtn) return;

  const closeModal = () => { bg.style.display = 'none'; body.innerHTML = ''; };
  bg.onclick = (e) => { if (e.target === bg) closeModal(); };

  newBtn.onclick = () => {
    body.innerHTML = `
      <h2>new project</h2>
      <form id="np-form">
        <div class="field"><label>name</label><input name="name" required autofocus/></div>
        <div class="field"><label>slug (optional, auto from name)</label><input name="slug" placeholder="kebab-case"/></div>
        <div class="field"><label>description (optional)</label><input name="description"/></div>
        <div class="flex gap-2 mt-4 justify-between">
          <button type="button" class="btn" onclick="document.getElementById('modal-bg').style.display='none'">cancel</button>
          <button class="btn primary" type="submit">create</button>
        </div>
      </form>
      <div id="np-err" class="error-banner mt-4" style="display:none"></div>
    `;
    bg.style.display = 'flex';
    document.getElementById('np-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) }, { project: false });
        location.hash = `#/p/${r.project.slug}/flows`;
      } catch (e) {
        const errEl = document.getElementById('np-err');
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    };
  };

  joinBtn.onclick = () => {
    body.innerHTML = `
      <h2>redeem invite</h2>
      <form id="ji-form">
        <div class="field"><label>code (e.g. ABCD-EFGH-IJKL)</label><input name="code" required autofocus style="text-transform:uppercase"/></div>
        <div class="flex gap-2 mt-4 justify-between">
          <button type="button" class="btn" onclick="document.getElementById('modal-bg').style.display='none'">cancel</button>
          <button class="btn primary" type="submit">join</button>
        </div>
      </form>
      <div id="ji-err" class="error-banner mt-4" style="display:none"></div>
    `;
    bg.style.display = 'flex';
    document.getElementById('ji-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('/invites/redeem', { method: 'POST', body: JSON.stringify({ code: String(fd.get('code')).toUpperCase().trim() }) }, { project: false });
        location.hash = `#/p/${r.project.slug}/flows`;
      } catch (e) {
        const errEl = document.getElementById('ji-err');
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    };
  };
}
