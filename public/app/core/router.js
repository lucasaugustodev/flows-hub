// Hash-based router. URLs look like #/projects, #/p/hub-portal/flows
import { state } from './state.js';

export function navigate(path) {
  if (location.hash !== '#' + path) location.hash = '#' + path;
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function currentPath() {
  return (location.hash || '#/').slice(1) || '/';
}

export function router(routes, layoutFn, { errorPage }) {
  async function dispatch() {
    const path = currentPath();

    let matched = null, params = null;
    for (const r of routes) {
      const m = path.match(r.match);
      if (m) { matched = r; params = m; break; }
    }

    const root = document.getElementById('app');

    // not found
    if (!matched) { root.innerHTML = errorPage(`route not found: ${path}`); return; }

    // auth check
    if (matched.requiresAuth && !state.token) { navigate('/login'); return; }

    // project check
    if (matched.project === true) {
      const slug = params[1];
      state.project = slug;
    }

    try {
      const html = await matched.render(params);
      const shell = matched.shell || layoutFn;
      root.innerHTML = shell(html, path);
      // wire up data-* handlers
      attachHandlers(root);
    } catch (e) {
      console.error(e);
      root.innerHTML = errorPage(e.message || String(e));
    }
  }
  window.addEventListener('hashchange', dispatch);
  // attach navigate to global so onclick handlers work
  window.pfNavigate = navigate;
}

// data-action handlers on rendered HTML
function attachHandlers(root) {
  for (const el of root.querySelectorAll('[data-href]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.href);
    });
    if (el.tagName !== 'A') el.style.cursor = 'pointer';
  }
}
