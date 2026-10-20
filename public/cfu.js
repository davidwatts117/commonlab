/* SimLib.CFU — shared, locally graded checks. No simulation state is changed. */
(function (global) {
  'use strict';
  const CFU = {};
  const fail = message => { throw new Error('CFU: ' + message); };
  CFU.bank = function (def) {
    if (!def || !def.id || !Number.isInteger(def.version) || def.version < 1
        || !Array.isArray(def.questions) || !def.questions.length) fail('bank needs id, positive version and questions');
    const ids = new Set();
    const questions = def.questions.map(q => {
      if (!q.id || ids.has(q.id)) fail('missing or duplicate question id');
      ids.add(q.id);
      if (!['lesson', 'assessment', 'both'].includes(q.use)) fail('invalid use tag');
      if (!['single', 'multi'].includes(q.type) || !q.prompt || !q.explanation) fail('question needs type, prompt and explanation');
      if (!Array.isArray(q.choices) || q.choices.length < 2) fail('at least two choices required');
      const choices = q.choices.map(c => Object.freeze({ id: c.id, label: c.label }));
      const choiceIds = new Set(choices.map(c => c.id));
      if (choiceIds.size !== choices.length || choices.some(c => !c.id || !c.label)) fail('invalid choice ids/labels');
      if (!Array.isArray(q.correct) || !q.correct.length || new Set(q.correct).size !== q.correct.length
          || q.correct.some(id => !choiceIds.has(id)) || (q.type === 'single' && q.correct.length !== 1)) fail('invalid answer key');
      return Object.freeze({ ...q, choices: Object.freeze(choices), correct: Object.freeze([...q.correct]) });
    });
    return Object.freeze({ ...def, questions: Object.freeze(questions) });
  };
  CFU.questions = (bank, use) => bank.questions.filter(q => q.use === use || q.use === 'both');
  CFU.validSelection = (q, selected) => Array.isArray(selected) && selected.length > 0
    && (q.type !== 'single' || selected.length === 1) && new Set(selected).size === selected.length
    && selected.every(id => q.choices.some(c => c.id === id));
  CFU.grade = (q, selected) => CFU.validSelection(q, selected)
    && selected.length === q.correct.length && q.correct.every(id => selected.includes(id));
  const labels = (q, ids) => q.choices.filter(c => ids.includes(c.id)).map(c => c.label).join('; ');
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (text, handler) => {
    const b = node('button', 'cfu-button', text); b.type = 'button';
    b.addEventListener('click', handler); return b;
  };
  let serial = 0;
  /* A single question view is used by both lesson checkpoints and assessment. */
  CFU.renderQuestion = function (host, q, opts = {}) {
    const wrap = node('div', 'cfu-question');
    const group = node('fieldset', 'cfu-choices');
    group.append(node('legend', '', q.prompt));
    group.append(node('p', 'cfu-instruction', q.type === 'multi' ? 'Select all that apply.' : 'Select one answer.'));
    const name = 'cfu-' + (++serial);
    let selected = [...(opts.answer || opts.draft || [])];
    let locked = !!opts.answer;
    const inputs = [];
    const feedback = node('div', 'cfu-feedback');
    feedback.setAttribute('role', 'status');
    const submit = button('Submit answer', () => {
      if (locked || !CFU.validSelection(q, selected)) return;
      locked = true;
      inputs.forEach(input => { input.disabled = true; });
      submit.disabled = true;
      showFeedback();
      if (opts.onSubmit) opts.onSubmit([...selected]);
      if (continueButton) { continueButton.disabled = false; continueButton.focus(); }
    });
    const continueButton = opts.onContinue ? button(opts.continueLabel || 'Continue', opts.onContinue) : null;
    function showFeedback() {
      feedback.textContent = (CFU.grade(q, selected) ? 'Correct. ' : 'Not quite. ')
        + 'Correct answer: ' + labels(q, q.correct) + '. ' + q.explanation;
    }
    q.choices.forEach(c => {
      const label = node('label', 'cfu-choice');
      const input = node('input');
      input.type = q.type === 'multi' ? 'checkbox' : 'radio'; input.name = name; input.value = c.id;
      input.checked = selected.includes(c.id); input.disabled = locked;
      input.addEventListener('change', () => {
        if (locked) return;
        if (q.type === 'single') selected = [c.id];
        else selected = inputs.filter(i => i.checked).map(i => i.value);
        submit.disabled = !CFU.validSelection(q, selected);
        if (opts.onDraft) opts.onDraft([...selected]);
      });
      inputs.push(input); label.append(input, node('span', '', c.label)); group.append(label);
    });
    submit.disabled = locked || !CFU.validSelection(q, selected);
    if (locked) showFeedback();
    wrap.append(group, submit, feedback);
    if (continueButton) { continueButton.disabled = !locked; wrap.append(continueButton); }
    host.append(wrap);
    return { wrap, inputs, submit, continueButton };
  };

  class Session {
    constructor(bank, storage) {
      this.bank = bank;
      this.questions = CFU.questions(bank, 'assessment');
      if (!this.questions.length) fail('assessment is empty');
      this.key = 'commonlab:cfu:' + bank.id;
      this.storageAvailable = true;
      try { this.storage = storage === undefined ? global.localStorage : storage; }
      catch { this.storage = null; }
      this.storageAvailable = !!this.storage;
      this.active = null; this.latest = null;
      this.load();
    }
    validAnswers(answers, count) {
      return Array.isArray(answers) && answers.length === count
        && answers.every((a, i) => CFU.validSelection(this.questions[i], a));
    }
    load() {
      if (!this.storage) return;
      let raw;
      try { raw = this.storage.getItem(this.key); }
      catch { this.storageAvailable = false; return; }
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        if (data.schema !== 1 || data.bankVersion !== this.bank.version) return;
        // Validate each record independently so a bad active record does not erase a good result.
        const a = data.active;
        if (a && Number.isInteger(a.index) && a.index >= 0 && a.index < this.questions.length
            && this.validAnswers(a.answers, a.index + (a.submitted ? 1 : 0))
            && typeof a.submitted === 'boolean' && Array.isArray(a.draft)
            && (a.draft.length === 0 || CFU.validSelection(this.questions[a.index], a.draft))) {
          this.active = { index: a.index, answers: a.answers.map(x => [...x]), draft: [...a.draft], submitted: a.submitted };
        }
        const r = data.latest;
        if (r && this.validAnswers(r.answers, this.questions.length) && typeof r.completedAt === 'string') {
          this.latest = { answers: r.answers.map(x => [...x]), completedAt: r.completedAt };
        }
      } catch { /* Corrupt JSON: ignore it, but storage may still be usable. */ }
    }
    save() {
      if (!this.storage) return;
      try {
        this.storage.setItem(this.key, JSON.stringify({ schema: 1, bankVersion: this.bank.version, active: this.active, latest: this.latest }));
      } catch { this.storageAvailable = false; }
    }
    restart() { this.active = { index: 0, answers: [], draft: [], submitted: false }; this.save(); }
    draft(selection) {
      if (!this.active || this.active.submitted) return;
      const q = this.questions[this.active.index];
      if (!Array.isArray(selection) || (selection.length && !CFU.validSelection(q, selection))) return;
      this.active.draft = [...selection]; this.save();
    }
    submit(selection) {
      const a = this.active;
      if (!a || a.submitted || !CFU.validSelection(this.questions[a.index], selection)) return false;
      a.answers.push([...selection]); a.draft = []; a.submitted = true; this.save(); return true;
    }
    next() {
      const a = this.active;
      if (!a || !a.submitted) return false;
      if (a.index === this.questions.length - 1) {
        this.latest = { answers: a.answers.map(x => [...x]), completedAt: new Date().toISOString() };
        this.active = null;
      } else { a.index++; a.submitted = false; a.draft = []; }
      this.save(); return true;
    }
    score(result = this.latest) {
      return result ? result.answers.reduce((sum, a, i) => sum + Number(CFU.grade(this.questions[i], a)), 0) : 0;
    }
  }
  CFU.Session = Session;
  CFU.mount = function ({ bank, host, launcherHost = host, storage, beforeOpen }) {
    const session = new Session(bank, storage);
    const panel = node('section', 'cfu-panel'); panel.hidden = true;
    panel.setAttribute('aria-label', 'Check Understanding');
    const launcher = button('Check Understanding', open);
    launcher.setAttribute('aria-expanded', 'false');
    launcherHost.append(launcher); host.append(panel);
    function close() { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
    function open() {
      if (beforeOpen) beforeOpen();
      if (!session.active && !session.latest) session.restart();
      panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); render();
    }
    function render() {
      panel.replaceChildren();
      const title = node('h3', '', 'Check Understanding'); title.tabIndex = -1;
      panel.append(title, node('p', '', 'Local self-check: no results are sent. You can keep using the simulation.'));
      if (!session.storageAvailable) panel.append(node('p', '', 'Storage unavailable: progress is kept only for this visit.'));
      panel.append(button('Close', close), button('Restart check', () => { session.restart(); render(); }));
      if (session.latest && session.active) panel.append(node('p', '', 'Latest completed result: ' + session.score() + '/' + session.questions.length));
      if (session.active) {
        const a = session.active;
        panel.append(node('p', '', 'Question ' + (a.index + 1) + ' of ' + session.questions.length));
        CFU.renderQuestion(panel, session.questions[a.index], {
          draft: a.draft, answer: a.submitted ? a.answers[a.index] : null,
          onDraft: s => session.draft(s), onSubmit: s => session.submit(s),
          continueLabel: a.index === session.questions.length - 1 ? 'See results' : 'Continue',
          onContinue: () => { session.next(); render(); },
        });
      } else if (session.latest) {
        panel.append(node('h4', '', 'Score: ' + session.score() + ' / ' + session.questions.length));
        session.questions.forEach((q, i) => {
          const answer = session.latest.answers[i];
          const item = node('article', 'cfu-review');
          item.append(node('h4', '', (i + 1) + '. ' + q.prompt),
            node('p', '', 'Your answer: ' + labels(q, answer)),
            node('p', '', CFU.grade(q, answer) ? 'Correct' : 'Incorrect'),
            node('p', '', 'Correct answer: ' + labels(q, q.correct)), node('p', '', q.explanation));
          panel.append(item);
        });
      }
      title.focus();
    }
    return { session, panel, launcher, open, close, destroy() { panel.remove(); launcher.remove(); } };
  };
  global.SimLib.CFU = CFU;
})(this);
