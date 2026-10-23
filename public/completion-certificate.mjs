/** Local participation certificates. Student names are never persisted or sent. */
export function mountCertificate({ host, definition, learning, bus }) {
  const doc = host.ownerDocument;
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
    activities.append(node('li', 'Simulation exploration'));
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
      node('p', 'Participation record, not a verified qualification. Guided steps may be skipped.', 'certificate-note'),
    );
    certificate.hidden = false; print.hidden = false;
    certificate.focus();
  };
  form.addEventListener('submit', onSubmit);
  host.append(node('h2', 'Finished exploring?'),
    node('p', 'Enter your name to receive a completion certificate. Print it or save it as a PDF. Your name stays on this page; guided activity is recorded only for this visit.'),
    form, certificate, print);
  return {
    destroy() {
      subscriptions.forEach(unsubscribe => unsubscribe());
      input.removeEventListener('input', onInput);
      form.removeEventListener('submit', onSubmit);
      print.removeEventListener('click', onPrint);
      host.replaceChildren();
    },
  };
}
