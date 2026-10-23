// Shared policy is also embedded by Axum. No credentials or generated content.
import { readFileSync } from 'node:fs';
function loadProtocol() {
  try {
    return JSON.parse(
      readFileSync(new URL('../schema/generation-protocol.json', import.meta.url), 'utf8'),
    );
  } catch {
    throw new Error('Bundled generation protocol is missing or invalid');
  }
}
export const PROTOCOL = loadProtocol();
export const FAILURE_CODES = new Set(PROTOCOL.failures);
export const ACTIVITY_CODES = new Set([...PROTOCOL.events, ...PROTOCOL.failures]);
export const RULES = new Set([
  'required',
  'type',
  'additionalProperties',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'oneOf',
  'anyOf',
  'schema',
  'definition_size',
  'module_size',
  'assigned_id',
  'slot_ids',
  'range',
  'question_keys',
  'lesson_references',
  'cross_field',
  'javascript_syntax',
  'module_scope',
  'imports',
  'mount',
]);
export class GenerationError extends Error {
  constructor(code, diagnostics = {}) {
    super(code);
    this.code = FAILURE_CODES.has(code) ? code : 'worker_error';
    this.diagnostics = diagnostics;
  }
}
export const failureCode = (error) =>
  error instanceof GenerationError ? error.code : 'worker_error';
export function providerFailure(message = '') {
  if (/\b(401|403)\b|unauthorized|invalid.api.key|authentication/i.test(message))
    return 'provider_auth';
  if (/\b429\b|rate.limit|quota|insufficient.credit|billing/i.test(message))
    return 'provider_rate_limit';
  if (
    /\b(408|5\d\d)\b|overloaded|unavailable|timed?.?out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|terminated|fetch failed|other side closed|premature close|UND_ERR/i.test(
      message,
    )
  )
    return 'provider_unavailable';
  return 'provider_error';
}
export function safeDetails(value = {}) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of PROTOCOL.counters)
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= PROTOCOL.counterMax)
      result[key] = value[key];
  for (const [key, choices] of Object.entries({
    phase: PROTOCOL.phases,
    tool: PROTOCOL.tools,
    cause: PROTOCOL.failures,
    role: ['author', 'reviewer', 'host'],
    reasoningEffort: PROTOCOL.reasoningEfforts,
    stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred', 'unknown'],
    toolStatus: ['ok', 'error', 'blocked'],
  }))
    if (choices.includes(value[key])) result[key] = value[key];
  if (/^[a-f0-9]{64}$/.test(value.artifactHash || '')) result.artifactHash = value.artifactHash;
  if (Array.isArray(value.issues))
    result.issues = value.issues
      .slice(0, 5)
      .filter(
        (i) =>
          i &&
          RULES.has(i.rule) &&
          typeof i.path === 'string' &&
          i.path.length <= 180 &&
          /^[/A-Za-z0-9_*~-]*$/.test(i.path),
      )
      .map(({ path, rule, line, column }) => ({
        path,
        rule,
        ...(Number.isInteger(line) && line > 0 && line <= 1_000_000 ? { line } : {}),
        ...(Number.isInteger(column) && column >= 0 && column <= 1_000_000 ? { column } : {}),
      }));
  return result;
}
export const safeEvent = (value) =>
  value && ACTIVITY_CODES.has(value.code)
    ? { code: value.code, details: safeDetails(value.details) }
    : null;
