import { api } from '../core/state.js';
import { esc } from '../core/layout.js';

export async function renderSessions(slug) {
  // Sessions endpoint isn't exposed for listing — show informational view instead.
  // CLI is the primary recording interface for now.
  return `
    <div class="page-title"><h1>sessions</h1></div>
    <div class="card">
      <h3>recording sessions</h3>
      <p class="text-2 fs-12">
        sessions are live browser recordings used to author new flows. they're created via the CLI or the agent and are short-lived.
      </p>
      <p class="text-2 fs-12 mt-4">
        to start one:
      </p>
      <pre>pageflows project use ${esc(slug)}
pageflows session new
pageflows goto https://your-app.com
pageflows fill 'input[type=email]' 'test@x.com'
pageflows click "Continue"
pageflows save my-flow</pre>

      <p class="text-2 fs-12 mt-4">
        or let an LLM agent drive it autonomously:
      </p>
      <pre>pageflows agent run "describe what you want to test" --max-turns 25</pre>

      <p class="text-2 fs-12 mt-4">
        once saved, the flow appears in the <a href="#/p/${esc(slug)}/flows">flows tab</a> and runs deterministically forever.
      </p>
    </div>
  `;
}
