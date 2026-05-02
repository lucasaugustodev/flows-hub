/**
 * Action handlers — execute one atomic action on a session's page.
 *
 * Every action returns { ok, ... } and appends an event to the session's recorder.
 */
const { appendEvent, snapshot } = require('./sessions');

async function goto(s, args = {}) {
  const { url, waitUntil = 'domcontentloaded', timeout = 30000 } = args;
  await s.page.goto(url, { waitUntil, timeout });
  const screenshot = await snapshot(s, 'goto');
  appendEvent(s, { action: 'goto', args: { url, waitUntil }, screenshot });
  return { ok: true, url: s.page.url(), screenshot };
}

async function click(s, args = {}) {
  const { target, text, timeout = 10000 } = args;
  const sel = resolveSelector({ target, text });
  await s.page.locator(sel).first().click({ timeout });
  await s.page.waitForTimeout(200);
  const screenshot = await snapshot(s, `click-${(text || target || '').slice(0, 20)}`);
  appendEvent(s, { action: 'click', args: { target: sel, text }, screenshot });
  return { ok: true, screenshot };
}

async function fill(s, args = {}) {
  const { target, value, label, recordAs } = args;
  const sel = resolveSelector({ target, label });
  await s.page.locator(sel).first().fill(String(value));
  const screenshot = await snapshot(s, `fill-${(target || label || '').slice(0, 20)}`);
  // recordAs lets a CLI fill a real value while persisting a ${VAR} placeholder in the flow
  appendEvent(s, { action: 'fill', args: { target: sel, value: recordAs != null ? recordAs : value }, screenshot });
  return { ok: true, screenshot };
}

async function selectOption(s, args = {}) {
  const { target, value, label, recordAs } = args;
  if (!target) throw new Error('select requires target');
  // Playwright accepts {value} or {label} or string
  const opt = label ? { label } : value;
  await s.page.locator(target).first().selectOption(opt);
  const screenshot = await snapshot(s, `select-${target.slice(0, 20)}`);
  appendEvent(s, { action: 'select', args: { target, value: recordAs != null ? recordAs : (label || value) }, screenshot });
  return { ok: true, screenshot };
}

async function press(s, args = {}) {
  const { target, key } = args;
  const sel = resolveSelector({ target });
  await s.page.locator(sel).first().press(key);
  appendEvent(s, { action: 'press', args: { target: sel, key } });
  return { ok: true };
}

async function waitFor(s, args = {}) {
  const { text, target, state = 'visible', timeout = 30000 } = args;
  if (text) {
    await s.page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
  } else if (target) {
    await s.page.locator(target).first().waitFor({ state, timeout });
  } else {
    await s.page.waitForTimeout(timeout);
  }
  appendEvent(s, { action: 'wait_for', args: { text, target, state, timeout } });
  return { ok: true };
}

async function waitMs(s, args = {}) {
  const { ms = 1000 } = args;
  await s.page.waitForTimeout(Math.min(ms, 30000));
  appendEvent(s, { action: 'wait_ms', args: { ms } });
  return { ok: true };
}

async function screenshotAction(s, args = {}) {
  const { fullPage = false } = args;
  const file = await snapshot(s, 'manual');
  appendEvent(s, { action: 'screenshot', args: { fullPage }, screenshot: file });
  return { ok: true, screenshot: file };
}

async function snap(s) {
  // text-only summary of interactive elements + visible text
  const data = await s.page.evaluate(() => {
    const out = { url: location.href, title: document.title, elements: [], text: '' };
    const sels = 'button, a, input, select, textarea, [role="button"], [role="link"]';
    let i = 0;
    document.querySelectorAll(sels).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || el.offsetParent === null) return;
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 100);
      const item = { id: i++, tag, text, type: el.type, name: el.name, placeholder: el.placeholder };
      if (el.disabled) item.disabled = true;
      if (tag === 'select') {
        item.value = el.value;
        item.options = Array.from(el.options).map(o => ({ value: o.value, label: o.label || o.text }));
      } else if (tag === 'input' || tag === 'textarea') {
        item.value = el.value;
        // surface attrs that affect Playwright selector reliability
        for (const attr of ['inputmode', 'autocomplete', 'pattern', 'aria-label', 'role']) {
          const v = el.getAttribute(attr);
          if (v) item[attr] = v;
        }
        if (el.required) item.required = true;
        if (el.checked != null && (el.type === 'checkbox' || el.type === 'radio')) item.checked = el.checked;
      } else if (tag === 'a') {
        item.href = el.getAttribute('href') || '';
      }
      out.elements.push(item);
    });
    out.text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500);
    return out;
  });
  // Não persistimos snap como event (consulta read-only)
  return { ok: true, ...data };
}

