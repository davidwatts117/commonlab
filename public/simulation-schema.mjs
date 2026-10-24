// The simulation UI is a closed set of components, not an HTML/template escape hatch.
const fail = message => { throw new Error(`Simulation definition: ${message}`); };
const slug = value => typeof value === 'string' && value.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
function object(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${context} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${context}: unknown field ${key}`);
}
function text(value, context, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) fail(`${context} must be text`);
}
function list(value, context) { if (!Array.isArray(value)) fail(`${context} must be an array`); }
function boolean(value, context) { if (value !== undefined && typeof value !== 'boolean') fail(`${context} must be boolean`); }
function number(value, context) { if (!Number.isFinite(value)) fail(`${context} must be a finite number`); }
function strings(value, context) { list(value, context); value.forEach(x => text(x, context)); }

export function validateDefinition(def) {
  object(def, ['id', 'title', 'subject', 'summary', 'canvas', 'controls', 'cards', 'graphs', 'lessons', 'assessment', 'info', 'views'], 'simulation');
  if (!slug(def.id)) fail('id must be a lowercase slug');
  text(def.title, 'title'); text(def.summary, 'summary');
  if (!['physics', 'chemistry'].includes(def.subject)) fail('subject must be physics or chemistry');
  const ids = new Set();
  const reservedIds = new Set(['simulation-root', 'simulation-title', 'simulation-summary', 'simulation-status', 'lesson-launcher']);
  let canvasPixels = 0;
  function id(value) {
    if (!identifier(value) || reservedIds.has(value) || ids.has(value)) fail(`invalid, reserved, or duplicate slot id: ${value}`);
    ids.add(value);
  }
  function output(value) {
    object(value, ['id', 'text'], 'output'); id(value.id); text(value.text, 'output text', true);
  }
  function button(value) {
    object(value, ['id', 'label', 'variant', 'active', 'pressed'], 'button');
    id(value.id); text(value.label, 'button label');
    if (!['primary', 'ghost', 'soft', 'outline', 'display'].includes(value.variant)) fail('unknown button variant');
    boolean(value.active, 'active'); boolean(value.pressed, 'pressed');
  }
  function options(value, selection, max = 30) {
    list(value, 'options');
    if (value.length < 2 || value.length > max) fail(`between two and ${max} options required`);
    const seen = new Set();
    for (const option of value) {
      object(option, ['value', 'label'], 'option'); text(option.value, 'option value'); text(option.label, 'option label');
      if (seen.has(option.value)) fail('duplicate option value');
      seen.add(option.value);
    }
    if (!seen.has(selection)) fail('initial selection is not an option');
    return seen;
  }
  function range(value, context) {
    for (const key of ['min', 'max', 'step', 'value']) number(value[key], key);
    if (value.min >= value.max || value.step <= 0 || value.value < value.min || value.value > value.max) fail(`invalid ${context} range/default`);
  }
  function components(value, context) {
    list(value, context);
    if (value.length > 10) fail(`${context} allows at most 10 components`);
    value.forEach(component);
  }
  function canvas(value, primary = false) {
    object(value, primary ? ['id', 'label', 'width', 'height'] : ['id', 'label', 'width', 'height', 'legend', 'caption', 'controls', 'view'], 'canvas');
    id(value.id); text(value.label, 'canvas label');
    for (const dimension of ['width', 'height']) {
      if (!Number.isInteger(value[dimension]) || value[dimension] < 1 || value[dimension] > 4096) fail('canvas dimensions must be integers from 1 to 4096');
    }
    canvasPixels += value.width * value.height;
    if (canvasPixels > 16_777_216) fail('combined canvas area exceeds 16,777,216 pixels');
    if (value.caption !== undefined) text(value.caption, 'caption');
    if (value.legend !== undefined) {
      list(value.legend, 'legend');
      for (const item of value.legend) {
        object(item, ['label', 'color'], 'legend item'); text(item.label, 'legend label');
        if (typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)) fail('legend color must be a six-digit hex color');
      }
    }
    if (value.controls !== undefined) components(value.controls, 'graph controls');
    if (value.view !== undefined && !views?.has(value.view)) fail('graph view must be one of the declared views');
  }
  function component(control) {
    switch (control?.type) {
      case 'slider':
        object(control, ['type', 'id', 'label', 'min', 'max', 'step', 'value', 'output', 'icons', 'info'], 'slider');
        id(control.id); text(control.label, 'slider label'); range(control, 'slider');
        if (control.output) output(control.output);
        if (control.icons) { list(control.icons, 'icons'); if (control.icons.length !== 2) fail('slider has two icons'); control.icons.forEach(output); }
        if (control.info !== undefined && (!def.info || !Object.hasOwn(def.info, control.info))) fail('unknown info reference');
        break;
      case 'number':
        object(control, ['type', 'id', 'label', 'min', 'max', 'step', 'value', 'unit', 'hint'], 'number');
        id(control.id); text(control.label, 'number label'); range(control, 'number');
        if (control.unit !== undefined) text(control.unit, 'unit');
        if (control.hint) output(control.hint);
        break;
      case 'actions':
        object(control, ['type', 'buttons'], 'actions'); list(control.buttons, 'buttons'); control.buttons.forEach(button);
        break;
      case 'choices':
      case 'select':
        object(control, control.type === 'choices' ? ['type', 'id', 'label', 'style', 'options', 'value'] : ['type', 'id', 'label', 'options', 'value'], control.type);
        id(control.id); text(control.label, 'choice label'); options(control.options, control.value);
        if (control.type === 'choices' && !['toolbar', 'segments', 'chips'].includes(control.style)) fail('unknown choice style');
        break;
      case 'toggles':
        object(control, ['type', 'id', 'items'], 'toggles'); if (control.id !== undefined) id(control.id);
        list(control.items, 'toggle items');
        if (!control.items.length || control.items.length > 20) fail('toggles need one to 20 items');
        for (const item of control.items) {
          object(item, ['id', 'label', 'checked'], 'toggle'); id(item.id); text(item.label, 'toggle label'); boolean(item.checked, 'checked');
        }
        break;
      case 'readouts':
        object(control, ['type', 'id', 'hidden', 'items'], 'readouts'); if (control.id !== undefined) id(control.id);
        boolean(control.hidden, 'hidden'); list(control.items, 'readout items');
        if (!control.items.length) fail('readouts cannot be empty');
        for (const item of control.items) {
          object(item, ['id', 'label', 'value', 'tone'], 'readout'); id(item.id); text(item.label, 'readout label'); text(item.value, 'readout value', true);
          if (!['default', 'highlight', 'success'].includes(item.tone)) fail('unknown readout tone');
        }
        break;
      case 'text':
        object(control, ['type', 'id', 'label', 'text', 'style', 'hidden'], 'text'); if (control.id !== undefined) id(control.id);
        text(control.text, 'text', true); if (control.label !== undefined) text(control.label, 'text label');
        if (control.style !== undefined && !['note', 'message', 'alert'].includes(control.style)) fail('unknown text style');
        boolean(control.hidden, 'hidden');
        break;
      case 'panel':
        object(control, ['type', 'id', 'label', 'text'], 'panel'); id(control.id);
        text(control.text, 'panel text', true); if (control.label !== undefined) text(control.label, 'panel label');
        break;
      case 'table':
        object(control, ['type', 'id', 'label', 'columns', 'empty', 'hidden'], 'table'); id(control.id);
        if (control.label !== undefined) text(control.label, 'table label');
        list(control.columns, 'columns');
        if (!control.columns.length || control.columns.length > 10) fail('tables need one to 10 columns');
        for (const column of control.columns) {
          object(column, ['id', 'label'], 'column'); if (column.id !== undefined) id(column.id); text(column.label, 'column label');
        }
        if (control.empty) output(control.empty);
        boolean(control.hidden, 'hidden');
        break;
      case 'dock':
        object(control, ['type', 'readout', 'swatch', 'buttons'], 'dock');
        if (control.readout) {
          object(control.readout, ['id', 'label', 'value'], 'dock readout'); id(control.readout.id);
          output(control.readout.label); text(control.readout.value, 'dock readout value', true);
        }
        if (control.swatch !== undefined) { object(control.swatch, ['id'], 'dock swatch'); id(control.swatch.id); }
        list(control.buttons, 'dock buttons');
        if (!control.buttons.length || control.buttons.length > 5) fail('docks need one to five buttons');
        control.buttons.forEach(button);
        break;
      case 'stepper':
        object(control, ['type', 'label', 'output', 'decrease', 'increase'], 'stepper'); text(control.label, 'stepper label'); output(control.output);
        if (control.decrease) button(control.decrease); button(control.increase);
        break;
      case 'meter':
        object(control, ['type', 'id', 'label', 'output', 'ticks'], 'meter'); id(control.id); text(control.label, 'meter label'); output(control.output); strings(control.ticks, 'ticks');
        break;
      default: fail(`unknown component type: ${control?.type}`);
    }
  }
  // Views are fullscreen tabs: the first shows the main canvas and controls; graphs may name another.
  let views = null;
  if (def.views !== undefined) {
    object(def.views, ['id', 'value', 'options'], 'views'); id(def.views.id);
    views = options(def.views.options, def.views.value, 6);
  }
  canvas(def.canvas, true);
  list(def.controls, 'controls');
  def.controls.forEach(component);
  list(def.graphs, 'graphs'); def.graphs.forEach(value => canvas(value));
  list(def.cards, 'cards');
  for (const card of def.cards) {
    object(card, ['title', 'formulas', 'paragraphs', 'components'], 'card'); text(card.title, 'card title'); strings(card.formulas, 'formulas'); strings(card.paragraphs, 'paragraphs');
    if (card.components !== undefined) components(card.components, 'card components');
  }
  if (def.info !== undefined) {
    if (!def.info || typeof def.info !== 'object' || Array.isArray(def.info)) fail('info must be a map');
    for (const [key, value] of Object.entries(def.info)) {
      if (!slug(key)) fail('invalid info key');
      object(value, ['title', 'formula', 'explanation', 'detail'], 'info');
      for (const field of ['title', 'formula', 'explanation', 'detail']) text(value[field], field);
    }
  }
  if (def.assessment !== undefined) validateBank(def.assessment);
  list(def.lessons, 'lessons');
  const lessonIds = new Set();
  for (const lesson of def.lessons) {
    object(lesson, ['id', 'sim', 'title', 'summary', 'subject', 'level', 'minutes', 'tags', 'setup', 'steps'], 'lesson');
    if (!slug(lesson.id) || lessonIds.has(lesson.id) || lesson.sim !== def.id) fail('invalid/duplicate lesson id or simulation reference');
    lessonIds.add(lesson.id);
    for (const field of ['title', 'summary', 'subject', 'level']) text(lesson[field], `lesson ${field}`);
    number(lesson.minutes, 'minutes'); strings(lesson.tags, 'tags');
    if (lesson.setup) validateSetup(lesson.setup);
    list(lesson.steps, 'steps'); if (!lesson.steps.length) fail('lesson requires steps');
    const stepIds = new Set();
    for (const step of lesson.steps) {
      object(step, ['id', 'type', 'title', 'body', 'choices', 'feedback', 'highlight', 'allow', 'freeze', 'hint', 'when', 'question', 'advance', 'optional'], 'step');
      if (!slug(step.id) || stepIds.has(step.id)) fail('invalid/duplicate step id');
      stepIds.add(step.id);
      if (!['message', 'predict', 'task', 'observe', 'checkpoint', 'conclusion'].includes(step.type)) fail('unknown step type');
      text(step.title, 'step title');
      for (const field of ['body', 'hint']) if (step[field] !== undefined) text(step[field], field);
      for (const field of ['highlight', 'allow']) if (step[field] != null) strings(step[field], field);
      boolean(step.freeze, 'freeze'); boolean(step.optional, 'optional');
      if (step.advance !== undefined && !['on-next', 'on-answer', 'on-condition'].includes(step.advance)) fail('invalid step advancement');
      if (step.when != null) validateCondition(step.when);
      if (step.feedback != null) {
        object(step.feedback, ['correct', 'any'], 'feedback');
        Object.values(step.feedback).forEach(value => text(value, 'feedback'));
      }
      if (step.choices != null) {
        list(step.choices, 'prediction choices'); const choiceIds = new Set();
        if (step.choices.length < 2) fail('prediction needs two choices');
        for (const choice of step.choices) {
          object(choice, ['id', 'label', 'correct'], 'prediction choice');
          if (!slug(choice.id) || choiceIds.has(choice.id)) fail('invalid/duplicate prediction choice');
          choiceIds.add(choice.id); text(choice.label, 'prediction choice label'); boolean(choice.correct, 'correct');
        }
      }
      if (step.type === 'predict' && !step.choices) fail('prediction needs choices');
      if (step.question !== undefined) {
        const q = def.assessment?.questions.find(q => q.id === step.question);
        if (step.type !== 'checkpoint' || step.choices || !q || !['lesson', 'both'].includes(q.use)) fail('invalid lesson question reference');
      }
      if (step.type === 'checkpoint' && !step.question && !step.choices) fail('checkpoint needs a question or choices');
    }
  }
  return def;
}

function validateSetup(setup) {
  object(setup, ['controls', 'action'], 'lesson setup');
  if (setup.action !== undefined) text(setup.action, 'setup action');
  if (setup.controls !== undefined) {
    if (!setup.controls || typeof setup.controls !== 'object' || Array.isArray(setup.controls)) fail('setup controls must be a map');
    for (const [key, value] of Object.entries(setup.controls)) {
      if (!identifier(key)) fail('invalid setup control name');
      number(value, 'setup control');
    }
  }
}

function validateCondition(when) {
  if (Array.isArray(when)) {
    if (!when.length) fail('condition array cannot be empty');
    when.forEach(validateCondition); return;
  }
  object(when, ['all', 'any', 'not', 'control', 'state', 'action', 'near', 'tolerance', 'equals', 'min', 'max', 'changed', 'changedBy', 'settles', 'minElapsed'], 'condition');
  const sources = ['all', 'any', 'not', 'control', 'state', 'action'].filter(key => when[key] !== undefined);
  if (sources.length !== 1) fail('condition needs exactly one source');
  for (const key of ['all', 'any']) if (when[key] !== undefined) {
    list(when[key], key); if (!when[key].length) fail('condition combinator cannot be empty'); when[key].forEach(validateCondition);
  }
  if (when.not !== undefined) validateCondition(when.not);
  for (const key of ['control', 'state', 'action']) if (when[key] !== undefined && !identifier(when[key])) fail('invalid condition name');
  for (const key of ['near', 'tolerance', 'equals', 'min', 'max', 'changedBy', 'minElapsed']) if (when[key] !== undefined) number(when[key], key);
  for (const key of ['changed', 'settles']) boolean(when[key], key);
  for (const key of ['tolerance', 'changedBy', 'minElapsed']) if (when[key] < 0) fail(`${key} cannot be negative`);
  if (when.control && !['near', 'equals', 'min', 'max', 'changedBy', 'changed'].some(key => when[key] !== undefined)) fail('control condition needs a comparison');
  if (when.state && !['equals', 'min', 'max', 'settles'].some(key => when[key] !== undefined)) fail('state condition needs a comparison');
}

function validateBank(bank) {
  object(bank, ['id', 'version', 'questions'], 'assessment');
  if (!slug(bank.id) || !Number.isInteger(bank.version) || bank.version < 1) fail('invalid bank id/version');
  list(bank.questions, 'questions'); const ids = new Set();
  for (const q of bank.questions) {
    object(q, ['id', 'use', 'type', 'prompt', 'choices', 'correct', 'explanation'], 'question');
    if (!slug(q.id) || ids.has(q.id)) fail('invalid/duplicate question id'); ids.add(q.id);
    if (!['single', 'multi'].includes(q.type) || !['lesson', 'assessment', 'both'].includes(q.use)) fail('invalid question type/use');
    text(q.prompt, 'prompt'); text(q.explanation, 'explanation'); list(q.choices, 'choices');
    if (q.choices.length < 2) fail('question needs two choices');
    const choices = new Set();
    for (const choice of q.choices) {
      object(choice, ['id', 'label'], 'choice');
      if (!slug(choice.id) || choices.has(choice.id)) fail('invalid/duplicate choice id'); choices.add(choice.id); text(choice.label, 'choice label');
    }
    strings(q.correct, 'correct');
    if (!q.correct.length || new Set(q.correct).size !== q.correct.length || q.correct.some(id => !choices.has(id)) || (q.type === 'single' && q.correct.length !== 1)) fail('invalid answer key');
  }
  if (!bank.questions.some(q => ['assessment', 'both'].includes(q.use))) fail('bank needs assessment questions');
}

export function validateCatalog(catalog) {
  object(catalog, ['schemaVersion', 'simulations', 'communitySimulationIds'], 'catalog');
  if (catalog.schemaVersion !== 1) fail('unsupported schema version');
  list(catalog.simulations, 'simulations'); const ids = new Set(), bankIds = new Set();
  if (!catalog.simulations.length) fail('catalog cannot be empty');
  for (const def of catalog.simulations) {
    validateDefinition(def);
    if (ids.has(def.id)) fail(`duplicate simulation id: ${def.id}`);
    ids.add(def.id);
    if (def.assessment) {
      if (bankIds.has(def.assessment.id)) fail(`duplicate assessment id: ${def.assessment.id}`);
      bankIds.add(def.assessment.id);
    }
  }
  // Static repository catalogs omit this server-owned publication metadata.
  if (catalog.communitySimulationIds !== undefined) {
    strings(catalog.communitySimulationIds, 'community simulation ids');
    const communityIds = new Set(catalog.communitySimulationIds);
    if (communityIds.size !== catalog.communitySimulationIds.length || [...communityIds].some(id => !ids.has(id))) fail('invalid/duplicate community simulation id');
  }
  return catalog;
}

export async function loadCatalog(fetcher = globalThis.fetch) {
  const response = await fetcher('/simulations/catalog.json');
  if (!response.ok) throw new Error(`Could not load simulation catalog (${response.status})`);
  return validateCatalog(await response.json());
}
