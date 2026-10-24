/** Foreground participation estimate, not proof of attention or mastery. */
function trackExploration(root, doc) {
  const view = doc.defaultView;
  const now = () => view.performance.now();
  let total = 0, since = null, deadline = 0, engaged = false;
  function settle() {
    const time = now();
    if (since !== null) {
      total += Math.max(0, Math.min(time, deadline) - since);
      since = time;
    }
    return time;
  }
  function interact(event) {
    // Ignore engine-generated events, page navigation, and certificate form entry.
    if (!event.isTrusted || doc.hidden ||
        event.target.closest('.simulation-check, .guided-modal-wrap, .guided-hud, .guided-card, dialog') ||
        !event.target.closest('button, input, select, canvas') ||
        (event.type === 'keydown' && ['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key))) return;
    const time = settle();
    engaged = true; since = time; deadline = time + 60_000;
  }
  function pause() { settle(); since = null; }
  function visibility() { if (doc.hidden) pause(); }
  const events = ['pointerdown', 'keydown', 'click', 'input', 'change'];
  events.forEach(type => root?.addEventListener(type, interact, true));
  doc.addEventListener('visibilitychange', visibility);
  // Also suspend time while a page is in the browser Back/Forward cache.
  view.addEventListener('pagehide', pause);
  return {
    seconds() { settle(); return engaged ? Math.floor(total / 1000) : null; },
    destroy() {
      events.forEach(type => root?.removeEventListener(type, interact, true));
      doc.removeEventListener('visibilitychange', visibility);
      view.removeEventListener('pagehide', pause);
    },
  };
}

/** Local participation certificates. Student names are never persisted or sent. */
export function mountCertificate({ host, definition, learning, bus, simulationRoot }) {
  const doc = host.ownerDocument;
  const exploration = trackExploration(simulationRoot, doc);
  const lessons = new Map();
  const subscriptions = [];
  function record(experimentId, completed) {
    if (!definition.lessons.some(lesson => lesson.id === experimentId)) return;
    lessons.set(experimentId, completed || lessons.get(experimentId) || false);
  }
  if (bus) {
    subscriptions.push(bus.on('guided:step', ({ experimentId }) => record(experimentId, false)));
    subscriptions.push(bus.on('guided:complete', ({ experimentId }) => record(experimentId, true)));
  }
  function node(tag, text, cls) {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  const form = node('form', undefined, 'certificate-form');
  const label = node('label', 'Your name');
  const input = node('input');
  input.type = 'text'; input.required = true; input.maxLength = 100;
  input.autocomplete = 'off';
  label.append(input);
  const create = node('button', 'Create completion certificate', 'sim-btn sim-btn--primary');
  create.type = 'submit';
  form.append(label, create);
  const certificate = node('article', undefined, 'completion-certificate');
  certificate.hidden = true; certificate.tabIndex = -1;
  certificate.setAttribute('aria-label', 'Completion certificate');
  const print = node('button', 'Print / save as PDF', 'sim-btn sim-btn--soft');
  print.type = 'button'; print.hidden = true;
  const onPrint = () => doc.defaultView.print();
  print.addEventListener('click', onPrint);
  const onInput = () => input.setCustomValidity('');
  input.addEventListener('input', onInput);
  const onSubmit = event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || name.length > 100) {
      input.setCustomValidity('Enter a name of 1–100 characters.');
      input.reportValidity();
      return;
    }
    const activities = node('ul');
    const seconds = exploration.seconds();
    activities.append(node('li', seconds === null
      ? 'Simulation exploration: not recorded (no interaction this visit)'
      : `Simulation exploration: time spent: ${seconds < 1 ? 'less than 1 second' : `${Math.floor(seconds / 60)}m ${seconds % 60}s`} (this visit)`));
    for (const lesson of definition.lessons) {
      if (lessons.has(lesson.id)) activities.append(node('li',
        `Guided experiment ${lessons.get(lesson.id) ? 'completed' : 'started (not completed)'}: ${lesson.title}`));
    }
    const session = learning.check?.session;
    if (session?.latest) activities.append(node('li', 'Check Understanding completed (latest local result)'));
    if (session?.active) activities.append(node('li', 'Check Understanding in progress'));
    certificate.replaceChildren(
      node('p', 'CommonLab'),
      node('h2', 'Certificate of completion'),
      node('p', 'Presented to'),
      node('p', name, 'certificate-name'),
      node('p', 'For engaging in'),
      node('h3', definition.title),
      node('p', definition.summary),
      activities,
      node('p', `Issued ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`),
      node('p', 'Participation record, not a verified qualification. Guided steps may be skipped. Exploration time excludes hidden tabs and pauses after 60 seconds without interaction.', 'certificate-note'),
    );
    certificate.hidden = false; print.hidden = false;
    certificate.focus();
  };
  form.addEventListener('submit', onSubmit);
  host.append(node('h2', 'Finished exploring?'),
    node('p', 'Enter your name to receive a completion certificate. Print it or save it as a PDF. Your name stays on this page; guided activity and exploration time are recorded only for this visit. Exploration time starts when you use a simulation control or canvas, excludes hidden tabs, and pauses after 60 seconds without interaction.'),
    form, certificate, print);
  return {
    destroy() {
      exploration.destroy();
      subscriptions.forEach(unsubscribe => unsubscribe());
      input.removeEventListener('input', onInput);
      form.removeEventListener('submit', onSubmit);
      print.removeEventListener('click', onPrint);
      host.replaceChildren();
    },
  };
}
