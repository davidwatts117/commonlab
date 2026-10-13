import { validateDefinition } from './simulation-schema.mjs';

export const MAX_BUNDLE_BYTES = 1024 * 1024;
const bytes = value => new TextEncoder().encode(value).length;
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${name} fields.`);
}

/** JSON-only portable drafts. Engine source is text, never imported or evaluated. */
export function validateBundle(bundle, installedIds) {
  object(bundle, ['bundleVersion', 'definition', 'source', 'submittedBy'], 'submission bundle');
  if (bundle.bundleVersion !== 1) throw new Error('Unsupported submission bundle version.');
  validateDefinition(bundle.definition);
  if (bytes(JSON.stringify(bundle.definition)) > 64 * 1024) throw new Error('Definition exceeds 64 KiB.');
  if (typeof bundle.submittedBy !== 'string' || [...bundle.submittedBy].length > 100) throw new Error('Submitter name must be at most 100 characters.');
  const source = bundle.source;
  object(source, ['kind', 'engineId', 'moduleCode'], 'bundle source');
  if (source.kind === 'installed') {
    if (Object.hasOwn(source, 'moduleCode') || typeof source.engineId !== 'string' || !installedIds.includes(source.engineId)) throw new Error('Bundle references an unavailable installed engine.');
  } else if (source.kind === 'javascript') {
    if (Object.hasOwn(source, 'engineId') || typeof source.moduleCode !== 'string' || !source.moduleCode.trim() || bytes(source.moduleCode) > 128 * 1024) throw new Error('Bundle must contain a nonempty module of at most 128 KiB.');
  } else { throw new Error('Unknown bundle source kind.'); }
  return bundle;
}

export function createBundle(definition, source, submittedBy, installedIds) {
  return validateBundle({ bundleVersion: 1, definition, source, submittedBy }, installedIds);
}

export function parseBundle(text, installedIds) {
  if (typeof text !== 'string' || bytes(text) > MAX_BUNDLE_BYTES) throw new Error('Submission bundle exceeds 1 MiB.');
  let bundle;
  try { bundle = JSON.parse(text); }
  catch (error) { throw new Error(`Submission bundle is not valid JSON: ${error.message}`, { cause: error }); }
  return validateBundle(bundle, installedIds);
}

/** Keep file-format metadata out of the server's closed request format. */
export function submissionRequest(bundle, installedIds) {
  validateBundle(bundle, installedIds);
  return { definition: bundle.definition, submittedBy: bundle.submittedBy, ...(bundle.source.kind === 'installed' ? { engineId: bundle.source.engineId } : { moduleCode: bundle.source.moduleCode }) };
}