async function evalJs(s, args = {}) {
  const { script, as } = args;
  if (!script) throw new Error('eval requires script');
  const result = await s.page.evaluate(script);
  appendEvent(s, { action: 'eval', args: { script, as } });
  const out = { ok: true, result };
  if (as) out.extracted = { [as]: result };
  return out;
}

/**
 * Read a value from the page DOM into a flow variable.
 *
 *   { action: "extract", args: {
 *       selector: ".valor-parcela",
 *       as: "UI_VALUE",
 *       transform: "currency"   // optional: currency|int|float|regex:<pattern>|trim
 *   } }
 *
 * Sources (one of):
 *   - selector + attr (default 'innerText')
 *   - selector + 'value' (for inputs)
 *   - script (eval) — like the eval action with `as`
 *
 * Transforms:
 *   trim, lower, upper, int, float, currency, regex:<pat> (returns first capture or full match)
 */
async function extract(s, args = {}) {
  const { selector, attr = 'innerText', as, transform, timeout = 10000 } = args;
  if (!as) throw new Error('extract requires `as` (var name)');
  if (!selector) throw new Error('extract requires `selector`');
  const loc = s.page.locator(selector).first();
  await loc.waitFor({ state: 'attached', timeout });
  let raw;
  if (attr === 'innerText' || attr === 'text') raw = await loc.innerText({ timeout });
  else if (attr === 'value') raw = await loc.inputValue({ timeout });
  else raw = await loc.getAttribute(attr);
  let value = (raw == null ? '' : String(raw)).trim();

  if (transform) {
    if (transform === 'trim') value = value.trim();
    else if (transform === 'lower') value = value.toLowerCase();
    else if (transform === 'upper') value = value.toUpperCase();
    else if (transform === 'int') value = parseInt(value.replace(/[^\d-]/g, ''), 10);
    else if (transform === 'float') value = parseFloat(value.replace(/\s/g, '').replace(',', '.'));
    else if (transform === 'currency') {
      // strip "R$ ", spaces, dots used as thousand separator; keep comma as decimal
      const s2 = value.replace(/R\$\s*/g, '').replace(/\s+/g, '').replace(/\./g, '').replace(',', '.');
      value = parseFloat(s2);
    } else if (transform.startsWith('regex:')) {
      const re = new RegExp(transform.slice(6));
      const m = value.match(re);
      value = m ? (m[1] !== undefined ? m[1] : m[0]) : '';
    }
  }

  appendEvent(s, { action: 'extract', args: { selector, attr, as, transform } });
  return { ok: true, extracted: { [as]: value } };
}

/**
 * Compare two values from the flow context. Throws on mismatch.
 *
 *   { action: "assert_eq", args: {
 *       actual: "${UI_VALUE}",
 *       expected: "${CFG.installmentValue}",
 *       compare: "numeric_equals",
 *       tolerance: 0.05,
 *       message: "parcela 21x deve igualar (basePrice*(1+fee))/21"
 *   } }
 *
 * Modes: equals | equals_ignore_case | numeric_equals | contains | regex_match | not_equals
 */
