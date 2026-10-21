import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import Ajv from 'ajv/dist/2020.js';
import { validateDefinition } from '../public/simulation-schema.mjs';
import { GenerationError, RULES } from './protocol.mjs';
function loadSchema() {
  try {
    return JSON.parse(readFileSync(new URL('../schema/simulation.schema.json', import.meta.url)));
  } catch {
    throw new GenerationError('configuration_error');
  }
}
export const schema = loadSchema();
// Select the actual component variant instead of reporting errors from all 13 oneOf branches.
const diagnosticSchema = structuredClone(schema);
diagnosticSchema.$defs.component.discriminator = { propertyName: 'type' };
const validateSchema = new Ajv({ strict: false, allErrors: true, discriminator: true }).compile(
  diagnosticSchema,
);
const propertyNames = new Set(['definition', 'moduleCode']);
function collectProperties(node) {
  if (!node || typeof node !== 'object') return;
  if (node.properties) Object.keys(node.properties).forEach((key) => propertyNames.add(key));
  Object.values(node).forEach((value) => {
    if (Array.isArray(value)) value.forEach(collectProperties);
    else if (value && typeof value === 'object') collectProperties(value);
  });
}
collectProperties(schema);
function safePath(path) {
  return path
    .split('/')
    .map((part) => (propertyNames.has(part) || /^\d{1,5}$/.test(part) || part === '' ? part : '*'))
    .join('/')
    .slice(0, 180);
}
export class DraftValidationError extends Error {
  constructor(issues, modelMessage) {
    super(modelMessage || issues.map((issue) => `${issue.path || '/'}: ${issue.rule}`).join('\n'));
    this.issues = issues.slice(0, 5);
  }
}
const invalid = (path, rule, message) => {
  throw new DraftValidationError([{ path, rule }], message);
};
export function validateDraft(input, simulationId) {
  if (
    !input ||
    !input.definition ||
    typeof input.definition !== 'object' ||
    Array.isArray(input.definition)
  )
    invalid('/definition', 'type', 'definition must be a JSON object, not a JSON-encoded string.');
  if (typeof input.moduleCode !== 'string')
    invalid('/moduleCode', 'type', 'moduleCode must be JavaScript source text.');
  const definition = input.definition;
  if (Buffer.byteLength(JSON.stringify(definition)) > 64 * 1024)
    invalid('/definition', 'definition_size', 'Serialized definition must be at most 64 KiB.');
  if (Buffer.byteLength(input.moduleCode) > 128 * 1024)
    invalid('/moduleCode', 'module_size', 'Engine source must be at most 128 KiB.');
  if (!validateSchema(definition)) {
    const issues = validateSchema.errors.slice(0, 5).map((error) => ({
      path:
        safePath(
          `${error.instancePath}${error.keyword === 'required' ? `/${error.params.missingProperty}` : ''}`,
        ) || '/',
      rule: RULES.has(error.keyword) ? error.keyword : 'schema',
    }));
    // Schema-owned messages contain constraints, never raw values from the generated draft.
    const guidance = validateSchema.errors
      .slice(0, 5)
      .map((error, index) => `${issues[index].path}: ${error.message}`)
      .join('\n');
    throw new DraftValidationError(issues, guidance);
  }
  try {
    validateDefinition(definition);
  } catch (error) {
    const message = String(error.message);
    const rule = /slot id/.test(message)
      ? 'slot_ids'
      : /range|default|selection/.test(message)
        ? 'range'
        : /question|answer|correct/.test(message)
          ? 'question_keys'
          : /lesson|checkpoint|condition|adapter/.test(message)
            ? 'lesson_references'
            : 'cross_field';
    // Detailed generated IDs are useful to the model but are not sent to the UI or persisted.
    invalid('/definition', rule, message.slice(0, 1200));
  }
  if (
    definition.id !== simulationId ||
    (definition.assessment && definition.assessment.id !== simulationId)
  )
    invalid(
      '/id',
      'assigned_id',
      'Use the assigned simulation ID for definition.id and assessment.id.',
    );
  let tree;
  try {
    tree = parse(input.moduleCode, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (error) {
    const line = error.loc?.line || 1,
      column = error.loc?.column || 0;
    throw new DraftValidationError(
      [{ path: '/moduleCode', rule: 'javascript_syntax', line, column }],
      `JavaScript syntax error at line ${line}, column ${column}.`,
    );
  }
  let mount = false;
  for (const node of tree.body) {
    if (node.type === 'FunctionDeclaration') continue;
    if (
      node.type !== 'ExportNamedDeclaration' ||
      node.declaration?.type !== 'FunctionDeclaration' ||
      node.declaration.id?.name !== 'mount' ||
      node.declaration.async ||
      node.declaration.generator ||
      mount
    )
      invalid(
        '/moduleCode',
        'module_scope',
        'Only helper function declarations and one synchronous export function mount(ui) are allowed at module scope. Put constants/classes/initialization inside mount.',
      );
    if (node.declaration.params.length !== 1 || node.declaration.params[0].type !== 'Identifier')
      invalid(
        '/moduleCode',
        'mount',
        'Export a synchronous mount(ui) function with one named parameter.',
      );
    mount = true;
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration')
      invalid(
        '/moduleCode',
        'imports',
        'Generated engines must be self-contained: imports are not allowed.',
      );
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
  }
  visit(tree);
  if (!mount) invalid('/moduleCode', 'mount', 'Export a synchronous mount(ui) function.');
  return { definition, moduleCode: input.moduleCode };
}
