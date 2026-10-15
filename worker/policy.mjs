import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import Ajv from 'ajv/dist/2020.js';
import { validateDefinition } from '../public/simulation-schema.mjs';
function parseJson(text) { try { return JSON.parse(text); } catch { throw new Error('Invalid JSON.'); } }
const schema = parseJson(readFileSync(new URL('../schema/simulation.schema.json', import.meta.url)));
const validateSchema = new Ajv({ strict: false, allErrors: true }).compile(schema);
export const LIMITS = Object.freeze({ requests: 6, maxTokens: 8192, contextBytes: 128 * 1024, runtimeMs: 300_000, outputBytes: 220 * 1024 });
export function validateDraft(input, simulationId) {
  if (!input || typeof input.definitionJson !== 'string' || typeof input.moduleCode !== 'string') throw new Error('Provide definitionJson and moduleCode strings.');
  if (Buffer.byteLength(input.definitionJson) > 64 * 1024 || Buffer.byteLength(input.moduleCode) > 128 * 1024) throw new Error('Definition/code size limit exceeded.');
  const definition = parseJson(input.definitionJson);
  if (!validateSchema(definition)) throw new Error(JSON.stringify(validateSchema.errors).slice(0, 4000));
  validateDefinition(definition);
  if (definition.id !== simulationId || (definition.assessment && definition.assessment.id !== simulationId)) throw new Error('Use the assigned simulation ID for the definition and assessment bank.');
  const tree = parse(input.moduleCode, { ecmaVersion: 'latest', sourceType: 'module' });
  let mount = false;
  for (const node of tree.body) {
    if (node.type === 'FunctionDeclaration') continue;
    if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'FunctionDeclaration' || node.declaration.id?.name !== 'mount' || node.declaration.async || mount) throw new Error('Only helper function declarations and one export function mount(ui) are allowed at module scope.');
    mount = true;
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') throw new Error('Generated engines must be self-contained: imports are not allowed.');
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(tree);
  if (!mount) throw new Error('Export a synchronous mount(ui) function.');
  return { definition, moduleCode: input.moduleCode };
}
export function boundedStream(stream, finished, limits = LIMITS) {
  let requests = 0;
  return (model, context, options) => {
    if (finished()) throw new Error('Draft finalized; no further model requests allowed.');
    if (++requests > limits.requests || Buffer.byteLength(JSON.stringify(context)) > limits.contextBytes) throw new Error('Model request/context limit reached.');
    return stream(model, context, { ...options, maxTokens: limits.maxTokens });
  };
}
