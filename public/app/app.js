// pageflows web UI — vanilla SPA, no build step.
import { state } from './core/state.js';
import { router, navigate } from './core/router.js';
import { layout, authShell, errorPage } from './core/layout.js';
import { renderLogin, renderSignup } from './views/auth.js';
import { renderProjects } from './views/projects.js';
import { renderFlows, renderFlowDetail } from './views/flows.js';
import { renderRuns, renderRunDetail } from './views/runs.js';
import { renderSessions } from './views/sessions.js';
import { renderSettings } from './views/settings.js';
import { renderInvite } from './views/invite.js';
import { renderDashboard, bindDashboard } from './views/dashboard.js';

// Public route table. Each entry is { match, render, requiresAuth, requiresProject }
const ROUTES = [
  { match: /^\/login$/, render: renderLogin, requiresAuth: false, shell: authShell },
  { match: /^\/signup$/, render: renderSignup, requiresAuth: false, shell: authShell },
  { match: /^\/$/, render: () => { navigate('/dashboard'); return ''; }, requiresAuth: true },
  { match: /^\/dashboard(\?.*)?$/, render: async () => { const html = await renderDashboard(); setTimeout(bindDashboard, 0); return html; }, requiresAuth: true, project: false },
  { match: /^\/projects$/, render: renderProjects, requiresAuth: true, project: false },
  { match: /^\/invite\/([A-Z0-9-]+)$/, render: (m) => renderInvite(m[1]), requiresAuth: true, project: false },
  { match: /^\/p\/([^\/]+)\/flows$/, render: (m) => renderFlows(m[1]), requiresAuth: true, project: true },
  { match: /^\/p\/([^\/]+)\/flows\/([^\/]+)$/, render: (m) => renderFlowDetail(m[1], m[2]), requiresAuth: true, project: true },
  { match: /^\/p\/([^\/]+)\/runs$/, render: (m) => renderRuns(m[1]), requiresAuth: true, project: true },
  { match: /^\/p\/([^\/]+)\/runs\/([^\/]+)$/, render: (m) => renderRunDetail(m[1], m[2]), requiresAuth: true, project: true },
  { match: /^\/p\/([^\/]+)\/sessions$/, render: (m) => renderSessions(m[1]), requiresAuth: true, project: true },
  { match: /^\/p\/([^\/]+)\/settings$/, render: (m) => renderSettings(m[1]), requiresAuth: true, project: true },
];

router(ROUTES, layout, { errorPage });

// Boot
async function boot() {
  if (state.token && !state.user) {
    try {
      const r = await fetch('/auth/me', { headers: { 'X-API-Key': state.token } });
      if (r.ok) state.user = (await r.json()).user;
      else state.clearAuth();
    } catch {}
  }
  // initial dispatch
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
boot();
