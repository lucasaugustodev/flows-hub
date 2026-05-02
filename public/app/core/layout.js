// Layouts: full app shell (with sidebar) + simple auth shell.
import { state } from './state.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// SQLite stores CURRENT_TIMESTAMP as UTC like "2026-04-27 16:31:42". Display
// in America/São_Paulo for the team.
const fmtTime = (s) => {
  if (!s) return '';
  // Parse as UTC (SQLite default) and render in São Paulo
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z'));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
};

export function authShell(content, path) {
  return `<div class="auth-shell">${content}</div>`;
}

export function errorPage(msg) {
  return `<div class="auth-shell"><div class="auth-card"><h1>oops</h1><p class="text-2">${esc(msg)}</p><a href="#/projects" class="btn primary mt-4">back</a></div></div>`;
}

export function layout(content, path) {
  const u = state.user || {};
  const slug = state.project;
  const isProject = slug && /^\/p\//.test(path);

  const navItems = isProject ? [
    { href: `/p/${slug}/flows`, label: 'flows', icon: '▷' },
    { href: `/p/${slug}/runs`, label: 'runs', icon: '◷' },
    { href: `/p/${slug}/sessions`, label: 'sessions', icon: '◑' },
    { href: `/p/${slug}/settings`, label: 'settings', icon: '⚙' },
  ] : [];

  const sideNav = `
    <div class="sidebar">
      <a href="#/projects" class="sidebar-brand"><span class="sidebar-brand-dot"></span>pageflows</a>
      ${slug ? `
        <div class="sidebar-section">
          <div class="sidebar-section-title">project</div>
          <a href="#/projects" class="sidebar-link" style="display:flex;justify-content:space-between;">
            <span>${esc(slug)}</span>
            <span class="text-3">↻</span>
          </a>
        </div>
        <div class="sidebar-section">
          ${navItems.map(n => `<a href="#${n.href}" class="sidebar-link ${path === n.href || path.startsWith(n.href + '/') ? 'active' : ''}"><span style="margin-right:8px;color:var(--text-3);">${n.icon}</span>${n.label}</a>`).join('')}
        </div>
      ` : `
        <div class="sidebar-section">
          <a href="#/dashboard" class="sidebar-link ${path.startsWith('/dashboard') ? 'active' : ''}"><span style="margin-right:8px;color:var(--text-3);">♥</span>health</a>
          <a href="#/projects" class="sidebar-link ${path === '/projects' ? 'active' : ''}"><span style="margin-right:8px;color:var(--text-3);">▦</span>all projects</a>
        </div>
      `}
      <div class="sidebar-footer">
        <div>${esc(u.email || '')}</div>
        <a href="#" onclick="event.preventDefault();window.pfLogout()" class="text-3" style="font-size:11px;">logout</a>
      </div>
    </div>
  `;

  return `<div class="layout">${sideNav}<div class="main"><div class="main-content">${content}</div></div></div>`;
}

// global logout helper
window.pfLogout = async () => {
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { 'X-API-Key': state.token } });
  } catch {}
  state.clearAuth();
  location.hash = '#/login';
};

export { esc, fmtTime };