async function assertEq(s, args = {}) {
  const { actual, expected, compare = 'equals', tolerance = 0, message } = args;
  let pass = false;
  const a = actual == null ? '' : String(actual);
  const e = expected == null ? '' : String(expected);
  switch (compare) {
    case 'equals': pass = a === e; break;
    case 'not_equals': pass = a !== e; break;
    case 'equals_ignore_case': pass = a.toLowerCase() === e.toLowerCase(); break;
    case 'contains': pass = a.includes(e); break;
    case 'regex_match': try { pass = new RegExp(e).test(a); } catch (err) { pass = false; } break;
    case 'numeric_equals': {
      const an = parseFloat(a), en = parseFloat(e);
      pass = !isNaN(an) && !isNaN(en) && Math.abs(an - en) <= Number(tolerance);
      break;
    }
    default: throw new Error(`unknown compare mode: ${compare}`);
  }
  appendEvent(s, { action: 'assert_eq', args: { actual: a, expected: e, compare, tolerance, passed: pass } });
  if (!pass) {
    const detail = `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} compare=${compare}${tolerance ? ' tolerance='+tolerance : ''}`;
    throw new Error(message ? `${message} (${detail})` : `assert_eq failed: ${detail}`);
  }
  return { ok: true, passed: true };
}

async function read(s, args = {}) {
  const { selector, asText = true } = args;
  const value = await s.page.locator(selector).first().innerText().catch(() => null);
  return { ok: true, value };
}

/**
 * Smart toggle for checkboxes / consent boxes — including custom React components
 * that render as <button class="border-...">  (no real input, no role).
 *
 * Strategies tried in order:
 *  1. Playwright getByRole('checkbox', {name})
 *  2. Playwright getByLabel(text)
 *  3. CSS: input[type=checkbox] near text
 *  4. JS: find element containing text, walk up, click first <button> child
 *
 * After click, verifies state changed via aria-checked / class tokens (bg-blue-* etc).
 * Retries the next strategy if state didn't change.
 */
