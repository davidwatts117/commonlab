import { contributorRequest, currentContributor } from './contributor-api.mjs';
const $ = id => document.getElementById(id);
let request, detailRequest, generation = 0, selected = null, before = null, ownerId = null;
const statusLabels = { pending: 'Pending review', published: 'Published', rejected: 'Rejected', withdrawn: 'Withdrawn' };
function updatedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function submissionCard(item) {
  const li = document.createElement('li'), button = document.createElement('button');
  button.type = 'button'; button.className = 'contribution-card'; button.dataset.id = item.id;
  button.setAttribute('aria-controls', 'contribution-detail'); button.setAttribute('aria-expanded', 'false');
  const title = document.createElement('span'); title.className = 'contribution-card-title'; title.textContent = item.title;
  const meta = document.createElement('span'); meta.className = 'contribution-card-meta';
  meta.textContent = `#${item.id} · Revision ${item.revision} · Updated ${updatedDate(item.updatedAt || item.createdAt)}`;
  const badges = document.createElement('span'); badges.className = 'contribution-badges';
  for (const [status, text] of [[item.status, statusLabels[item.status] || item.status], ...(item.publishedRevision ? [['live', `Live revision ${item.publishedRevision}`]] : [])]) {
    const badge = document.createElement('span'); badge.className = 'contribution-badge'; badge.dataset.status = status; badge.textContent = text; badges.append(badge);
  }
  button.append(title, meta, badges); button.addEventListener('click', () => showDetail(item)); li.append(button); return li;
}
function message(text, error = false) {
  $('contributions-status').textContent = text;
  $('contributions-status').setAttribute('role', error ? 'alert' : 'status');
}
function clearDetail() {
  selected = null; detailRequest?.abort();
  $('contribution-detail').hidden = true;
  $('contribution-placeholder').hidden = false;
  for (const button of $('contributions-list').querySelectorAll('button')) button.setAttribute('aria-expanded', 'false');
  for (const id of ['contribution-title', 'contribution-meta', 'contribution-feedback', 'contribution-history']) $(id).replaceChildren();
  $('contribution-edit').removeAttribute('href'); $('contribution-live').removeAttribute('href');
}
function clearPrivate() {
  clearDetail(); before = null;
  $('contributions-list').replaceChildren(); $('contributions-account').textContent = '';
  $('contributions-more').hidden = true; $('contributions-workspace').hidden = true;
  $('contributions-empty').hidden = true;
}
function lock() {
  ++generation; request?.abort(); clearPrivate(); ownerId = null;
  $('contributions-login').hidden = false; message('Sign in to view your submissions.');
}
async function showDetail(item) {
  clearDetail(); selected = item.id;
  const version = generation;
  detailRequest = new AbortController();
  $('contribution-title').textContent = `#${item.id} ${item.title}`;
  $('contribution-meta').textContent = `Revision ${item.revision}: ${item.status}. ${item.publishedRevision ? `Live revision ${item.publishedRevision} is published.` : 'No revision is currently published.'} Created ${item.createdAt}. Updated ${item.updatedAt || item.createdAt}.`;
  $('contribution-feedback').textContent = item.reviewNote ? `Latest maintainer note: ${item.reviewNote}` : 'No feedback on this revision yet; earlier feedback appears in the history.';
  $('contribution-edit').href = `/submit.html?edit=${item.id}`;
  $('contribution-live').hidden = !item.publishedRevision;
  // IDs come from schema-validated server records; encode even so, never use a supplied URL.
  $('contribution-live').href = `/simulations/${encodeURIComponent(item.simulationId)}`;
  $('contribution-detail').hidden = false; $('contribution-placeholder').hidden = true;
  for (const button of $('contributions-list').querySelectorAll('button')) button.setAttribute('aria-expanded', String(button.dataset.id === String(item.id)));
  $('contribution-title').tabIndex = -1; $('contribution-title').focus({ preventScroll: true });
  if (window.matchMedia('(max-width: 760px)').matches) $('contribution-detail').scrollIntoView({ block: 'start' });
  $('contribution-history').textContent = 'Loading review history…';
  try {
    const result = await contributorRequest(`/api/contributor/submissions/${item.id}/history`, { signal: detailRequest.signal });
    if (generation !== version || selected !== item.id) return;
    const events = result.events.map(event => {
      const li = document.createElement('li');
      li.textContent = `${event.createdAt} · revision ${event.revision} · ${event.actor}: ${event.action} → ${event.status}${event.note ? ` (${event.note})` : ''}`;
      return li;
    });
    if (!events.length) { const li = document.createElement('li'); li.textContent = 'No review events yet.'; events.push(li); }
    $('contribution-history').replaceChildren(...events);
    message(`Showing submission #${item.id}.`);
  } catch (error) {
    if (error.name === 'AbortError' || generation !== version || selected !== item.id) return;
    if (error.status === 401) lock(); else { $('contribution-history').textContent = 'Review history could not be loaded. Select this submission to try again.'; message(error.message, true); }
  }
}
async function refresh(append = false) {
  let cursor = append ? before : null;
  const version = ++generation;
  request?.abort(); request = new AbortController(); clearDetail();
  if (!append) clearPrivate();
  $('contributions-more').disabled = true;
  message('Loading your submissions…');
  try {
    const account = await currentContributor({ signal: request.signal });
    if (version !== generation) return;
    if (!account) { lock(); return; }
    if (ownerId !== account.id) { clearPrivate(); append = false; cursor = null; }
    ownerId = account.id;
    const query = new URLSearchParams({ status: $('contributions-filter').value });
    if (cursor) query.set('before', cursor);
    const result = await contributorRequest(`/api/contributor/submissions?${query}`, { signal: request.signal });
    if (version !== generation) return;
    $('contributions-account').textContent = `Signed in as ${account.username}. Only your submissions are shown.`;
    $('contributions-login').hidden = true; $('contributions-workspace').hidden = false;
    const rows = result.items.map(submissionCard);
    if (append) $('contributions-list').append(...rows); else $('contributions-list').replaceChildren(...rows);
    before = result.items.at(-1)?.id || cursor;
    $('contributions-more').hidden = !result.hasMore;
    const empty = !$('contributions-list').children.length;
    const filtered = $('contributions-filter').value !== 'all';
    $('contributions-empty').hidden = !empty;
    $('contribution-placeholder').hidden = empty;
    $('contributions-empty-title').textContent = filtered ? 'No submissions match this filter' : 'No submissions yet';
    $('contributions-empty-text').textContent = filtered ? 'Try another revision status or choose All statuses to see your submissions.' : 'Build your first simulation and submit it for review. Your saved submissions will appear here.';
    message(empty ? (filtered ? 'No submissions match this filter.' : 'No submissions yet. Create a simulation to get started.') : 'Select a submission to view feedback and history.');
  } catch (error) {
    if (error.name === 'AbortError' || version !== generation) return;
    if (error.status === 401) lock(); else { clearPrivate(); message(error.message, true); }
  } finally { if (version === generation) $('contributions-more').disabled = false; }
}
$('contributions-refresh').addEventListener('click', () => refresh());
$('contributions-filter').addEventListener('change', () => refresh());
$('contributions-more').addEventListener('click', () => refresh(true));
window.addEventListener('pagehide', lock);
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
window.addEventListener('focus', () => refresh());
await refresh();
