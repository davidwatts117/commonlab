import { renderSimulation } from './simulation-ui.mjs';
const $ = id => document.getElementById(id);
let token = '', selected = null, preview = null, before = null, session;
function message(text, error = false) { $('review-status').textContent = text; $('review-status').setAttribute('role', error ? 'alert' : 'status'); }
function clearDetail() {
  selected = null; preview?.destroy(); preview = null;
  $('review-detail').hidden = true; $('review-preview-section').hidden = true;
  for (const id of ['review-definition', 'review-module', 'review-note']) $(id).value = '';
  $('review-title').textContent = ''; $('review-meta').textContent = ''; $('review-engine').textContent = '';
  $('code-reviewed').checked = false;
}
function lock() {
  session?.abort(); token = ''; before = null; clearDetail();
  $('admin-token').value = ''; $('review-queue').replaceChildren();
  $('review-workspace').hidden = true; $('review-login').hidden = false;
  message('Review queue locked. Enter your token to reopen it.');
}
async function api(path, options = {}) {
  const usedToken = token;
  if (!usedToken) throw new Error('Review queue is locked.');
  const response = await fetch(path, { ...options, credentials: 'omit', cache: 'no-store', signal: session.signal, headers: { Authorization: `Bearer ${usedToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const result = await response.json().catch(() => ({}));
  if (usedToken !== token) throw new Error('Review session changed.');
  if (!response.ok) {
    if (response.status === 401) lock();
    throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
  }
  return result;
}
async function loadQueue(append = false) {
  if (!append) { before = null; clearDetail(); $('review-queue').replaceChildren(); }
  const query = new URLSearchParams({ status: $('queue-status').value });
  if (before) query.set('before', before);
  const result = await api(`/api/admin/submissions?${query}`);
  for (const item of result.items) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sim-btn sim-btn--soft';
    button.textContent = `#${item.id} ${item.title} — ${item.simulationId}`;
    button.addEventListener('click', () => loadDetail(item.id).catch(error => message(error.message, true)));
    const meta = document.createElement('p'); meta.textContent = `${item.status} · ${item.createdAt} · ${item.submittedBy || 'Anonymous'} · ${item.hasCode ? 'New JavaScript' : 'Installed engine'}`;
    li.append(button, meta); $('review-queue').append(li); before = item.id;
  }
  $('more-submissions').hidden = !result.hasMore;
  message($('review-queue').children.length ? 'Select a submission to review.' : 'No submissions in this queue.');
}
async function loadDetail(id) {
  clearDetail();
  const item = await api(`/api/admin/submissions/${id}`);
  selected = item;
  $('review-title').textContent = `#${item.id} ${item.definition.title}`;
  $('review-meta').textContent = `${item.status} · revision ${item.revision} · ${item.submittedBy || 'Anonymous'}${item.hasPublication ? ` · live revision ${item.publishedRevision}` : ''}`;
  $('review-definition').value = JSON.stringify(item.definition, null, 2);
  $('review-module').value = item.moduleCode || '';
  $('review-module-section').hidden = !item.moduleCode;
  $('review-engine').textContent = item.engineId ? `Installed engine: ${item.engineId}. Check that this definition preserves its required slot IDs and adapter names.` : 'New engine code. Review source and every dependency before approving.';
  $('review-note').value = item.reviewNote;
  $('code-review-label').hidden = !item.moduleCode || item.status !== 'pending';
  $('code-reviewed').required = !!item.moduleCode && item.status === 'pending';
  $('publish-submission').hidden = item.status !== 'pending';
  $('reject-submission').hidden = item.status !== 'pending';
  $('reject-submission').formNoValidate = true;
  $('withdraw-submission').hidden = !item.hasPublication;
  $('withdraw-submission').formNoValidate = true;
  $('review-form').hidden = item.status !== 'pending' && !item.hasPublication;
  $('review-detail').hidden = false;
}
$('review-login').addEventListener('submit', async event => {
  event.preventDefault(); session?.abort(); session = new AbortController();
  token = $('admin-token').value.trim(); $('admin-token').value = '';
  try {
    await loadQueue(); $('review-workspace').hidden = false; $('review-login').hidden = true;
  } catch (error) { lock(); message(error.message, true); }
});
$('lock-queue').addEventListener('click', lock);
$('queue-status').addEventListener('change', () => loadQueue().catch(error => message(error.message, true)));
$('refresh-queue').addEventListener('click', () => loadQueue().catch(error => message(error.message, true)));
$('more-submissions').addEventListener('click', () => loadQueue(true).catch(error => message(error.message, true)));
$('review-preview-button').addEventListener('click', () => {
  try {
    if (!selected) return;
    preview?.destroy(); preview = renderSimulation($('review-preview'), selected.definition, { idPrefix: 'review-preview-' });
    $('review-preview-section').hidden = false; message('Layout preview only. No submitted code has run.');
  } catch (error) { message(error.message, true); }
});
$('review-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selected) return;
  const decision = event.submitter?.value; if (!decision) return;
  const id = selected.id;
  const buttons = [...$('review-form').querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await api(`/api/admin/submissions/${id}/review`, {
      method: 'POST', body: JSON.stringify({ decision, revision: selected.revision, codeReviewed: $('code-reviewed').checked, note: $('review-note').value }),
    });
    await loadQueue(); message(`Submission #${id} is now ${result.status}.`);
  } catch (error) { message(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
});
window.addEventListener('pagehide', lock);