async function toggle(s, args = {}) {
  const { label, target, expectChecked = true, recordAs } = args;
  if (!label && !target) throw new Error('toggle requires label or target');

  const result = await s.page.evaluate(async ({ label, target, expectChecked }) => {
    const isCheckedNow = (el) => {
      if (!el) return null;
      // Real input
      if (el.tagName === 'INPUT' && el.type === 'checkbox') return el.checked;
      // Aria
      const a = el.getAttribute('aria-checked');
      if (a !== null) return a === 'true';
      // Class heuristics: bg-blue-*, bg-green-*, data-state=checked
      if (el.dataset?.state === 'checked') return true;
      if (el.dataset?.state === 'unchecked') return false;
      const cls = el.className || '';
      if (typeof cls === 'string') {
        if (/bg-(blue|green|primary|indigo|purple)-/.test(cls)) return true;
        if (/border-red-/.test(cls)) return false; // common required-but-empty pattern
      }
      return null;
    };

    const findCandidates = () => {
      const out = [];
      // 1. real checkboxes by aria-label
      if (label) {
        document.querySelectorAll('input[type=checkbox]').forEach(el => {
          if ((el.getAttribute('aria-label') || '').includes(label)) out.push(el);
        });
        // 2. role=checkbox
        document.querySelectorAll('[role=checkbox]').forEach(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.parentElement?.innerText || '');
          if (t.includes(label)) out.push(el);
        });
        // 3. label[for] association
        document.querySelectorAll('label').forEach(lab => {
          if (lab.innerText && lab.innerText.includes(label)) {
            const id = lab.getAttribute('for');
            const inp = id ? document.getElementById(id) : lab.querySelector('input');
            if (inp) out.push(inp);
            // also: button child of label container
            const btn = lab.parentElement?.querySelector('button');
            if (btn) out.push(btn);
          }
        });
        // 4. text walk: find element with the label text (including with inline children), go up, find first small button
        const all = Array.from(document.querySelectorAll('p, span, label, div, li'));
        const matches = all.filter(e => {
          const t = (e.innerText || '').trim();
          if (!t || !t.includes(label) || t.length > 400) return false;
          // Prefer elements where the label text dominates the contents
          return t.length < 400;
        });
        // Sort by shortest text (most specific match)
        matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        for (const m of matches.slice(0, 5)) {
          let cur = m;
          for (let i = 0; i < 5 && cur; i++) {
            const btns = cur.querySelectorAll?.('button') || [];
            for (const btn of btns) {
              const r = btn.getBoundingClientRect();
              // small (checkbox-sized) buttons; some are 24x24, some larger
              if (r.width > 0 && r.width < 60 && r.height > 0 && r.height < 60) {
                out.push(btn);
              }
            }
            // Also look for sibling button within same parent
            if (cur.parentElement) {
              const siblings = cur.parentElement.children;
              for (const s of siblings) {
                if (s.tagName === 'BUTTON') {
                  const r = s.getBoundingClientRect();
                  if (r.width > 0 && r.width < 60 && r.height > 0 && r.height < 60) out.push(s);
                }
              }
            }
            if (out.length > 0) break;
            cur = cur.parentElement;
          }
          if (out.length > 0) break;
        }
      }
      if (target) {
        try { document.querySelectorAll(target).forEach(el => out.push(el)); } catch {}
      }
      // dedupe + visible only
      return [...new Set(out)].filter(el => el.offsetParent !== null);
    };

    const cands = findCandidates();
    if (!cands.length) return { ok: false, error: 'no toggle candidates found' };

    for (const el of cands) {
      const before = isCheckedNow(el);
      if (before === expectChecked) return { ok: true, alreadyInState: true, strategy: el.tagName + (el.getAttribute('role') || '') };
      el.click();
      // Wait a tick for React
      await new Promise(r => setTimeout(r, 200));
      const after = isCheckedNow(el);
      if (after === expectChecked || (after === null && before === false)) {
        return { ok: true, strategy: el.tagName + (el.getAttribute('role') || ''), before, after };
      }
    }
    return { ok: false, error: `tried ${cands.length} candidates, none reached desired state`, candidates: cands.length };
  }, { label, target, expectChecked });

  if (!result.ok) throw new Error(`toggle failed: ${result.error} (label=${label || target})`);
  await s.page.waitForTimeout(200);
  const screenshot = await snapshot(s, `toggle-${(label || target || '').slice(0, 20)}`);
  appendEvent(s, { action: 'toggle', args: { label: recordAs != null ? recordAs : label, target, expect_checked: expectChecked }, screenshot });
  return { ok: true, screenshot, strategy: result.strategy };
}

/**
 * Open dialog handler: scroll to bottom (to enable confirm-after-scroll buttons),
 * then click the accept button.
 *
 * args: { title?, accept, scroll_to_end?: true, timeout?: 30000 }
 */
