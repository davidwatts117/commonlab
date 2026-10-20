// Visual authoring edits the same closed definition; it does not create a second UI schema.
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const hasQuestionReferences = def => def.lessons.some(lesson => lesson.steps.some(step => step.question));
export function questionReferenced(def, id) {
  return def.lessons.some(lesson => lesson.steps.some(step => step.question === id));
}
export function renameQuestion(def, index, id) {
  const question = def.assessment.questions[index], old = question.id;
  if (def.assessment.questions.some((q, i) => i !== index && q.id === id)) throw new Error('Question ID already exists.');
  question.id = id;
  for (const lesson of def.lessons) for (const step of lesson.steps) if (step.question === old) step.question = id;
}
export function renameChoice(question, index, id) {
  const old = question.choices[index].id;
  if (question.choices.some((choice, i) => i !== index && choice.id === id)) throw new Error('Answer ID already exists.');
  question.choices[index].id = id;
  question.correct = question.correct.map(value => value === old ? id : value);
}
export function removeQuestion(def, index) {
  const question = def.assessment.questions[index];
  if (questionReferenced(def, question.id)) throw new Error('This question is used by a lesson. Update its checkpoints before removing it.');
  if (def.assessment.questions.length <= 1) throw new Error('Keep at least one question, or remove the bank.');
  def.assessment.questions.splice(index, 1);
}
function unusedId(items, prefix) {
  let index = 1; while (items.some(item => item.id === `${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
export function newQuestion(questions) {
  return { id: unusedId(questions, 'question'), type: 'single', use: 'assessment', prompt: 'What relationship did you observe?', choices: [{ id: 'option-1', label: 'First answer' }, { id: 'option-2', label: 'Second answer' }], correct: ['option-1'], explanation: 'Explain why the correct answer follows from the science.' };
}
function editableShape(def) {
  const textList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!Array.isArray(def.cards) || !Array.isArray(def.lessons) || !def.lessons.every(lesson => lesson && Array.isArray(lesson.steps) && lesson.steps.every(step => step && typeof step === 'object')) || !def.cards.every(card => card && typeof card.title === 'string' && textList(card.formulas) && textList(card.paragraphs))) throw new Error('Repair the cards/lessons structure in JSON to restore visual editing.');
  if (def.assessment && (typeof def.assessment.id !== 'string' || !Array.isArray(def.assessment.questions) || !def.assessment.questions.every(q => q && ['id', 'type', 'use', 'prompt', 'explanation'].every(key => typeof q[key] === 'string') && textList(q.correct) && Array.isArray(q.choices) && q.choices.every(choice => choice && typeof choice.id === 'string' && typeof choice.label === 'string')))) throw new Error('Repair the question-bank structure in JSON to restore visual editing.');
}

/** apply(mutator, refresh) reads the current JSON, so incremental edits never use stale IDs. */
export function contentEditor(root, apply, reportError) {
  const doc = root.ownerDocument;
  const expanded = new Set();
  function disclosure(parent, title, key, open = false) {
    const node = el('details', undefined, 'content-group');
    node.dataset.disclosureKey = key;
    node.open = expanded.has(key) || open;
    node.append(el('summary', title));
    node.addEventListener('toggle', () => { if (node.open) expanded.add(key); else expanded.delete(key); });
    parent.append(node); return node;
  }
  function el(tag, text, cls) {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node;
  }
  function button(parent, label, action, disabled = false) {
    const node = el('button', label, 'sim-btn sim-btn--soft'); node.type = 'button'; node.disabled = disabled; node.addEventListener('click', action); parent.append(node); return node;
  }
  function field(parent, label, value, change, { multiline = false, type = 'text', options, min, focusKey } = {}) {
    const wrap = el('label', label);
    let tag = 'input';
    if (options) tag = 'select';
    else if (multiline) tag = 'textarea';
    const input = el(tag);
    input.setAttribute('aria-label', label);
    if (focusKey) input.dataset.editorFocus = focusKey;
    if (options) for (const [value, label] of options) { const option = el('option', label); option.value = value; input.append(option); }
    else if (multiline) input.rows = 3;
    else input.type = type;
    if (min !== undefined) input.min = min;
    let accepted = value ?? ''; input.value = accepted;
    input.addEventListener(options || type === 'number' ? 'change' : 'input', () => {
      if (change(type === 'number' ? Number(input.value) : input.value) === false) input.value = accepted;
      else accepted = input.value;
    });
    wrap.append(input); parent.append(wrap); return input;
  }
  return {
    render(def) {
      const focused = root.contains(doc.activeElement) ? doc.activeElement?.dataset?.editorFocus : null;
      root.querySelectorAll('[data-disclosure-key]').forEach(node => {
        if (node.open) expanded.add(node.dataset.disclosureKey); else expanded.delete(node.dataset.disclosureKey);
      });
      root.replaceChildren();
      try { editableShape(def); }
      catch (error) { root.append(el('p', error.message)); reportError(error.message); return; }
      const cards = el('section'); cards.append(el('h3', 'Explanation cards'));
      if (!def.cards.length) cards.append(el('p', 'Use “Add explanation card” above to start.'));
      def.cards.forEach((card, index) => {
        const box = disclosure(cards, `Explanation ${index + 1} · ${(card.title || 'Untitled').slice(0, 100)}`, `card-${index}`);
        box.dataset.editorType = 'card';
        field(box, 'Card title', card.title, value => {
          const saved = apply(d => { d.cards[index].title = value; });
          if (saved !== false) box.querySelector('summary').textContent = `Explanation ${index + 1} · ${(value || 'Untitled').slice(0, 100)}`;
          return saved;
        });
        field(box, 'Formulas (one per line)', card.formulas.join('\n'), value => apply(d => { d.cards[index].formulas = lines(value); }), { multiline: true });
        field(box, 'Explanations (one paragraph per line)', card.paragraphs.join('\n'), value => apply(d => { d.cards[index].paragraphs = lines(value); }), { multiline: true });
        button(box, 'Move card up', () => apply(d => { [d.cards[index - 1], d.cards[index]] = [d.cards[index], d.cards[index - 1]]; }, true), index === 0);
        button(box, 'Remove card', () => apply(d => { d.cards.splice(index, 1); }, true));
      });
      root.append(cards);
      const bank = el('section'); bank.append(el('h3', 'Check Understanding questions'));
      bank.append(el('p', 'Questions and explanations are plain text. Select the correct answer(s), and validate before exporting or submitting. Lessons still use the JSON editor.'));
      if (!def.assessment) {
        button(bank, 'Add question bank', () => apply(d => { expanded.add('question-0'); d.assessment = { id: d.id, version: 1, questions: [newQuestion([])] }; }, true)); root.append(bank); return;
      }
      const settings = disclosure(bank, 'Advanced: bank identity and version', 'bank-settings');
      field(settings, 'Question bank ID', def.assessment.id, value => apply(d => { d.assessment.id = value; }));
      field(settings, 'Question bank version', def.assessment.version, value => apply(d => { d.assessment.version = value; }), { type: 'number', min: 1 });
      settings.append(el('p', 'IDs are generated for you. Change them only when needed; increment the version when changing a published bank.'));
      const tools = el('div', undefined, 'authoring-actions');
      button(tools, 'Expand all questions', () => { bank.querySelectorAll('[data-editor-type="question"]').forEach(node => { node.open = true; }); });
      button(tools, 'Collapse all questions', () => { bank.querySelectorAll('[data-editor-type="question"]').forEach(node => { node.open = false; }); });
      bank.append(tools);
      def.assessment.questions.forEach((q, index) => {
        const box = disclosure(bank, `Question ${index + 1} · ${(q.prompt || 'Untitled question').slice(0, 100)}`, `question-${index}`);
        box.dataset.editorType = 'question';
        const advanced = disclosure(box, 'Advanced: question ID and lesson use', `advanced-${index}`);
        field(advanced, 'Question ID', q.id, value => apply(d => renameQuestion(d, index, value)));
        field(box, 'Question prompt', q.prompt, value => {
          const saved = apply(d => { d.assessment.questions[index].prompt = value; });
          if (saved !== false) box.querySelector('summary').textContent = `Question ${index + 1} · ${(value || 'Untitled question').slice(0, 100)}`;
          return saved;
        }, { multiline: true });
        field(box, 'Answer type', q.type, value => apply(d => { const q = d.assessment.questions[index]; q.type = value; if (value === 'single') q.correct = q.correct.slice(0, 1); }, true), { focusKey: `question-${index}-type`, options: [['single', 'Single answer'], ['multi', 'Multiple answers']] });
        field(advanced, 'Question use', q.use, value => apply(d => { d.assessment.questions[index].use = value; }), { options: [['assessment', 'Standalone check'], ['lesson', 'Lesson only'], ['both', 'Lesson and standalone']] });
        q.choices.forEach((choice, ci) => {
          const row = el('div', undefined, 'answer-row'); box.append(row);
          field(advanced, `Answer ${ci + 1} ID`, choice.id, value => apply(d => renameChoice(d.assessment.questions[index], ci, value)));
          field(row, 'Answer label', choice.label, value => apply(d => { d.assessment.questions[index].choices[ci].label = value; }));
          const correct = el('input'); correct.type = q.type === 'single' ? 'radio' : 'checkbox'; correct.name = `content-question-${index}`; correct.checked = q.correct.includes(choice.id);
          const label = el('label', 'Correct answer '); label.append(correct); row.append(label);
          correct.addEventListener('change', () => apply(d => {
            const current = d.assessment.questions[index], id = current.choices[ci].id;
            if (current.type === 'single') current.correct = [id];
            else if (correct.checked) current.correct = [...new Set([...current.correct, id])];
            else current.correct = current.correct.filter(value => value !== id);
          }));
          button(row, 'Remove answer', () => apply(d => {
            const current = d.assessment.questions[index], id = current.choices[ci].id;
            current.choices.splice(ci, 1); current.correct = current.correct.filter(value => value !== id);
          }, true), q.choices.length <= 2);
        });
        button(box, 'Add answer', () => apply(d => { const q = d.assessment.questions[index]; q.choices.push({ id: unusedId(q.choices, 'option'), label: 'Another answer' }); }, true), q.choices.length >= 30);
        field(box, 'Answer explanation', q.explanation, value => apply(d => { d.assessment.questions[index].explanation = value; }), { multiline: true });
        const referenced = questionReferenced(def, q.id);
        if (referenced) box.append(el('p', 'Used by a lesson. Renaming updates its checkpoints; update lesson references in JSON before deleting.'));
        button(box, 'Move question up', () => apply(d => { const questions = d.assessment.questions; [questions[index - 1], questions[index]] = [questions[index], questions[index - 1]]; }, true), index === 0);
        button(box, 'Move question down', () => apply(d => { const questions = d.assessment.questions; [questions[index], questions[index + 1]] = [questions[index + 1], questions[index]]; }, true), index === def.assessment.questions.length - 1);
        button(box, 'Duplicate question', () => apply(d => { const copy = structuredClone(d.assessment.questions[index]); copy.id = unusedId(d.assessment.questions, 'question'); expanded.add(`question-${index + 1}`); d.assessment.questions.splice(index + 1, 0, copy); }, true), def.assessment.questions.length >= 100);
        button(box, 'Remove question', () => apply(d => removeQuestion(d, index), true), referenced || def.assessment.questions.length <= 1);
      });
      button(bank, 'Add question', () => apply(d => { const q = newQuestion(d.assessment.questions); expanded.add(`question-${d.assessment.questions.length}`); d.assessment.questions.push(q); }, true), def.assessment.questions.length >= 100);
      button(bank, 'Remove question bank', () => apply(d => {
        if (hasQuestionReferences(d)) throw new Error('Update lesson checkpoints before removing the bank.'); delete d.assessment;
      }, true), hasQuestionReferences(def));
      root.append(bank);
      if (focused) root.querySelector(`[data-editor-focus="${focused}"]`)?.focus();
    },
  };
}
