import { loadCatalog, validateDefinition } from './simulation-schema.mjs';
import { renderSimulation } from './simulation-ui.mjs';

const $ = id => document.getElementById(id);
const MAX_DEFINITION = 64 * 1024, MAX_MODULE = 128 * 1024;
const byteLength = text => new TextEncoder().encode(text).length;
const status = $('authoring-status');
let catalog, preview, enabled = false;
function message(text, error = false) { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); }
function readDefinition() {
  if (byteLength($('definition-json').value) > MAX_DEFINITION) throw new Error('Definition exceeds 64 KiB.');
  let definition;
  try { definition = JSON.parse($('definition-json').value); }
  catch (error) { throw new Error(`Definition JSON could not be parsed: ${error.message}`, { cause: error }); }
  return validateDefinition(definition);
}
function writeDefinition(def) {
  $('definition-json').value = JSON.stringify(def, null, 2);
  for (const key of ['id', 'title', 'subject', 'summary']) $(`definition-${key}`).value = def[key] ?? '';
  $('canvas-width').value = def.canvas?.width ?? '';
  $('canvas-height').value = def.canvas?.height ?? '';
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
  writeDefinition(def);
  $('module-section').hidden = engine !== 'new';
  if (!$('module-code').value) $('module-code').value = starter;
  preview?.destroy(); $('preview-section').hidden = true;
}
$('engine').addEventListener('change', loadTemplate);

function editDefinition(edit) {
  try { const def = readDefinition(); edit(def); writeDefinition(def); message('Definition updated. Edit its values in the JSON editor, then validate the layout.'); }
  catch (error) { message(error.message, true); }
}
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
  try { await importText(event.target, 'definition-json', MAX_DEFINITION); writeDefinition(readDefinition()); message('Definition imported. Select the matching installed engine or provide new code.'); }
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
$('export-definition').addEventListener('click', () => {
  try {
    const def = readDefinition();
    const url = URL.createObjectURL(new Blob([JSON.stringify(def, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${def.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message(error.message, true); }
});
$('submission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!enabled) return;
  const button = $('submit-draft'); button.disabled = true;
  try {
    const definition = readDefinition();
    const engine = $('engine').value;
    const moduleCode = $('module-code').value;
    if (engine === 'new' && (!moduleCode.trim() || byteLength(moduleCode) > MAX_MODULE)) throw new Error('Provide a nonempty JavaScript module of at most 128 KiB.');
    const response = await fetch('/api/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ definition, submittedBy: $('submitted-by').value, ...(engine === 'new' ? { moduleCode } : { engineId: engine }) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Submission failed (HTTP ${response.status}).`);
    message(`Submission #${result.id} received and awaiting review. It is not public yet. Save your definition locally; anonymous submissions cannot be edited or retrieved later.`);
  } catch (error) { message(error.message, true); }
  finally { button.disabled = !enabled; }
});

try {
  // The server allowlist below excludes community code from reusable engine templates.
  const response = await fetch('/api/submissions/config');
  const config = response.ok ? await response.json() : { enabled: false };
  enabled = config.enabled;
  catalog = await loadCatalog();
  const installed = await fetch('/api/submissions/engines');
  // A static deployment still supports drafting/exporting; only server-listed engines are submitted.
  const engineIds = installed.ok ? (await installed.json()).ids : catalog.simulations.map(def => def.id);
  $('engine').replaceChildren(...catalog.simulations.filter(def => engineIds.includes(def.id)).map(def => {
    const option = document.createElement('option'); option.value = def.id; option.textContent = def.title; return option;
  }));
  const option = document.createElement('option'); option.value = 'new'; option.textContent = 'New JavaScript engine'; $('engine').append(option);
  loadTemplate(); $('submission-fields').disabled = false; $('submit-draft').disabled = !enabled;
  message(enabled ? 'Submissions are open. Start from a template or choose a new engine.' : 'Server submissions are unavailable. You can still build, preview, and download a definition.');
} catch (error) { message(`Unable to load the authoring interface: ${error.message}`, true); }
window.addEventListener('pagehide', () => preview?.destroy());