async function handleDialog(s, args = {}) {
  const { title, accept, scrollToEnd = true, timeout = 30000 } = args;
  if (!accept) throw new Error('dialog requires accept (button text)');

  // Wait for dialog to be open
  if (title) {
    await s.page.waitForFunction((t) => {
      const dialogs = Array.from(document.querySelectorAll('[role=dialog]'));
      return dialogs.some(d => d.getAttribute('data-state') === 'open' && (d.innerText || '').includes(t));
    }, title, { timeout });
  } else {
    await s.page.waitForSelector('[role=dialog][data-state="open"]', { timeout });
  }

  if (scrollToEnd) {
    // Scroll the dialog's scrollable inner container to the bottom and dispatch scroll events
    await s.page.evaluate(() => {
      const dialog = document.querySelector('[role=dialog][data-state="open"]');
      if (!dialog) return;
      const scrolls = Array.from(dialog.querySelectorAll('*')).filter(e => {
        const cs = getComputedStyle(e);
        return /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight;
      });
      for (const el of scrolls) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      // Also scroll the last child into view in case the dialog has no overflow but expects intersection observer
      const last = dialog.querySelectorAll('p, h1, h2, h3, li, div');
      if (last.length) last[last.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
    });
    await s.page.waitForTimeout(1500);
  }

  // Wait until the accept button becomes enabled
  await s.page.waitForFunction((acceptText) => {
    const btns = Array.from(document.querySelectorAll('[role=dialog][data-state="open"] button'));
    const b = btns.find(x => (x.innerText || '').trim().includes(acceptText));
    return b && !b.disabled;
  }, accept, { timeout: 15000 }).catch(() => null);

  // Click via locator scoped to the dialog
  const btn = s.page.locator('[role=dialog][data-state="open"]').locator(`button:has-text("${accept}")`).first();
  await btn.click({ timeout: 10000 });
  await s.page.waitForTimeout(300);

  const screenshot = await snapshot(s, `dialog-${accept.slice(0, 20)}`);
  appendEvent(s, { action: 'dialog', args: { title, accept, scroll_to_end: scrollToEnd }, screenshot });
  return { ok: true, screenshot };
}

/**
 * Generic post-condition checker. Used by replay.js after each step that has step.expect.
 * Returns { ok, error?, details? }.
 *
 * Supported expect shapes:
 *   { url_contains: "/dashboard" }
 *   { url_not_contains: "/contratacao" }
 *   { text_appears: "Solicitação enviada", timeout?: 10000 }
 *   { text_disappears: "Continuar", timeout?: 5000 }
 *   { selector_visible: "tbody tr", timeout?: 10000 }
 *   { dialog_open: true }
 *   { dialog_closed: true }
 */
async function verifyExpect(s, expect) {
  if (!expect || typeof expect !== 'object') return { ok: true };
  try {
    if (expect.url_contains !== undefined) {
      const t0 = Date.now(); const limit = expect.timeout || 5000;
      while (Date.now() - t0 < limit) {
        if (s.page.url().includes(expect.url_contains)) return { ok: true };
        await s.page.waitForTimeout(200);
      }
      return { ok: false, error: `url did not become "${expect.url_contains}" within ${limit}ms (current: ${s.page.url()})` };
    }
    if (expect.url_not_contains !== undefined) {
      if (s.page.url().includes(expect.url_not_contains)) return { ok: false, error: `url unexpectedly contains "${expect.url_not_contains}"` };
    }
    if (expect.text_appears !== undefined) {
      try {
        await s.page.waitForFunction((t) => (document.body.innerText || '').includes(t), expect.text_appears, { timeout: expect.timeout || 10000 });
        return { ok: true };
      } catch { return { ok: false, error: `text "${expect.text_appears}" did not appear within ${expect.timeout || 10000}ms` }; }
    }
    if (expect.text_disappears !== undefined) {
      try {
        await s.page.waitForFunction((t) => !(document.body.innerText || '').includes(t), expect.text_disappears, { timeout: expect.timeout || 5000 });
        return { ok: true };
      } catch { return { ok: false, error: `text "${expect.text_disappears}" still visible` }; }
    }
    if (expect.selector_visible !== undefined) {
      try {
        await s.page.locator(expect.selector_visible).first().waitFor({ state: 'visible', timeout: expect.timeout || 10000 });
        return { ok: true };
      } catch { return { ok: false, error: `selector "${expect.selector_visible}" not visible within ${expect.timeout || 10000}ms` }; }
    }
    if (expect.dialog_open) {
      const limit = expect.timeout || 10000;
      try {
        await s.page.waitForFunction(() => document.querySelectorAll('[role=dialog][data-state="open"]').length > 0, null, { timeout: limit });
      } catch { return { ok: false, error: `no dialog opened within ${limit}ms` }; }
    }
    if (expect.dialog_closed) {
      const limit = expect.timeout || 10000;
      try {
        await s.page.waitForFunction(() => document.querySelectorAll('[role=dialog][data-state="open"]').length === 0, null, { timeout: limit });
      } catch { return { ok: false, error: `dialog still open after ${limit}ms` }; }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resolveSelector({ target, text, label }) {
  if (target) return target;
  if (text) return `text=${text}`;
  if (label) return `[placeholder*="${label}"]`;
  throw new Error('action requires target | text | label');
}

module.exports = { goto, click, fill, selectOption, press, waitFor, waitMs, screenshotAction, snap, read, evalJs, toggle, handleDialog, verifyExpect, extract, assertEq };
