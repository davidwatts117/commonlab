// Operator-only local traces. Only the supervisor creates/writes files; the child uses the redactor and a dedicated pipe.
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILURE_CODES, safeDetails } from './protocol.mjs';
const TRACE_NAME = /^generation-\d+-\d+-[a-f0-9-]+\.jsonl$/;
const OMIT = /^(?:api[-_]?key|authorization|proxy-authorization|cookies?|set-cookie|password|access[-_]?token|refresh[-_]?token|worker[-_]?token|thinking|thinkingSignature|thoughtSignature|reasoning|reasoning_content)$/i;

export function redactTrace(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret && secret.length >= 8) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]+/gi, '$1 [REDACTED]').replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.filter(item => !['thinking', 'reasoning'].includes(item?.type)).map(item => redactTrace(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !OMIT.test(key)).map(([key, child]) => [key, redactTrace(child, secrets)]));
  return value;
}
function integer(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === '') return fallback;
  if (!/^\d+$/.test(env[key]) || !Number.isSafeInteger(Number(env[key])) || Number(env[key]) < min || Number(env[key]) > max) throw new Error(`Invalid ${key}`);
  return Number(env[key]);
}
export class TraceStore {
  static fromEnv(env = process.env, warn) {
    if (!env.CL_AGENT_TRACE_DIR) return null;
    return new TraceStore(env.CL_AGENT_TRACE_DIR, {
      maxFiles: integer(env, 'CL_AGENT_TRACE_MAX_FILES', 50, 1, 1000),
      maxBytes: integer(env, 'CL_AGENT_TRACE_MAX_BYTES', 8 * 1024 * 1024, 65536, 64 * 1024 * 1024),
      maxDays: integer(env, 'CL_AGENT_TRACE_MAX_DAYS', 7, 1, 90),
      secrets: Object.entries(env).filter(([key]) => /key|token|secret|password/i.test(key)).map(([, value]) => value), warn,
    });
  }
  constructor(directory, { maxFiles = 50, maxBytes = 8 * 1024 * 1024, maxDays = 7, secrets = [], warn = () => console.error('Agent trace write failed; generation continues without further trace records.') } = {}) {
    if (!isAbsolute(directory)) throw new Error('Trace directory must be an absolute private path');
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    const child = relative(publicDir, resolve(directory));
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) throw new Error('Trace directory must not be publicly served');
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== resolve(directory) || (info.mode & 0o077) !== 0) throw new Error('Trace directory must be private, nonsymlinked and mode 0700');
    this.directory = directory; this.maxFiles = maxFiles; this.maxBytes = maxBytes; this.maxDays = maxDays; this.secrets = secrets; this.warn = warn;
  }
  create(job) {
    if (!Number.isSafeInteger(job.id) || job.id < 1) throw new Error('Trace needs an opaque numeric job ID');
    const files = readdirSync(this.directory).filter(name => TRACE_NAME.test(name)).map(name => ({ path: join(this.directory, name), info: lstatSync(join(this.directory, name)) })).filter(file => file.info.isFile() && !file.info.isSymbolicLink()).sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
    const cutoff = Date.now() - this.maxDays * 86400000;
    while (files.length && files[0].info.mtimeMs < cutoff) unlinkSync(files.shift().path);
    while (files.length >= this.maxFiles) unlinkSync(files.shift().path);
    const path = join(this.directory, `generation-${job.id}-${Date.now()}-${randomUUID()}.jsonl`);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if ((fstatSync(fd).mode & 0o077) !== 0) { closeSync(fd); throw new Error('Trace file permissions are not private'); }
    let bytes = 0, truncated = false, closed = false, failed = false;
    const append = record => {
      const line = JSON.stringify(redactTrace({ at: new Date().toISOString(), ...record }, this.secrets)) + '\n';
      const buffer = Buffer.from(line);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      bytes += buffer.length;
    };
    const write = (kind, data = {}) => {
      if (closed || failed || truncated) return;
      try {
        const record = { kind, data: redactTrace(data, this.secrets) };
        const size = Buffer.byteLength(JSON.stringify(record)) + 100;
        if (bytes + size > this.maxBytes - 4096) { truncated = true; append({ kind: 'trace_truncated', data: { maxBytes: this.maxBytes } }); return; }
        append(record);
      } catch { failed = true; this.warn(); }
    };
    write('trace_header', { traceVersion: 1, harness: 'staged-development', jobId: job.id, simulationId: job.simulationId, requirements: job.prompt, excludes: ['private reasoning', 'auth headers', 'known operator credentials'] });
    if (failed) { closeSync(fd); closed = true; throw new Error('Could not initialize private agent trace'); }
    return { path, write, finish: outcome => {
      if (closed) return;
      try { if (!failed) { append({ kind: 'outcome', data: { status: ['succeeded', 'failed', 'interrupted'].includes(outcome.status) ? outcome.status : 'failed', ...(FAILURE_CODES.has(outcome.failure) ? { failure: outcome.failure } : {}), diagnostics: safeDetails(outcome.diagnostics), traceTruncated: truncated } }); fsyncSync(fd); } }
      catch { this.warn(); }
      finally { closeSync(fd); closed = true; }
    } };
  }
}
