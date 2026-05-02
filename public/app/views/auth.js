import { state, api } from '../core/state.js';

// ----- LOGIN (single-step email + password) -----
function loginForm() {
  return `
    <div class="auth-card">
      <h1>log in</h1>
      <p class="sub">pageflows · internal access only</p>
      <div id="auth-err" style="display:none" class="error-banner"></div>
      <form id="auth-form" autocomplete="on">
        <div class="field"><label>email</label><input name="email" type="email" required autocomplete="email"/></div>
        <div class="field"><label>password</label><input name="password" type="password" required autocomplete="current-password"/></div>
        <button class="btn primary full mt-4" type="submit">log in</button>
      </form>
      <p class="text-2 fs-12 mt-4" style="text-align:center;">no account? <a href="#/signup">sign up</a></p>
    </div>
  `;
}

function bindLogin() {
  setTimeout(() => {
    const form = document.getElementById('auth-form');
    const err = document.getElementById('auth-err');
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      const body = Object.fromEntries(new FormData(form));
      try {
        const r = await fetch('/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        state.token = data.token; state.user = data.user;
        location.hash = '#/projects';
      } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    };
  }, 0);
}

// ----- SIGNUP (2-step with OTP) -----
function signupForm(step = 1, prefill = {}) {
  if (step === 1) {
    return `
      <div class="auth-card">
        <h1>create account</h1>
        <p class="sub">pageflows · only @${prefill.allowedDomain || 'somosahub.com.br'} emails</p>
        <div id="auth-err" style="display:none" class="error-banner"></div>
        <form id="signup-form-1" autocomplete="on">
          <div class="field"><label>work email</label><input name="email" type="email" required autocomplete="email" placeholder="you@somosahub.com.br" value="${prefill.email || ''}"/></div>
          <div class="field"><label>name (optional)</label><input name="name" autocomplete="name" value="${prefill.name || ''}"/></div>
          <div class="field"><label>password (min 8)</label><input name="password" type="password" required autocomplete="new-password"/></div>
          <button class="btn primary full mt-4" type="submit">send verification code</button>
        </form>
        <p class="text-2 fs-12 mt-4" style="text-align:center;">have an account? <a href="#/login">log in</a></p>
      </div>
    `;
  }
  // step 2
  return `
    <div class="auth-card">
      <h1>verify your email</h1>
      <p class="sub">we sent a 6-digit code to <b>${prefill.email}</b></p>
      <div id="auth-err" style="display:none" class="error-banner"></div>
      <form id="signup-form-2" autocomplete="off">
        <div class="field"><label>code</label><input name="otp" required inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="123456" autofocus style="font-size:24px;letter-spacing:8px;text-align:center;font-family:monospace"/></div>
        <button class="btn primary full mt-4" type="submit">verify and create account</button>
      </form>
      <p class="text-2 fs-12 mt-4" style="text-align:center;">
        <a href="#" id="resend-link">re-send code</a> · <a href="#/signup">change email</a>
      </p>
    </div>
  `;
}

function bindSignup(step, prefill) {
  setTimeout(() => {
    const err = document.getElementById('auth-err');
    if (step === 1) {
      const form = document.getElementById('signup-form-1');
      if (!form) return;
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.style.display = 'none';
        const body = Object.fromEntries(new FormData(form));
        try {
          const r = await fetch('/auth/signup/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'failed');
          // remember email for step 2; password is server-side in pending_signups
          sessionStorage.setItem('pf_signup_email', body.email);
          sessionStorage.setItem('pf_signup_name', body.name || '');
          renderInto(signupForm(2, { email: body.email }));
          bindSignup(2, { email: body.email });
        } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
      };
    } else {
      const form = document.getElementById('signup-form-2');
      if (!form) return;
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.style.display = 'none';
        const otp = String(new FormData(form).get('otp')).trim();
        try {
          const r = await fetch('/auth/signup/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: prefill.email, otp }),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'failed');
          state.token = data.token; state.user = data.user;
          sessionStorage.removeItem('pf_signup_email');
          sessionStorage.removeItem('pf_signup_name');
          location.hash = '#/projects';
        } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
      };
      const resend = document.getElementById('resend-link');
      if (resend) resend.onclick = (ev) => {
        ev.preventDefault();
        // Bounce back to step 1 (server requires re-supplying password)
        renderInto(signupForm(1, prefill));
        bindSignup(1, prefill);
      };
    }
  }, 0);
}

// In-place re-render without re-running the router
function renderInto(html) {
  const root = document.getElementById('app');
  if (root) root.innerHTML = `<div class="auth-shell">${html}</div>`;
}

export function renderLogin() {
  bindLogin();
  return loginForm();
}

export function renderSignup() {
  bindSignup(1, {});
  return signupForm(1);
}
