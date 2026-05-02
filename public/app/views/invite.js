import { api } from '../core/state.js';
import { esc } from '../core/layout.js';

// /invite/<code> — direct redeem link landing page
export async function renderInvite(code) {
  setTimeout(() => {
    const btn = document.getElementById('redeem-btn');
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api('/invites/redeem', { method: 'POST', body: JSON.stringify({ code }) }, { project: false });
        location.hash = `#/p/${r.project.slug}/flows`;
      } catch (e) {
        document.getElementById('inv-err').textContent = e.message;
        document.getElementById('inv-err').style.display = 'block';
        btn.disabled = false;
      }
    };
  }, 0);
  return `
    <div class="page-title"><h1>redeem invite</h1></div>
    <div class="card">
      <h3>code: <code>${esc(code)}</code></h3>
      <p class="text-2 fs-12">click below to join this project.</p>
      <button class="btn primary mt-4" id="redeem-btn">join project</button>
      <div id="inv-err" class="error-banner mt-4" style="display:none"></div>
    </div>
  `;
}
