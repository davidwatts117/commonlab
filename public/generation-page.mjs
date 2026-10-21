import { contributorRequest } from './contributor-api.mjs';
const $ = id => document.getElementById(id);
const activity = {
  model_request: 'Asking the model to author or refine the draft…',
  model_first_response: 'Provider began responding.', model_streaming: 'Provider is streaming its response.',
  retrying: 'Retrying a bounded operation after a recoverable failure.',
  checkpointed: 'Accepted work saved privately.', resumed: 'Resuming saved work.',
  needs_attention: 'Candidate retained, but required checks remain unresolved. Manual attention needed.',
  review_unavailable: 'Independent review unavailable; no review pass recorded.',
  verification_unavailable: 'Browser verification could not run.', verification_failed: 'Required checks remain unresolved.',
  budget_exhausted: 'Shared model token or estimated-cost budget reached.',
  provider_first_timeout: 'Provider did not start responding in time.', provider_idle_timeout: 'Provider stream stalled.', provider_timeout: 'Provider call reached its time limit.',
  lease_lost: 'Worker lost its renewable lease.', worker_lost: 'Worker heartbeat expired.',
  inference_interrupted: 'Worker restarted during inference. Saved work retained; the potentially paid call was not repeated.',
  reference_contract: 'Reading the simulation authoring contract.', reference_schema: 'Reading the definition schema.',
  validating: 'Checking the current development stage.',
  validation_passed: 'Static validation passed.', validation_failed: 'Validation found problems; the agent can revise the draft.',
  finalized: 'Valid draft finalized for your review.', provider_error: 'The model provider request failed.',
  draft_ready: 'Draft accepted; rendering it in headless Chromium.', verifying: 'Rendering the engine and running its checks in headless Chromium.',
  visual_check_passed: 'Headless render and agent checks passed.', visual_check_failed: 'Headless render or agent checks failed; the agent is repairing the draft.',
  review_started: 'An independent adversarial reviewer is inspecting the result.', review_passed: 'Independent review found no blocking defects.',
  review_failed: 'Independent review filed defects; the agent is repairing the draft.',
  request_limit: 'Model request budget exhausted.', context_limit: 'Model context budget exceeded.',
  not_finalized: 'The agent stopped without finalizing a valid draft.', timeout: 'Absolute job deadline reached.',
  output_limit: 'Output size limit reached.', worker_error: 'The worker could not finish the request.',
  development_stage: 'Developing the next stage of the simulation.', stage_completed: 'Development stage accepted.', tool_result: 'Stage tool completed.',
  model_finished: 'Model response received.', repairing: 'Preparing a focused repair turn with the latest draft and diagnostics.',
  duplicate_draft: 'Unchanged invalid draft detected; cached diagnostics returned without revalidation.',
  tool_batch_rejected: 'Tool batch rejected before execution: only one draft submission per response is allowed.',
  provider_auth: 'Provider authentication failed.', provider_rate_limit: 'Provider rate, quota or billing limit reached.',
  provider_unavailable: 'Provider unavailable or timed out.', output_truncated: 'The model repeatedly exceeded its response-token limit.',
  repair_limit: 'Draft repair budget exhausted. See the remaining validation issues.', no_progress: 'Stopped because the agent was not making progress.',
  tool_protocol: 'Stopped after repeated tool-protocol violations.', configuration_error: 'Worker or model configuration is invalid.',
};
let request, generation = 0, selected = null, signature = '', timer, busy = false;
function message(text, error = false) { $('generation-status').textContent = text; $('generation-status').setAttribute('role', error ? 'alert' : 'status'); }
function node(tag, text) { const element = document.createElement(tag); element.textContent = text; return element; }
const rules = {
  required: 'Required field is missing.', type: 'Incorrect value type.', additionalProperties: 'Unsupported field; use only the schema fields.',
  enum: 'Choose a supported value from the schema.', const: 'Incorrect fixed value.', minimum: 'Below the minimum.', maximum: 'Above the maximum.',
  minLength: 'Text is empty or too short.', maxLength: 'Text is too long.', minItems: 'Too few items.', maxItems: 'Too many items.',
  pattern: 'Text does not match the required format.', oneOf: 'Does not match a supported variant.', anyOf: 'Does not match a supported variant.',
  schema: 'Does not satisfy the definition schema.', definition_size: 'Definition exceeds 64 KiB.', module_size: 'Engine exceeds 128 KiB.',
  assigned_id: 'Use the assigned simulation and assessment ID.', slot_ids: 'UI slot IDs must be unique, valid, and not reserved.',
  range: 'A control range, default or selection is invalid.', question_keys: 'Question references or answer keys are inconsistent.',
  lesson_references: 'Lesson references or conditions are inconsistent.', cross_field: 'Definition fields are inconsistent.',
  javascript_syntax: 'Engine JavaScript has a syntax error.', module_scope: 'Move initialization, constants and classes inside mount(ui).',
  imports: 'Engine imports are not allowed.', mount: 'Export one synchronous mount(ui) function with one parameter.',
};
function diagnostics(parent, details = {}) {
  const stats = [];
  for (const [key, label] of [['turn', 'Turn'], ['requests', 'Requests'], ['validations', 'Validations'], ['duplicates', 'Duplicates'], ['toolCalls', 'Tool calls'], ['inputTokens', 'Input tokens'], ['outputTokens', 'Output tokens'], ['maxTokens', 'Output budget'], ['verificationRounds', 'Render checks'], ['reviewRounds', 'Review rounds'], ['tests', 'Agent checks'], ['testsPassed', 'Checks passed'], ['testsFailed', 'Checks failed'], ['defects', 'Review defects']]) {
    if (Number.isInteger(details[key])) stats.push(`${label}: ${details[key]}`);
  }
  const phases = { preflight: 'Preflight', design: 'Science and UI design', build: 'Building artifacts', repair: 'Repairing artifacts', verify: 'Browser verification', review: 'Independent vision review', delivery: 'Saving result', complete: 'Verification complete', plan: 'Science plan', definition: 'Controls and definition', implementation: 'Engine implementation' };
  if (details.role) stats.push(`Role: ${details.role}`);
  if (details.cause) stats.push(`Cause: ${details.cause.replaceAll('_', ' ')}`);
  if (Number.isInteger(details.elapsedMs)) stats.push(`Elapsed: ${Math.round(details.elapsedMs / 1000)}s`);
  if (Number.isInteger(details.remainingMs)) stats.push(`Remaining: ${Math.round(details.remainingMs / 1000)}s`);
  if (Number.isInteger(details.costMicros)) stats.push(`Est. cost/reserved: $${(details.costMicros / 1e6).toFixed(4)}`);
  if (phases[details.phase]) stats.unshift(`Stage: ${phases[details.phase]}`);
  if (details.tool) stats.push(`Tool: ${details.tool}${details.toolStatus ? ` (${details.toolStatus})` : ''}`);
  if (details.stopReason) stats.push(`Stop: ${details.stopReason}`);
  if (Number.isInteger(details.contextBytes)) stats.push(`Context: ${(details.contextBytes / 1024).toFixed(1)} KiB`);
  if (stats.length) parent.append(node('p', stats.join(' · ')));
  if (Array.isArray(details.issues) && details.issues.length) {
    const issues = node('ul', '');
    for (const issue of details.issues) issues.append(node('li', `${issue.path || '/'}${Number.isInteger(issue.line) ? ` (line ${issue.line}, column ${issue.column || 0})` : ''}: ${rules[issue.rule] || 'Validation failed.'}`));
    parent.append(issues);
  }
}
async function refresh() {
  const current = ++generation; request?.abort(); request = new AbortController();
  const signal = request.signal;
  try {
    const config = await contributorRequest('/api/generation/config', { signal });
    const result = await contributorRequest('/api/generation/jobs', { signal });
    if (current !== generation) return;
    const active = result.items.some(job => ['queued', 'running'].includes(job.status));
    $('generation-fields').disabled = busy || !config.enabled || !config.allowed || active;
    message(!config.allowed ? 'Ask a maintainer to grant your account AI generation access.' : !config.enabled ? 'The operator has not configured the generation worker.' : active ? 'Your request is active. Follow its activity below; you can cancel while waiting.' : 'Generation access enabled. Results are private drafts, not publications.');
    if (selected === null) selected = result.items[0]?.id ?? null;
    const next = JSON.stringify(result.items);
    if (next !== signature) {
      signature = next;
      const rows = result.items.map(job => {
        const li = node('li', ''); li.append(node('p', `#${job.id} · ${job.status}${job.model ? ` · ${job.model}` : ''}`));
        if (job.error) li.append(node('p', job.error));
        const view = node('button', 'View activity'); view.type = 'button'; view.className = 'sim-btn sim-btn--soft';
        view.addEventListener('click', () => { selected = job.id; refresh(); }); li.append(view);
        if (['succeeded','needs_attention'].includes(job.status)) {
          const link = node('a', 'Open private draft in editor →'); link.href = `/submit.html?generation=${job.id}`; li.append(link);
        }
        if (['queued', 'running'].includes(job.status)) {
          const cancel = node('button', 'Cancel request'); cancel.type = 'button'; cancel.className = 'sim-btn sim-btn--soft';
          cancel.addEventListener('click', async () => { cancel.disabled = true; try { await contributorRequest(`/api/generation/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(); } catch (error) { message(error.message, true); cancel.disabled = false; } }); li.append(cancel);
        }
        return li;
      });
      $('generation-jobs').replaceChildren(...rows);
      if (!rows.length) $('generation-jobs').append(node('li', 'No requests yet. Describe a small, focused simulation to get started.'));
    }
    $('generation-activity').hidden = selected === null;
    if (selected !== null) {
      const events = await contributorRequest(`/api/generation/jobs/${selected}/events`, { signal });
      if (current !== generation) return;
      const job = result.items.find(item => item.id === selected);
      $('generation-detail-status').textContent = `Request #${selected} · ${job?.status || 'saved'}${job?.error ? `: ${job.error}` : job?.status === 'queued' ? '. Waiting for a worker; no model activity yet.' : ''}`;
      $('generation-summary').replaceChildren(); diagnostics($('generation-summary'), job?.diagnostics || {});
      if (job?.status === 'running' && job.heartbeatAt) $('generation-summary').append(node('p', `Last worker heartbeat: ${Math.max(0, Math.round(Date.now()/1000-job.heartbeatAt))}s ago. Deadline: ${new Date(job.deadlineAt*1000).toLocaleTimeString()}.`));
      if (job?.failureCode) $('generation-summary').append(node('p', activity[job.failureCode] || `Failure: ${job.failureCode}`));
      if (job?.report?.verification) $('generation-summary').append(node('p', `Verification: ${job.report.verification} · Independent review: ${job.report.review}`));
      if (job?.report?.testsSummary) $('generation-summary').append(node('p', `Checks: ${job.report.testsSummary.passed} passed, ${job.report.testsSummary.failed} failed (${job.report.testsSummary.total} total).`));
      if (Object.values(job?.report?.omitted || {}).some(n => n > 0)) $('generation-summary').append(node('p', 'This is a bounded report excerpt; additional evidence is retained in the private operator checkpoint.'));
      for (const finding of job?.report?.findings || []) $('generation-summary').append(node('p', `[${finding.severity}] ${finding.problem} Evidence: ${finding.evidence}`));
      for (const response of job?.report?.responses || []) $('generation-summary').append(node('p', `Finding ${response.id}: ${response.disposition}. ${response.evidence}`));
      for (const check of job?.report?.tests || []) if (!check.ok) $('generation-summary').append(node('p', `Failed check: ${check.name}${check.message ? ': '+check.message : ''}`));
      $('generation-events').replaceChildren(...events.items.map(event => {
        const li = node('li', `${new Date(event.createdAt * 1000).toLocaleTimeString()} · ${activity[event.code] || 'Working…'}`);
        diagnostics(li, event.details || {}); return li;
      }));
      if (!events.items.length) $('generation-events').append(node('li', 'No agent activity recorded yet. Older requests may not have an activity history.'));
    }
  } catch (error) {
    if (error.name !== 'AbortError' && current === generation) {
      $('generation-fields').disabled = true;
      message(error.status === 401 ? 'Sign in through Account to view your requests.' : `${error.message} Activity will refresh automatically.`, true);
      if (error.status === 401) { selected = null; signature = ''; $('generation-jobs').replaceChildren(); $('generation-activity').hidden = true; }
    }
  }
}
$('generation-form').addEventListener('submit', async event => {
  event.preventDefault(); busy = true; $('generation-fields').disabled = true;
  try {
    const job = await contributorRequest('/api/generation/jobs', { method: 'POST', body: { prompt: $('generation-prompt').value, acceptProviderProcessing: $('generation-consent').checked } });
    selected = job.id; $('generation-prompt').value = ''; $('generation-consent').checked = false;
    busy = false; await refresh();
  } catch (error) { busy = false; await refresh(); message(error.message, true); }
});
$('generation-refresh').addEventListener('click', () => refresh());
function start() { clearInterval(timer); timer = setInterval(() => { if (!document.hidden && !busy) refresh(); }, 3000); }
window.addEventListener('focus', () => refresh());
window.addEventListener('pagehide', () => { clearInterval(timer); ++generation; request?.abort(); selected = null; signature = ''; $('generation-jobs').replaceChildren(); $('generation-events').replaceChildren(); $('generation-summary').replaceChildren(); $('generation-activity').hidden = true; $('generation-form').reset(); $('generation-fields').disabled = true; message(''); });
window.addEventListener('pageshow', event => { if (event.persisted) { start(); refresh(); } });
start(); await refresh();
