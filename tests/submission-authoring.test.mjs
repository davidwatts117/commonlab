import test from 'node:test';
import assert from 'node:assert/strict';
import { createBundle, parseBundle, submissionRequest, MAX_BUNDLE_BYTES } from '../public/submission-bundle.mjs';
import { newQuestion, renameChoice, renameQuestion, questionReferenced, removeQuestion } from '../public/content-editor.mjs';
import { validateDefinition } from '../public/simulation-schema.mjs';

const installed = ['pendulum', 'projectile'];
function definition() {
  return { id: 'new-lab', title: 'New lab', subject: 'physics', summary: 'Investigate a relationship.', canvas: { id: 'scene', label: 'Lab scene', width: 700, height: 480 }, controls: [], cards: [], graphs: [], lessons: [] };
}

test('complete bundles round-trip source as inert JSON and map to the closed server request', () => {
  const code = 'globalThis.bundleRan = true;\n// </textarea><img src=x onerror=alert(1)>\nexport function mount(ui) {}';
  const bundle = createBundle(definition(), { kind: 'javascript', moduleCode: code }, 'Author', installed);
  const restored = parseBundle(JSON.stringify(bundle), installed);
  assert.deepEqual(restored, bundle);
  assert.deepEqual(submissionRequest(restored, installed), { definition: bundle.definition, moduleCode: code, submittedBy: 'Author' });
  assert.equal(globalThis.bundleRan, undefined);
  assert.equal(Object.hasOwn(restored, 'adminToken'), false);
  const existing = createBundle(definition(), { kind: 'installed', engineId: 'pendulum' }, '', installed);
  assert.deepEqual(submissionRequest(existing, installed), { definition: existing.definition, engineId: 'pendulum', submittedBy: '' });
  assert.equal(Object.hasOwn(existing.source, 'moduleCode'), false);
});

test('bundles reject unknown fields, versions, engines, mixed sources and invalid definitions', () => {
  const original = createBundle(definition(), { kind: 'installed', engineId: 'pendulum' }, '', installed);
  const bad = [
    b => { b.bundleVersion = 2; },
    b => { b.adminToken = 'must-not-be-in-a-draft'; },
    b => { b.source.engineId = 'community-engine'; },
    b => { b.source.moduleCode = 'unexpected code'; },
    b => { b.source = { kind: 'javascript', moduleCode: 'x', engineId: 'pendulum' }; },
    b => { b.source = { kind: 'javascript', moduleCode: ' ' }; },
    b => { b.source = { kind: 'url', url: 'https://example.com/module.js' }; },
    b => { b.definition.html = '<script>bad</script>'; },
    b => { b.submittedBy = 'x'.repeat(101); },
  ];
  for (const mutate of bad) { const candidate = structuredClone(original); mutate(candidate); assert.throws(() => parseBundle(JSON.stringify(candidate), installed)); }
  assert.throws(() => parseBundle('{bad', installed), /not valid JSON/);
  assert.throws(() => parseBundle(' '.repeat(MAX_BUNDLE_BYTES + 1), installed), /1 MiB/);
  assert.throws(() => createBundle(definition(), { kind: 'javascript', moduleCode: '界'.repeat(44_000) }, '', installed), /128 KiB/);
  const huge = definition(); huge.summary = 'x'.repeat(66_000);
  assert.throws(() => createBundle(huge, { kind: 'installed', engineId: 'pendulum' }, '', installed), /64 KiB/);
});

test('visual question renames preserve answer keys and lesson references across incremental edits', () => {
  const def = definition(); const q = newQuestion([]); q.use = 'both';
  def.assessment = { id: def.id, version: 1, questions: [q, newQuestion([q])] };
  def.lessons = [{ id: 'first-lesson', sim: def.id, title: 'Lesson', summary: 'Predict and explain.', subject: 'physics', level: 'introductory', minutes: 5, tags: [], steps: [{ id: 'checkpoint', type: 'checkpoint', title: 'Check', question: q.id }] }];
  assert.equal(questionReferenced(def, q.id), true);
  renameQuestion(def, 0, 'q'); renameQuestion(def, 0, 'question-renamed');
  assert.equal(def.lessons[0].steps[0].question, 'question-renamed');
  renameChoice(q, 0, 'a'); renameChoice(q, 0, 'answer-renamed');
  assert.deepEqual(q.correct, ['answer-renamed']);
  validateDefinition(def);
  const before = JSON.stringify(def);
  assert.throws(() => renameQuestion(def, 0, def.assessment.questions[1].id), /already exists/);
  assert.throws(() => renameChoice(q, 0, q.choices[1].id), /already exists/);
  assert.equal(JSON.stringify(def), before);
  assert.throws(() => removeQuestion(def, 0), /used by a lesson/);
  removeQuestion(def, 1); assert.equal(def.assessment.questions.length, 1);
  assert.throws(() => removeQuestion({ ...def, lessons: [] }, 0), /at least one/);
});

test('question factories never reuse existing IDs and return independent choice arrays', () => {
  const first = newQuestion([]), second = newQuestion([first]), third = newQuestion([first, second]);
  assert.deepEqual([first.id, second.id, third.id], ['question-1', 'question-2', 'question-3']);
  first.choices[0].label = 'Changed'; assert.equal(second.choices[0].label, 'First answer');
  const def = definition(); def.assessment = { id: def.id, version: 1, questions: [first, second, third] };
  validateDefinition(def);
});
