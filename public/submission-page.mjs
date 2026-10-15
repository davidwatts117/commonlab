import { loadCatalog, validateDefinition } from './simulation-schema.mjs';
import { renderSimulation } from './simulation-ui.mjs';
import { contributorRequest, currentContributor } from './contributor-api.mjs';
import { contentEditor } from './content-editor.mjs';
import { createBundle, parseBundle, submissionRequest, MAX_BUNDLE_BYTES } from './submission-bundle.mjs';

const $ = id => document.getElementById(id);
const MAX_DEFINITION = 64 * 1024, MAX_MODULE = 128 * 1024;
const byteLength = text => new TextEncoder().encode(text).length;
const status = $('authoring-status');
let catalog, preview, enabled = false, installedIds = [], signedIn = false, editing = null;
async function refreshContributor() {
  const account = await currentContributor(); signedIn = !!account;
  $('contributor-status').textContent = account ? `Signed in as ${account.username}. New submissions belong to your account.` : 'Sign in or create a contributor account to submit. You can still draft and download without an account.';
  $('submit-draft').disabled = !enabled || !signedIn;
}
const editors = contentEditor($('content-editor'), editDraft, error => message(error, true));
function message(text, error = false) { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); }
function readDraft() {
  if (byteLength($('definition-json').value) > MAX_BUNDLE_BYTES) throw new Error('Definition editor text exceeds 1 MiB.');
  let definition;
  try { definition = JSON.parse($('definition-json').value); }
  catch (error) { throw new Error(`Definition JSON could not be parsed: ${error.message}`, { cause: error }); }
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('Definition must be an object.');
  return definition;
}
function readDefinition() {
  const def = readDraft();
  if (byteLength(JSON.stringify(def)) > MAX_DEFINITION) throw new Error('Definition exceeds 64 KiB.');
  return validateDefinition(def);
}
function writeDefinition(def) {
  $('definition-json').value = JSON.stringify(def, null, 2);
  for (const key of ['id', 'title', 'subject', 'summary']) $(`definition-${key}`).value = def[key] ?? '';
  $('canvas-width').value = def.canvas?.width ?? '';
  $('canvas-height').value = def.canvas?.height ?? '';
  editors.render(def);
}
function editDraft(edit, refresh = false) {
  try {
    const def = readDraft(); edit(def);
    $('definition-json').value = JSON.stringify(def, null, 2);
    if (refresh) editors.render(def);
    message('Draft updated. Validate before downloading or submitting; unfinished fields may still need attention.');
    return true;
  } catch (error) { message(error.message, true); return false; }
}
function metadataChanged() {
  try {
    const def = JSON.parse($('definition-json').value);
    const oldId = def.id;
    for (const key of ['id', 'title', 'subject', 'summary']) def[key] = $(`definition-${key}`).value;
    if (def.assessment?.id === oldId) def.assessment.id = def.id;
    for (const lesson of def.lessons || []) lesson.sim = def.id;
    def.canvas.width = Number($('canvas-width').value); def.canvas.height = Number($('canvas-height').value);
    $('definition-json').value = JSON.stringify(def, null, 2);
    editors.render(def);
  } catch { message('Fix the definition JSON before editing metadata.', true); }
}
for (const id of ['definition-id', 'definition-title', 'definition-subject', 'definition-summary', 'canvas-width', 'canvas-height']) $(id).addEventListener('input', metadataChanged);
$('definition-json').addEventListener('change', () => {
  try { writeDefinition(JSON.parse($('definition-json').value)); } catch { message('Definition is not valid JSON.', true); }
});

const starter = `// Replace this example with your physics and canvas drawing.
export function mount(ui) {
  const { width, height } = ui.definition.canvas;
  class NewSimulation extends SimLib.Simulation {
    onInit() { this.time = 0; }
    onTick(dt) { this.time += dt; }
    onDraw(ctx) {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#166534';
      ctx.beginPath();
      ctx.arc(width / 2 + 80 * Math.sin(this.time), height / 2, 18, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  const app = SimLib.attach({
    canvas: ui.getElementById(ui.definition.canvas.id),
    logicalWidth: width, logicalHeight: height, SimulationClass: NewSimulation,
  });
  app.sim.start();
  return { app };
}
`;
function loadTemplate() {
  const engine = $('engine').value;
  const def = engine === 'new' ? {
    id: 'new-lab', title: 'New science lab', subject: 'physics', summary: 'Describe what learners will investigate.',
    canvas: { id: 'labCanvas', label: 'Science simulation', width: 700, height: 480 },
    controls: [], cards: [], graphs: [], lessons: [],
  } : structuredClone(catalog.simulations.find(def => def.id === engine));
  // Only installed engines are offered; published community modules are never authoring templates.
  if (engine !== 'new') {
    def.id = `community-${def.id}`;
    if (def.assessment) def.assessment.id = def.id;
    for (const lesson of def.lessons) lesson.sim = def.id;
  }
  if (editing) {
    def.id = editing.simulationId;
    if (def.assessment) def.assessment.id = def.id;
    for (const lesson of def.lessons) lesson.sim = def.id;
  }
  writeDefinition(def);
  $('module-section').hidden = engine !== 'new';
  if (!$('module-code').value) $('module-code').value = starter;
  preview?.destroy(); $('preview-section').hidden = true;
}
$('engine').addEventListener('change', loadTemplate);

