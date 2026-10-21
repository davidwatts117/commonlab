// Only bounded, value-free diagnostics cross the child/API boundary. Never forward raw exceptions.
export const FAILURE_CODES = new Set(['timeout', 'output_limit', 'request_limit', 'context_limit', 'provider_error', 'provider_auth', 'provider_rate_limit', 'provider_unavailable', 'output_truncated', 'repair_limit', 'no_progress', 'tool_protocol', 'not_finalized', 'worker_error', 'configuration_error']);
export const ACTIVITY_CODES = new Set(['model_request', 'model_finished', 'reference_contract', 'reference_schema', 'validating', 'validation_passed', 'validation_failed', 'finalized', 'duplicate_draft', 'tool_batch_rejected', 'repairing', 'development_stage', 'stage_completed', 'tool_result', 'draft_ready', 'verifying', 'visual_check_passed', 'visual_check_failed', 'review_started', 'review_passed', 'review_failed', ...FAILURE_CODES]);
export const RULES = new Set(['required', 'type', 'additionalProperties', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'oneOf', 'anyOf', 'schema', 'definition_size', 'module_size', 'assigned_id', 'slot_ids', 'range', 'question_keys', 'lesson_references', 'cross_field', 'javascript_syntax', 'module_scope', 'imports', 'mount']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred', 'unknown']);
export class GenerationError extends Error {
  constructor(code, diagnostics = {}) { super(code); this.code = FAILURE_CODES.has(code) ? code : 'worker_error'; this.diagnostics = diagnostics; }
}
export function failureCode(error) {
  if (error instanceof GenerationError) return error.code;
  return 'worker_error';
}
export function providerFailure(message = '') {
  // Classification only: never preserve the provider's raw text, URLs, headers or credentials.
  if (/\b(401|403)\b|unauthorized|invalid.api.key|authentication/i.test(message)) return 'provider_auth';
  if (/\b429\b|rate.limit|quota|insufficient.credit|billing/i.test(message)) return 'provider_rate_limit';
  if (/\b(500|502|503|504)\b|overloaded|unavailable|timed?.?out/i.test(message)) return 'provider_unavailable';
  return 'provider_error';
}
export function safeDetails(value = {}) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of ['turn', 'attempt', 'requests', 'contextBytes', 'inputTokens', 'outputTokens', 'toolCalls', 'validations', 'duplicates', 'maxTokens', 'verificationRounds', 'reviewRounds', 'tests', 'testsPassed', 'testsFailed', 'canvases', 'defects']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 10_000_000) result[key] = value[key];
  }
  if (STOP_REASONS.has(value.stopReason)) result.stopReason = value.stopReason;
  if (['plan', 'definition', 'implementation'].includes(value.phase)) result.phase = value.phase;
  if (['plan_simulation', 'define_simulation', 'submit_draft', 'review_critique', 'authoring_reference', 'unknown'].includes(value.tool)) result.tool = value.tool;
  if (['ok', 'error', 'blocked'].includes(value.toolStatus)) result.toolStatus = value.toolStatus;
  if (Array.isArray(value.issues)) result.issues = value.issues.slice(0, 5).filter(issue => issue && RULES.has(issue.rule) && typeof issue.path === 'string' && issue.path.length <= 180 && /^[/A-Za-z0-9_*~-]*$/.test(issue.path)).map(({ path, rule, line, column }) => ({ path, rule, ...(Number.isInteger(line) && line > 0 && line <= 1_000_000 ? { line } : {}), ...(Number.isInteger(column) && column >= 0 && column <= 1_000_000 ? { column } : {}) }));
  return result;
}
export function safeEvent(value) {
  if (!value || !ACTIVITY_CODES.has(value.code)) return null;
  return { code: value.code, details: safeDetails(value.details) };
}
