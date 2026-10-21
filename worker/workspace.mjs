import { parse } from 'acorn';
import { validateDraft } from './policy.mjs';
import { hash } from './checkpoints.mjs';
export const FILES = ['definition.json', 'engine.js', 'tests.json', 'tests.js'];
const SIZES = {
  'definition.json': 65536,
  'engine.js': 131072,
  'tests.json': 32768,
  'tests.js': 65536,
};
export function supportedDefinition(definition) {
  if (definition.lessons?.length || definition.assessment)
    throw new Error(
      'Verified generation currently covers science engines, controls and graphs only. Use lessons: [] and omit assessment; learning content can be added in the manual editor.',
    );
}
export function validateManifest(manifest) {
  if (
    !manifest ||
    Object.keys(manifest).some((k) => k !== 'cases') ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length > 12
  )
    throw new Error('Manifest must have at most 12 cases');
  const names = new Set();
  for (const test of manifest.cases) {
    if (
      Object.keys(test).some((k) => !['name', 'steps'].includes(k)) ||
      typeof test.name !== 'string' ||
      !test.name.trim() ||
      test.name.length > 120 ||
      names.has(test.name) ||
      !Array.isArray(test.steps) ||
      test.steps.length < 1 ||
      test.steps.length > 30
    )
      throw new Error('Each case needs a unique name and 1–30 steps');
    names.add(test.name);
    let assertions = 0;
    for (const s of test.steps) {
      const keys = {
        set: ['id', 'value'],
        select: ['id', 'value'],
        click: ['id'],
        check: ['id', 'checked'],
        reset: [],
        step: ['seconds'],
        expectText: ['id', 'equals', 'contains', 'nonEmpty'],
        expectValue: ['id', 'equals'],
        expectVisible: ['id', 'equals'],
        expectChecked: ['id', 'equals'],
        expectCanvas: ['id', 'nonBlank', 'minColors', 'minInkFraction', 'maxInkFraction'],
      }[s?.action];
      if (!keys || Object.keys(s).some((k) => k !== 'action' && !keys.includes(k)))
        throw new Error('Unknown test action or property');
      if (
        keys.includes('id') &&
        (typeof s.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(s.id))
      )
        throw new Error('Test step requires a declared slot ID');
      if (['set', 'select'].includes(s.action) && !['number', 'string'].includes(typeof s.value))
        throw new Error('set/select needs a value');
      if (s.action === 'step' && (!Number.isFinite(s.seconds) || s.seconds < 0 || s.seconds > 10))
        throw new Error('step seconds must be 0–10');
      if (s.action === 'check' && typeof s.checked !== 'boolean')
        throw new Error('check needs a boolean');
      for (const key of ['nonEmpty', 'nonBlank'])
        if (key in s && typeof s[key] !== 'boolean')
          throw new Error('Assertion flags must be boolean');
      if (
        ['expectVisible', 'expectChecked'].includes(s.action) &&
        'equals' in s &&
        typeof s.equals !== 'boolean'
      )
        throw new Error('Visibility/checked expectations must be boolean');
      if (s.action.startsWith('expect')) {
        assertions++;
        if (
          s.action === 'expectText' &&
          !('equals' in s) &&
          !('contains' in s) &&
          s.nonEmpty !== true
        )
          throw new Error('Text assertion needs an expectation');
        if (s.action === 'expectValue' && !('equals' in s))
          throw new Error('Value assertion needs equals');
        if (s.action === 'expectCanvas' && !keys.slice(1).some((k) => k in s))
          throw new Error('Canvas assertion needs an expectation');
        for (const k of ['equals', 'contains'])
          if (k in s && !['string', 'number', 'boolean'].includes(typeof s[k]))
            throw new Error('Invalid expected scalar');
        for (const k of ['minColors', 'minInkFraction', 'maxInkFraction'])
          if (k in s && (!Number.isFinite(s[k]) || s[k] < 0))
            throw new Error('Invalid canvas constraint');
      }
    }
    if (!assertions) throw new Error('Every case needs at least one assertion');
  }
  return manifest;
}
export class Workspace {
  constructor(files = {}, requiredCases = []) {
    this.files = { ...files };
    this.requiredCases = structuredClone(requiredCases);
  }
  get(name) {
    if (!FILES.includes(name)) throw new Error('Only named simulation artifacts are accessible');
    return this.files[name] || '';
  }
  write(name, content, expectedHash, append = false) {
    const before = this.get(name);
    if (expectedHash !== hash(before))
      throw new Error(`Artifact changed. Read ${name} and use its current hash.`);
    if (typeof content !== 'string') throw new Error('Artifact content must be text');
    const next = append ? before + content : content;
    if (Buffer.byteLength(next) > SIZES[name]) throw new Error('Artifact size limit');
    this.files[name] = next;
    return hash(next);
  }
  edit(name, oldText, newText, expectedHash) {
    const before = this.get(name);
    if (!oldText || before.split(oldText).length !== 2)
      throw new Error('Exact edit must match once');
    return this.write(
      name,
      before.replace(oldText, () => newText),
      expectedHash,
    );
  }
  inventory() {
    return FILES.map((name) => ({
      name,
      hash: hash(this.get(name)),
      bytes: Buffer.byteLength(this.get(name)),
    }));
  }
  artifact(simulationId) {
    let definition, manifest;
    try {
      definition = JSON.parse(this.get('definition.json'));
      manifest = JSON.parse(this.get('tests.json') || '{"cases":[]}');
    } catch {
      throw new Error('Definition/tests manifest is not valid JSON');
    }
    supportedDefinition(definition);
    definition.id = simulationId;
    if (definition.assessment) definition.assessment.id = simulationId;
    for (const lesson of definition.lessons || []) lesson.sim = simulationId;
    validateDraft({ definition, moduleCode: this.get('engine.js') }, simulationId);
    validateManifest(manifest);
    const source = this.get('tests.js');
    if (!manifest.cases.length && !this.requiredCases.length && !source.trim())
      throw new Error('Author tests are required');
    if (source) {
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (['ImportDeclaration', 'ImportExpression'].includes(node.type))
          throw new Error('Test imports are forbidden');
        for (const v of Object.values(node))
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') walk(v);
      };
      walk(ast);
    }
    // Previously required checks remain executable even if the author removes or weakens them.
    const combined = [...manifest.cases];
    for (const required of this.requiredCases)
      if (!combined.some((c) => hash(c) === hash(required))) combined.push(required);
    if (combined.length > 24)
      throw new Error('Too many changed baseline checks; preserve and repair existing tests');
    return {
      definition,
      moduleCode: this.get('engine.js'),
      tests: { manifest: { cases: combined }, module: source },
    };
  }
  freezeTests(artifact) {
    this.requiredCases = structuredClone(artifact.tests.manifest.cases);
  }
}