function editDefinition(edit) { editDraft(edit, true); }
function newSlot(def, prefix) {
  const used = new Set();
  const walk = value => { if (!value || typeof value !== 'object') return; if (value.id) used.add(value.id); Object.values(value).forEach(walk); };
  walk(def);
  let n = 1; while ([...used].some(id => id.startsWith(`${prefix}${n}`))) n++;
  return `${prefix}${n}`;
}
$('add-component').addEventListener('click', () => editDefinition(def => {
  const type = $('component-type').value, id = newSlot(def, type);
  const button = { id: `${id}Button`, label: 'Run', variant: 'primary' };
  const output = { id: `${id}Value`, text: '0' };
  const options = [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }];
  const choices = {
    slider: { type, id, label: 'Parameter', min: 0, max: 10, step: 0.1, value: 1, output },
    actions: { type, buttons: [button] },
    choices: { type, id, label: 'Mode', style: 'segments', options, value: 'first' },
    select: { type, id, label: 'Mode', options, value: 'first' },
    readouts: { type, id, items: [{ id: output.id, label: 'Measurement', value: '0', tone: 'default' }] },
    text: { type, id, text: 'Add learner instructions here.' },
    stepper: { type, label: 'Count', output, increase: button },
    meter: { type, id, label: 'Measurement', output, ticks: ['Low', 'High'] },
  };
  def.controls.push(choices[type]);
}));
$('add-card').addEventListener('click', () => editDefinition(def => def.cards.push({ title: 'Science explanation', formulas: ['F = ma'], paragraphs: ['Explain the relationship learners are exploring.'] })));
$('add-graph').addEventListener('click', () => editDefinition(def => def.graphs.push({ id: newSlot(def, 'graph'), label: 'Measurement graph', width: 700, height: 240 })));

