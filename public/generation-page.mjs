import { contributorRequest } from './contributor-api.mjs';
const $ = id => document.getElementById(id);
let request, generation = 0;
function message(text, error = false) { $('generation-status').textContent = text; $('generation-status').setAttribute('role', error ? 'alert' : 'status'); }
async function refresh() {
  const current = ++generation; request?.abort(); request = new AbortController();
  $('generation-jobs').replaceChildren(); $('generation-fields').disabled = true;
  try {
    const config = await contributorRequest('/api/generation/config', { signal: request.signal });
    const result = await contributorRequest('/api/generation/jobs', { signal: request.signal });
    if (current !== generation) return;
    $('generation-fields').disabled = !config.enabled || !config.allowed;
    message(!config.allowed ? 'Ask a maintainer to grant your account AI generation access.' : !config.enabled ? 'The operator has not configured the generation worker.' : 'Generation access enabled. Results are private drafts, not publications.');
    const rows = result.items.map(job => {
      const li = document.createElement('li'), label = document.createElement('p');
      label.textContent = `#${job.id} · ${job.status}${job.model ? ` · ${job.model}` : ''}${job.error ? ` — ${job.error}` : ''}`; li.append(label);
      if (job.status === 'succeeded') {
        const link = document.createElement('a'); link.href = `/submit.html?generation=${job.id}`; link.textContent = 'Open private draft in editor'; li.append(link);
      }
      if (['queued', 'running'].includes(job.status)) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Cancel request';
        button.addEventListener('click', async () => { button.disabled = true; try { await contributorRequest(`/api/generation/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(); } catch (error) { message(error.message, true); button.disabled = false; } });
        li.append(button);
      }
      return li;
    });
    $('generation-jobs').replaceChildren(...rows);
  } catch (error) { if (error.name !== 'AbortError' && current === generation) message(error.status === 401 ? 'Sign in through Account to view your requests.' : error.message, true); }
}
$('generation-form').addEventListener('submit', async event => {
  event.preventDefault(); $('generation-fields').disabled = true;
  try {
    await contributorRequest('/api/generation/jobs', { method: 'POST', body: { prompt: $('generation-prompt').value, acceptProviderProcessing: $('generation-consent').checked } });
    $('generation-prompt').value = ''; $('generation-consent').checked = false; await refresh();
  } catch (error) { message(error.message, true); $('generation-fields').disabled = false; }
});
$('generation-refresh').addEventListener('click', () => refresh());
window.addEventListener('focus', () => refresh());
window.addEventListener('pagehide', () => { ++generation; request?.abort(); $('generation-jobs').replaceChildren(); $('generation-form').reset(); $('generation-fields').disabled = true; message(''); });
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
await refresh();
