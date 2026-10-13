import { validateDefinition } from './simulation-schema.mjs';

/** Render only approved components. Metadata/content is always text, never HTML. */
export function renderSimulation(root, definition, { idPrefix = '' } = {}) {
  validateDefinition(definition);
  const doc = root.ownerDocument;
  const slots = new Map();
  const controllerEvents = new AbortController();
  function node(tag, cls, text, id) {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    // Preview namespaces prevent draft slot IDs from shadowing author/reviewer form IDs.
    if (id) { el.id = `${idPrefix}${id}`; slots.set(id, el); }
    return el;
  }
  function button(data, label = data.label) {
    if (data.variant === 'display') return node('span', 'control-value', label, data.id);
    const el = node('button', `sim-btn sim-btn--${data.variant}`, label, data.id);
    el.type = 'button';
    if (data.active) el.classList.add('is-active');
    if (data.pressed !== undefined) el.setAttribute('aria-pressed', String(data.pressed));
    return el;
  }
  function canvas(data) {
    const el = node('canvas', 'simulation-canvas', undefined, data.id);
    el.width = data.width; el.height = data.height;
    el.style.aspectRatio = `${data.width} / ${data.height}`;
    el.setAttribute('aria-label', data.label); el.tabIndex = 0;
    el.append(node('p', '', `${data.label} requires a browser with canvas support.`));
    return el;
  }
  function showInfo(key, opener) {
    const data = definition.info[key];
    dialog.replaceChildren(node('h2', '', data.title), node('p', 'equation-formula', data.formula), node('p', '', data.explanation), node('p', '', data.detail));
    const close = node('button', 'sim-btn sim-btn--soft', 'Close'); close.type = 'button';
    close.addEventListener('click', () => dialog.close()); dialog.append(close);
    dialog.onclose = () => opener.focus(); dialog.showModal();
  }
  function component(data) {
    switch (data.type) {
      case 'slider': {
        const row = node('div', 'control-row');
        const label = node('label', 'control-label', data.label); label.htmlFor = `${idPrefix}${data.id}`;
        const input = node('input', '', undefined, data.id);
        input.type = 'range'; input.min = data.min; input.max = data.max; input.step = data.step; input.value = data.value;
        row.append(label);
        if (data.icons) row.append(node('span', 'control-icon', data.icons[0].text, data.icons[0].id));
        row.append(input);
        if (data.output) row.append(node('span', 'control-value', data.output.text, data.output.id));
        if (data.icons) row.append(node('span', 'control-icon', data.icons[1].text, data.icons[1].id));
        if (data.info) {
          const help = node('button', 'simulation-info', `About ${definition.info[data.info].title}`); help.type = 'button';
          help.addEventListener('click', () => showInfo(data.info, help)); row.append(help);
        }
        return row;
      }
      case 'actions': {
        const row = node('div', 'sim-actions'); data.buttons.forEach(data => row.append(button(data))); return row;
      }
      case 'choices': {
        const wrap = node('fieldset', 'simulation-choices', undefined, data.id);
        wrap.value = data.value;
        wrap.append(node('legend', 'simulation-label', data.label));
        const rowClasses = { toolbar: 'sim-toolbar', segments: 'sim-seg', chips: 'simulation-chips' };
        const buttonClasses = { toolbar: 'sim-tool', segments: 'sim-seg__btn', chips: 'sim-chip' };
        const row = node('div', rowClasses[data.style]);
        for (const option of data.options) {
          const el = node('button', buttonClasses[data.style], option.label);
          el.type = 'button'; el.dataset.value = option.value;
          if (data.style !== 'chips') el.setAttribute('aria-pressed', String(option.value === data.value));
          if (option.value === data.value && data.style !== 'chips') el.classList.add('is-active');
          if (data.style !== 'chips') el.addEventListener('click', () => {
            wrap.value = option.value;
            for (const btn of row.querySelectorAll('button')) {
              btn.classList.toggle('is-active', btn === el); btn.setAttribute('aria-pressed', String(btn === el));
            }
          });
          row.append(el);
        }
        wrap.append(row); return wrap;
      }
      case 'select': {
        const wrap = node('div', 'simulation-select');
        const label = node('label', 'simulation-label', data.label); label.htmlFor = `${idPrefix}${data.id}`;
        const select = node('select', '', undefined, data.id);
        for (const option of data.options) {
          const el = node('option', '', option.label); el.value = option.value; select.append(el);
        }
        select.value = data.value; wrap.append(label, select); return wrap;
      }
      case 'readouts': {
        const row = node('div', 'sim-readouts simulation-readouts', undefined, data.id); row.hidden = !!data.hidden;
        for (const item of data.items) {
          const cell = node('div', `sim-readout${item.tone === 'default' ? '' : ` sim-readout--${item.tone}`}`);
          cell.append(node('div', 'sim-readout__value', item.value, item.id), node('div', 'sim-readout__label', item.label)); row.append(cell);
        }
        return row;
      }
      case 'text': {
        const wrap = node('div', 'simulation-note');
        if (data.label) wrap.append(node('strong', '', data.label));
        wrap.append(node('p', '', data.text, data.id)); return wrap;
      }
      case 'stepper': {
        const row = node('div', 'sim-stepper');
        if (data.decrease) row.append(button(data.decrease, `− ${data.label}`));
        const display = node('div', 'sim-stepper__display');
        display.append(node('strong', 'sim-stepper__value', data.output.text, data.output.id), node('span', 'sim-stepper__unit', data.label)); row.append(display);
        row.append(button(data.increase, `+ ${data.label}`)); return row;
      }
      case 'meter': {
        const wrap = node('div', 'simulation-meter');
        wrap.append(node('strong', '', data.label), node('span', '', data.output.text, data.output.id));
        const track = node('div', 'simulation-meter-track'); const fill = node('div', 'simulation-meter-fill', undefined, data.id);
        track.append(fill); wrap.append(track);
        const ticks = node('div', 'simulation-meter-ticks'); data.ticks.forEach(text => ticks.append(node('span', '', text))); wrap.append(ticks); return wrap;
      }
      default: throw new Error(`Unsupported component: ${data.type}`);
    }
  }

  root.replaceChildren(); root.className = 'container sim-layout';
  const main = node('div', 'sim-main');
  const wrap = node('div', 'canvas-wrapper'); wrap.append(canvas(definition.canvas)); main.append(wrap);
  const controls = node('div', 'controls-panel');
  const checkHost = node('div', 'simulation-check');
  if (definition.assessment) controls.append(checkHost);
  definition.controls.forEach(data => controls.append(component(data))); main.append(controls);
  const sidebar = node('aside', 'sim-sidebar'); sidebar.setAttribute('aria-label', 'Science explanations');
  for (const data of definition.cards) {
    const card = node('div', 'equation-card'); card.append(node('h3', '', data.title));
    data.formulas.forEach(text => card.append(node('div', 'equation-formula', text)));
    data.paragraphs.forEach(text => card.append(node('p', 'eq-explanation', text))); sidebar.append(card);
  }
  const dialog = node('dialog', 'simulation-dialog'); dialog.setAttribute('aria-label', 'Science explanation');
  for (const data of definition.graphs) {
    const graph = node('section', 'simulation-graph'); graph.append(node('h3', '', data.label));
    if (data.legend) {
      const legend = node('div', 'simulation-legend');
      for (const item of data.legend) {
        const el = node('span', '', item.label); el.style.borderColor = item.color; legend.append(el);
      }
      graph.append(legend);
    }
    graph.append(canvas(data)); if (data.caption) graph.append(node('p', 'simulation-note', data.caption)); main.append(graph);
  }
  if (!definition.cards.length) root.classList.add('simulation-no-sidebar');
  root.append(main, sidebar, dialog);

  return {
    root, definition, checkHost,
    getElementById(id) { const el = slots.get(id); if (!el) throw new Error(`Missing declared UI slot: ${id}`); return el; },
    querySelector: selector => root.querySelector(selector),
    querySelectorAll: selector => root.querySelectorAll(selector),
    // Keyboard shortcuts are canvas-scoped, never applied while answering checks or using controls.
    addEventListener(type, handler) {
      root.addEventListener(type, event => {
        if (event.target.tagName !== 'CANVAS' || dialog.open) return;
        handler(event);
      }, { signal: controllerEvents.signal });
    },
    destroy() { controllerEvents.abort(); if (dialog.open) dialog.close(); root.replaceChildren(); },
  };
}

/** All simulations use the same practice/assessment lifecycle. Modules only expose an adapter. */
export function mountLearning(ui, controller, launcherHost, SimLib = globalThis.SimLib) {
  const definition = ui.definition;
  const bank = definition.assessment ? SimLib.CFU.bank(definition.assessment) : null;
  const experiments = definition.lessons.map(lesson => SimLib.Guided.define({
    ...lesson,
    steps: lesson.steps.map(step => ({ ...step, ...(step.question ? { question: bank.questions.find(q => q.id === step.question) } : {}) })),
  }));
  if (experiments.length && !controller.adapter) throw new Error('Lessons require a controller adapter');
  let check;
  const guided = experiments.length ? SimLib.Guided.mount({
    app: controller.app, adapter: controller.adapter, experiments, launcherMount: launcherHost,
    overlayRoot: ui.querySelector('.sim-main'), beforeStart: () => check?.close(),
  }) : null;
  check = bank ? SimLib.CFU.mount({ bank, host: ui.checkHost, beforeOpen: () => guided?.runner?.exit() }) : null;
  return {
    bank, experiments, guided, check,
    destroy() { guided?.runner?.exit(); guided?.launcher.destroy(); guided?.overlay.destroy(); check?.destroy(); },
  };
}
