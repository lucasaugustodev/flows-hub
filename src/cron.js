/**
 * Tiny 5-field cron parser + matcher. No deps.
 *
 * Format:  "minute hour day-of-month month day-of-week"
 * Each field accepts:
 *   - "*"           → every value
 *   - "N"           → exact value
 *   - "N-M"         → inclusive range
 *   - "X,Y,Z"       → list
 *   - "STAR/N" or "X-Y/N" → step
 *
 * Examples:
 *   "* * * * *"          every minute
 *   "0 * * * *"          top of every hour
 *   "0 9 * * 1-5"        9am Mon-Fri
 *   "0,30 * * * *"       :00 and :30 every hour
 *   "0 0 * * *"          midnight every day
 *
 * Matcher takes a Date and returns whether the expression fires at that minute.
 * Caller should tick once per minute and call .matches(expr, new Date()).
 */
const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month (1-12 — input)
  [0, 6],  // day-of-week (0=Sun, 6=Sat)
];

function parseField(field, [min, max]) {
  if (field === '*') return null; // null = match-any

  const out = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid cron field: "${field}"`);
    const range = m[1];
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step <= 0) throw new Error(`invalid cron step: "${field}"`);

    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(n => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      const v = parseInt(range, 10);
      lo = v; hi = v;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field "${part}" out of range [${min},${max}]`);
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

function parse(expr) {
  const trimmed = String(expr).trim();
  // Shorthand presets
  if (trimmed === '@hourly') return parse('0 * * * *');
  if (trimmed === '@daily' || trimmed === '@midnight') return parse('0 0 * * *');
  if (trimmed === '@weekly') return parse('0 0 * * 0');
  if (trimmed === '@monthly') return parse('0 0 1 * *');
  if (trimmed === '@yearly' || trimmed === '@annually') return parse('0 0 1 1 *');

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${fields.length}): "${trimmed}"`);
  }
  const [m, h, dom, mon, dow] = fields;
  return {
    minute: parseField(m, RANGES[0]),
    hour: parseField(h, RANGES[1]),
    dom: parseField(dom, RANGES[2]),
    month: parseField(mon, RANGES[3]),
    dow: parseField(dow, RANGES[4]),
    expr: trimmed,
  };
}

/** Return true if the parsed cron matches the given Date (minute granularity). */
function matchesParsed(p, date) {
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const d = date.getUTCDate();
  const mo = date.getUTCMonth() + 1; // 1-12
  const dw = date.getUTCDay();        // 0-6, Sun=0

  if (p.minute && !p.minute.has(m)) return false;
  if (p.hour && !p.hour.has(h)) return false;
  if (p.month && !p.month.has(mo)) return false;
  // Standard cron OR semantics for dom/dow when both restricted:
  // a date matches if it satisfies dom OR dow.
  const domSet = p.dom, dowSet = p.dow;
  if (domSet && dowSet) {
    if (!domSet.has(d) && !dowSet.has(dw)) return false;
  } else if (domSet) {
    if (!domSet.has(d)) return false;
  } else if (dowSet) {
    if (!dowSet.has(dw)) return false;
  }
  return true;
}

function matches(expr, date) {
  return matchesParsed(parse(expr), date);
}

/** Find the next time the cron will fire after the given Date (UTC minute granularity). */
function nextFiring(expr, after = new Date()) {
  const p = parse(expr);
  // Move to the next whole minute and search forward up to 1 year.
  const t = new Date(Math.ceil(after.getTime() / 60000) * 60000);
  if (t.getTime() === after.getTime()) t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (t <= limit) {
    if (matchesParsed(p, t)) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

module.exports = { parse, matches, matchesParsed, nextFiring };
