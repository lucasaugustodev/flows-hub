// Global app state, persisted to localStorage.
const KEY_TOKEN = 'pf_token';
const KEY_USER = 'pf_user';
const KEY_PROJECT = 'pf_project';

export const state = {
  get token() { return localStorage.getItem(KEY_TOKEN) || ''; },
  set token(v) { v ? localStorage.setItem(KEY_TOKEN, v) : localStorage.removeItem(KEY_TOKEN); },
  get user() {
    const raw = localStorage.getItem(KEY_USER);
    return raw ? JSON.parse(raw) : null;
  },
  set user(v) { v ? localStorage.setItem(KEY_USER, JSON.stringify(v)) : localStorage.removeItem(KEY_USER); },
  get project() { return localStorage.getItem(KEY_PROJECT) || ''; },
  set project(v) { v ? localStorage.setItem(KEY_PROJECT, v) : localStorage.removeItem(KEY_PROJECT); },
  clearAuth() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_USER);
    localStorage.removeItem(KEY_PROJECT);
  },
};

// API helper. opts.project overrides current project context.
export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['X-API-Key'] = state.token;
  if (opts.project !== false) {
    const slug = opts.project || state.project;
    if (slug) headers['X-Project'] = slug;
  }
  const r = await fetch(path, { ...opts, headers });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(data.error || `${r.status} ${r.statusText}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

// Streaming version for SSE-style endpoints.
export async function apiStream(path, opts = {}, onEvent) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.headers || {}) };
  if (state.token) headers['X-API-Key'] = state.token;
  if (opts.project !== false) {
    const slug = opts.project || state.project;
    if (slug) headers['X-Project'] = slug;
  }
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    throw new Error(data.error || `${r.status} ${r.statusText}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = '', dataLine = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (ln.startsWith('event: ')) event = ln.slice(7).trim();
      else if (ln.startsWith('data: ')) dataLine = ln.slice(6);
      else if (ln === '' && event && dataLine) {
        try { onEvent(event, JSON.parse(dataLine)); } catch {}
        event = ''; dataLine = '';
      }
    }
  }
}
