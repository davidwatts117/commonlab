import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore, redactTrace } from '../trace.mjs';
import { runChild } from '../supervisor.mjs';
import { generate } from '../runner.mjs';
import { job, planRound, definitionRound, engineRound, streamMessage, modelEnvironment } from './fixtures.mjs';
const temporary = () => mkdtempSync(join(tmpdir(), 'commonlab-traces-'));
const records = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('tracing is off without an env directory and rejects unsafe configuration', () => {
  assert.equal(TraceStore.fromEnv({}), null);
  assert.throws(() => TraceStore.fromEnv({ CL_AGENT_TRACE_DIR: 'relative' }));
  assert.throws(() => TraceStore.fromEnv({ CL_AGENT_TRACE_DIR: '/tmp/not-created', CL_AGENT_TRACE_MAX_FILES: '-1' }));
  assert.throws(() => new TraceStore(new URL('../../public/', import.meta.url).pathname));
});

test('full completed model/tool transcript and stage context are saved in private local JSONL, with no reasoning or credentials', async () => {
  const dir = temporary(), restore = modelEnvironment();
  try {
    const store = new TraceStore(dir, { secrets: [process.env.CL_MODEL_API_KEY] });
    const trace = store.create(job); let index = 0;
    const rounds = [planRound(), definitionRound(), engineRound()];
    const result = await generate(job, { streamOverride: (model) => streamMessage(model, rounds[index++]), onTrace: trace.write });
    trace.write('operator_probe', { apiKey: process.env.CL_MODEL_API_KEY, authorization: 'Bearer private-token', content: [{ type: 'thinking', thinking: 'private-reasoning' }, { type: 'text', text: `Provider echoed ${process.env.CL_MODEL_API_KEY}` }] });
    trace.finish({ status: 'succeeded', diagnostics: result.diagnostics });
    const text = readFileSync(trace.path, 'utf8'), data = records(trace.path);
    assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(trace.path).mode & 0o777, 0o600);
    assert.ok(data.some(record => record.kind === 'model_request' && record.data.context.messages.length));
    assert.ok(data.some(record => record.kind === 'tool_start' && record.data.name === 'submit_draft'));
    assert.ok(data.some(record => record.kind === 'tool_end' && record.data.result.content.length));
    assert.ok(text.includes('export function mount(ui)')); assert.ok(text.includes(job.prompt));
    assert.ok(!text.includes('private-reasoning')); assert.ok(!text.includes('private-token')); assert.ok(!text.includes(process.env.CL_MODEL_API_KEY));
    assert.equal(data.at(-1).kind, 'outcome'); assert.equal(data.at(-1).data.status, 'succeeded');
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test('retention removes oldest and expired traces, but never follows symlinks', () => {
  const dir = temporary(), outside = temporary();
  try {
    const store = new TraceStore(dir, { maxFiles: 2, maxDays: 1 });
    const old = store.create(job); old.finish({ status: 'failed' });
    utimesSync(old.path, new Date(0), new Date(0));
    const link = join(dir, 'generation-99-1-aaaa.jsonl');
    const privateFile = join(outside, 'keep'); writeFileSync(privateFile, 'untouched'); symlinkSync(privateFile, link);
    for (let i = 0; i < 5; i++) { const trace = store.create({ ...job, id: i + 1 }); trace.finish({ status: 'succeeded' }); }
    assert.equal(readdirSync(dir).filter(name => statSync(join(dir, name)).isFile() && name !== 'generation-99-1-aaaa.jsonl').length, 2);
    assert.equal(readFileSync(privateFile, 'utf8'), 'untouched');
    const symlinkDir = join(outside, 'link'); symlinkSync(dir, symlinkDir); assert.throws(() => new TraceStore(symlinkDir));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('size cap emits a truncation marker while reserving room for terminal diagnostics', () => {
  const dir = temporary();
  try {
    const trace = new TraceStore(dir, { maxBytes: 65536 }).create(job);
    trace.write('big_message', { source: 'x'.repeat(100000) });
    trace.write('later_message', { ignored: true });
    trace.finish({ status: 'failed', failure: 'output_truncated' });
    const data = records(trace.path);
    assert.ok(statSync(trace.path).size <= 65536);
    assert.ok(data.some(record => record.kind === 'trace_truncated'));
    assert.equal(data.at(-1).data.failure, 'output_truncated'); assert.equal(data.at(-1).data.traceTruncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supervisor saves terminal state even when the child is killed at its deadline', async () => {
  const dir = temporary();
  try {
    const trace = new TraceStore(dir).create(job);
    await assert.rejects(runChild(job, async () => true, { trace, runtimeMs: 1 }), error => error.code === 'timeout');
    assert.equal(records(trace.path).at(-1).data.failure, 'timeout');
    // A second close from a shutdown/finally path is harmless.
    trace.finish({ status: 'ignored' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('child only gets a trace pipe, not the operator trace directory or worker/application credentials', async () => {
  const dir = temporary(); const key = process.env.CL_MODEL_API_KEY; delete process.env.CL_MODEL_API_KEY;
  try {
    const trace = new TraceStore(dir).create(job);
    const result = await runChild(job, async () => true, { trace, runtimeMs: 10000 });
    assert.equal(result.failure, 'configuration_error');
    assert.equal(records(trace.path).at(-1).data.failure, 'configuration_error');
    assert.ok(!readFileSync(trace.path, 'utf8').includes('GENERATION_WORKER_TOKEN'));
  } finally { if (key !== undefined) process.env.CL_MODEL_API_KEY = key; rmSync(dir, { recursive: true, force: true }); }
});

test('redaction strips structured reasoning/signatures and known secret strings, not simulation source', () => {
  const result = redactTrace({ thinking: 'private', thinkingSignature: 'private', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'source code' }], message: 'Bearer abcdefghijklmnop sk-or-v1-abcdefghijklmnop', moduleCode: 'export function mount(ui) {}' });
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('abcdefghijklmnop'));
  assert.ok(result.moduleCode.includes('mount'));
});
