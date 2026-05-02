/**
 * Scheduler — polls scheduled_runs every minute and fires due replays.
 *
 * Granularity: 1 minute. We tick at the top of each wall-clock minute (so a
 * cron expression like "0 9 * * *" fires within seconds of 09:00:00 UTC, not
 * up to 60s later). The first tick is scheduled by computing the delay until
 * the next minute boundary; thereafter we run on a 60s setInterval.
 *
 * Each due schedule is launched fire-and-forget so a slow flow doesn't hold
 * up other schedules in the same minute. If a schedule somehow already fired
 * during this same minute (last_fired_at within current minute), we skip it
 * to avoid duplicate runs across hot reloads.
 */
const cron = require('./cron');
const llmLinter = require('./llm-linter');

let started = false;
let timer = null;

function start({ db, executeReplay, log = console.log }) {
  if (started) return;
  started = true;

  const tick = () => {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const rows = db.prepare(`
      SELECT id, project_id, flow_id, name, cron_expr, vars_json, last_fired_at
        FROM scheduled_runs
       WHERE enabled = 1
    `).all();

    for (const sched of rows) {
      let parsed;
      try { parsed = cron.parse(sched.cron_expr); }
      catch (e) {
        log(`[scheduler] schedule ${sched.id} has invalid cron "${sched.cron_expr}": ${e.message}`);
        continue;
      }
      if (!cron.matchesParsed(parsed, now)) continue;

      // Idempotence guard: if last_fired_at is in the current minute, skip.
      if (sched.last_fired_at && sched.last_fired_at.slice(0, 16) === minute) continue;

      // Mark fire-time *before* launching so a slow run doesn't double-fire.
      db.prepare(`UPDATE scheduled_runs SET last_fired_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sched.id);

      const overrides = sched.vars_json ? safeJson(sched.vars_json) : {};
      const meta = { projectId: sched.project_id, triggeredBy: `schedule:${sched.id}` };

      log(`[scheduler] firing schedule ${sched.id} (flow=${sched.flow_id}) at ${minute}`);
      executeReplay(sched.flow_id, overrides, null, meta).then((result) => {
        db.prepare(`UPDATE scheduled_runs SET last_run_id = ?, last_status = ?, last_error = NULL WHERE id = ?`)
          .run(result.runId || null, result.status || 'unknown', sched.id);
        if (result.runId && llmLinter.isEnabled()) {
          llmLinter.lintRun({ runId: result.runId, projectId: sched.project_id })
            .catch(e => log(`[scheduler] llm-lint failed for ${result.runId}: ${e.message}`));
        }
      }).catch((err) => {
        db.prepare(`UPDATE scheduled_runs SET last_status = 'failed', last_error = ? WHERE id = ?`)
          .run(String(err.message || err).slice(0, 500), sched.id);
        log(`[scheduler] schedule ${sched.id} failed: ${err.message}`);
      });
    }
  };

  // Fire the first tick at the next minute boundary (so logs and idempotence
  // align with the wall clock), then every 60s.
  const now = Date.now();
  const msToNextMinute = 60_000 - (now % 60_000);
  setTimeout(() => {
    tick();
    timer = setInterval(tick, 60_000);
  }, msToNextMinute);

  log(`[scheduler] started; first tick in ${(msToNextMinute / 1000).toFixed(1)}s`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { start, stop };