async function importText(input, target, max) {
  const file = input.files[0]; if (!file) return;
  if (file.size > max) throw new Error(`File exceeds ${max / 1024} KiB.`);
  $(target).value = await file.text();
}
$('definition-file').addEventListener('change', async event => {
  try { await importText(event.target, 'definition-json', MAX_BUNDLE_BYTES); writeDefinition(readDefinition()); message('Definition imported. Select the matching installed engine or provide new code.'); }
  catch (error) { message(error.message, true); }
});
$('module-file').addEventListener('change', async event => {
  try { await importText(event.target, 'module-code', MAX_MODULE); message('Module imported as text. No code has been run.'); }
  catch (error) { message(error.message, true); }
});
$('validate-preview').addEventListener('click', () => {
  try {
    const def = readDefinition(); preview?.destroy();
    preview = renderSimulation($('definition-preview'), def, { idPrefix: 'author-preview-' });
    $('preview-title').textContent = `${def.title} — ${def.summary}`;
    $('preview-section').hidden = false;
    message('Definition validated. The layout is shown below; physics, lessons, and checks are not running.');
  } catch (error) { message(error.message, true); }
});
function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function currentBundle() {
  const source = $('engine').value === 'new' ? { kind: 'javascript', moduleCode: $('module-code').value } : { kind: 'installed', engineId: $('engine').value };
  const def = readDefinition();
  if (editing && def.id !== editing.simulationId) throw new Error('Keep the original simulation ID when editing this submission.');
  const oldBank = editing?.original.assessment;
  if (oldBank && def.assessment && oldBank.id === def.assessment.id && JSON.stringify(oldBank) !== JSON.stringify(def.assessment) && def.assessment.version <= oldBank.version) {
    def.assessment.version = oldBank.version + 1; writeDefinition(def);
  }
  return createBundle(def, source, $('submitted-by').value, installedIds);
}
function setEditing(item) {
  editing = { id: item.id, revision: item.revision, simulationId: item.definition.id, original: structuredClone(item.definition) };
  $('definition-id').readOnly = true;
  $('submit-draft').textContent = 'Save revision for review';
  document.querySelector('h1').textContent = `Edit submission #${item.id}`;
  $('editing-status').textContent = `Revision ${item.revision} · ${item.status}${item.hasPublication ? ` · live revision ${item.publishedRevision} stays unchanged until approval` : ''}. ${item.reviewNote || ''}`;
}
async function loadEditing(id) {
  const item = await contributorRequest(`/api/contributor/submissions/${id}`);
  setEditing(item);
  $('engine').value = item.engineId && installedIds.includes(item.engineId) ? item.engineId : 'new';
  $('module-code').value = item.moduleCode || '';
  $('module-section').hidden = $('engine').value !== 'new';
  $('submitted-by').value = item.submittedBy; writeDefinition(item.definition);
}
$('export-definition').addEventListener('click', () => {
  try { const def = readDefinition(); downloadJSON(def, `${def.id}.json`); }
  catch (error) { message(error.message, true); }
});
$('export-bundle').addEventListener('click', () => {
  try { const bundle = currentBundle(); downloadJSON(bundle, `${bundle.definition.id}.submission.json`); message('Submission bundle downloaded, including engine source. Store it privately; no draft was saved in browser storage.'); }
  catch (error) { message(error.message, true); }
});
$('bundle-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) throw new Error('Submission bundle exceeds 1 MiB.');
    const bundle = parseBundle(await file.text(), installedIds);
    $('engine').value = bundle.source.kind === 'installed' ? bundle.source.engineId : 'new';
    $('module-code').value = bundle.source.moduleCode || '';
    $('module-section').hidden = bundle.source.kind !== 'javascript';
    $('submitted-by').value = bundle.submittedBy;
    writeDefinition(bundle.definition);
    preview?.destroy(); $('preview-section').hidden = true;
    message('Complete submission restored. Engine source is text only; no code has run.');
  } catch (error) { message(error.message, true); }
  finally { event.target.value = ''; }
});
$('submission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!enabled || !signedIn) return;
  const button = $('submit-draft'); button.disabled = true;
  try {
    const payload = submissionRequest(currentBundle(), installedIds);
    const wasEditing = !!editing;
    const result = await contributorRequest(editing ? `/api/contributor/submissions/${editing.id}` : '/api/submissions', { method: editing ? 'PUT' : 'POST', body: { ...payload, ...(editing ? { revision: editing.revision } : {}) } });
    setEditing({ ...result, definition: payload.definition });
    history.replaceState(null, '', `/submit.html?edit=${result.id}`);
    message(wasEditing ? `Revision ${result.revision} saved and resubmitted for review. Any published revision remains unchanged until approval.` : `Submission #${result.id} received and awaiting review. Your account owns this submission. Download your complete bundle as a local backup.`);
  } catch (error) { message(error.message, true); }
  finally { button.disabled = !enabled || !signedIn; }
});

try {
  // The server allowlist below excludes community code from reusable engine templates.
  const response = await fetch('/api/submissions/config');
  const config = response.ok ? await response.json() : { enabled: false };
  enabled = config.enabled;
  catalog = await loadCatalog();
  const installed = await fetch('/api/submissions/engines');
  // A static deployment still supports drafting/exporting; only server-listed engines are submitted.
  installedIds = installed.ok ? (await installed.json()).ids : catalog.simulations.map(def => def.id);
  $('engine').replaceChildren(...catalog.simulations.filter(def => installedIds.includes(def.id)).map(def => {
    const option = document.createElement('option'); option.value = def.id; option.textContent = def.title; return option;
  }));
  const option = document.createElement('option'); option.value = 'new'; option.textContent = 'New JavaScript engine'; $('engine').append(option);
  loadTemplate(); await refreshContributor();
  const requested = new URLSearchParams(location.search).get('edit');
  if (requested !== null) {
    if (!/^[1-9][0-9]*$/.test(requested) || !Number.isSafeInteger(Number(requested))) throw new Error('Invalid submission ID.');
    await loadEditing(requested);
  }
  $('submission-fields').disabled = false;
  message(requested ? 'Saved source loaded as text. Make changes and save a new revision for review.' : enabled ? 'Submissions are open. Start from a template or choose a new engine.' : 'Server submissions are unavailable. You can still build, preview, and download a definition.');
} catch (error) { message(`Unable to load the authoring interface: ${error.message}`, true); }
window.addEventListener('pagehide', () => {
  preview?.destroy();
  if (editing) { $('submission-form').reset(); $('content-editor').replaceChildren(); $('submission-fields').disabled = true; }
});
window.addEventListener('pageshow', event => { if (event.persisted && editing) location.reload(); });
window.addEventListener('focus', () => { refreshContributor().catch(error => message(error.message, true)); });
