import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './policy.mjs';
import { ACTIVITY_CODES, FAILURE_CODES, GenerationError, safeDetails, safeEvent } from './protocol.mjs';
import { TraceStore } from './trace.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Poll the lease; stop on an explicit `false`, or after `maxFailures` consecutive check errors
 *  so one network blip does not waste a contributor's quota. Returns a function that cancels polling. */
export function watchLease(stillActive, stop, { pollMs = 5000, maxFailures = 3 } = {}) {
  let checking = false, failures = 0;
  const poll = setInterval(async () => {
    if (checking) return; checking = true;
    try { const active = await stillActive(); failures = 0; if (!active) stop(); }
    catch { if (++failures >= maxFailures) stop(); }
    finally { checking = false; }
  }, pollMs);
  return () => clearInterval(poll);
}
export async function runChild(job, stillActive, { runtimeMs = LIMITS.runtimeMs, signal, onProgress = () => {}, trace = null, ...watch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-worker-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url))], {
        cwd: dir, stdio: ['pipe', 'pipe', 'pipe', trace ? 'pipe' : 'ignore'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8',
          CL_MODEL_PROVIDER: process.env.CL_MODEL_PROVIDER || '', CL_MODEL_ID: process.env.CL_MODEL_ID || '', CL_MODEL_API_KEY: process.env.CL_MODEL_API_KEY || '',
          CL_REVIEW_MODEL_PROVIDER: process.env.CL_REVIEW_MODEL_PROVIDER || '', CL_REVIEW_MODEL_ID: process.env.CL_REVIEW_MODEL_ID || '', CL_REVIEW_MODEL_API_KEY: process.env.CL_REVIEW_MODEL_API_KEY || '', CL_REVIEW_IMAGES: process.env.CL_REVIEW_IMAGES || '', CL_AUTHOR_IMAGES: process.env.CL_AUTHOR_IMAGES || '',
          CL_PUBLIC_ROOT: process.env.CL_PUBLIC_ROOT || '/app/public', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '', PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '',
          CL_AGENT_TRACE_PIPE: trace ? '1' : '0' },
      });
      let output = '', stopped = false, failure = 'worker_error', pending = '', eventBytes = 0, eventCount = 0, diagnostics = {};
      if (trace) {
        let tracePending = '', traceBytes = 0;
        child.stdio[3].setEncoding('utf8');
        child.stdio[3].on('data', chunk => {
          traceBytes += Buffer.byteLength(chunk);
          // Always drain the pipe, but never let diagnostic output exhaust supervisor memory.
          if (traceBytes > 32 * 1024 * 1024) { tracePending = ''; return; }
          tracePending += chunk;
          if (Buffer.byteLength(tracePending) > 4 * 1024 * 1024) { tracePending = ''; return; }
          let end;
          while ((end = tracePending.indexOf('\n')) >= 0) {
            const line = tracePending.slice(0, end); tracePending = tracePending.slice(end + 1);
            try { const record = JSON.parse(line); if (['activity', 'message', 'tool_start', 'tool_end', 'model_request', 'request_error', 'generation_complete', 'generation_failed'].includes(record.kind)) trace.write(record.kind, record.data); } catch { /* No raw diagnostic output in ordinary logs or API events. */ }
          }
        });
      }
      const stop = () => { stopped = true; child.kill('SIGKILL'); };
      const deadline = setTimeout(() => { failure = 'timeout'; stop(); }, runtimeMs);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        eventBytes += Buffer.byteLength(chunk);
        if (eventBytes > 65536) { failure = 'output_limit'; stop(); return; }
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const event = safeEvent(JSON.parse(line));
            if (event && ++eventCount <= 90) {
              if (FAILURE_CODES.has(event.code)) failure = event.code;
              diagnostics = { ...diagnostics, ...event.details };
              onProgress(event.code, event.details);
            }
          } catch { /* Never forward raw child output. */ }
        }
      });
      const unwatch = watchLease(stillActive, stop, watch);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const clean = () => { clearTimeout(deadline); unwatch(); signal?.removeEventListener('abort', stop); };
      child.on('error', () => { clean(); trace?.finish({ status: 'failed', failure: 'worker_error', diagnostics }); reject(new GenerationError('worker_error', diagnostics)); });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > LIMITS.outputBytes) { failure = 'output_limit'; stop(); } });
      child.on('close', code => {
        clean();
        if (stopped || code !== 0) { trace?.finish({ status: signal?.aborted ? 'interrupted' : 'failed', failure, diagnostics }); reject(new GenerationError(failure, diagnostics)); return; }
        try {
          const result = JSON.parse(output);
          if (!result || typeof result.model !== 'string' || result.model.length > 200 || (!result.artifact && !FAILURE_CODES.has(result.failure))) throw new Error('Invalid result');
          trace?.finish({ status: result.artifact ? 'succeeded' : 'failed', failure: result.failure, diagnostics: safeDetails(result.diagnostics) });
          resolve({ artifact: result.artifact || null, model: result.model, ...(result.artifact ? {} : { failure: result.failure }), diagnostics: safeDetails(result.diagnostics) });
        } catch { trace?.finish({ status: 'failed', failure: 'worker_error', diagnostics }); reject(new GenerationError('worker_error', diagnostics)); }
      });
      // The lease, worker token, account identity, cookies and application URL are deliberately absent.
      child.stdin.end(JSON.stringify({ prompt: job.prompt, simulationId: job.simulationId }));
    });
  } finally { trace?.finish({ status: 'interrupted', failure: 'worker_error' }); await rm(dir, { recursive: true, force: true }); }
}
/** Retry result DELIVERY only, never model generation. A 409 means the lease/result is no longer writable. */
export async function deliverResult(send, wait = sleep) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await send(); }
    catch (error) {
      if (error.status === 409) return null;
      if (attempt === 2 || (error.status && error.status < 500)) throw error;
      await wait(500 * (attempt + 1));
    }
  }
}
async function main() {
  let base;
  try { base = new URL(process.env.CL_API_BASE_URL || ''); }
  catch { throw new Error('Invalid application origin.'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && process.env.CL_WORKER_ALLOW_HTTP === 'true'))) throw new Error('Use an HTTPS application origin (explicit private-network HTTP opt-in for development).');
  const token = process.env.GENERATION_WORKER_TOKEN;
  if (!token || token.length < 32 || !['anthropic', 'openai', 'google', 'openrouter'].includes(process.env.CL_MODEL_PROVIDER) || !process.env.CL_MODEL_ID || !process.env.CL_MODEL_API_KEY) throw new Error('Missing explicit worker/model configuration.');
  async function api(path, body, timeoutMs = 10000) {
    const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!response.ok) { const error = new Error('Worker API request failed.'); error.status = response.status; throw error; }
    return response.json();
  }
  // Validate private tracing configuration before claiming any paid work. The child sees only a pipe.
  const traceStore = TraceStore.fromEnv();
  const shutdown = new AbortController();
  process.on('SIGTERM', () => shutdown.abort()); process.on('SIGINT', () => shutdown.abort());
  while (!shutdown.signal.aborted) {
    try {
      const job = await api('/api/worker/generation/claim');
      if (!job) { await sleep(2000); continue; }
      if (job.protocolVersion !== 1) throw new Error('Unsupported worker protocol.');
      let result = { artifact: null, model: `${process.env.CL_MODEL_PROVIDER}/${process.env.CL_MODEL_ID}` };
      let progressQueue = Promise.resolve();
      let reports = 0, progressEnabled = true;
      const report = (code, details = {}) => {
        if (!ACTIVITY_CODES.has(code) || ++reports > 90) return;
        progressQueue = progressQueue.then(() => progressEnabled ? api(`/api/worker/generation/${job.id}/progress`, { lease: job.lease, code, details: safeDetails(details) }, 1500) : undefined).catch(() => { progressEnabled = false; });
      };
      let trace;
      try {
        try { trace = traceStore?.create(job); } catch { console.error('Private agent trace could not be created; no model call was made.'); throw new GenerationError('configuration_error'); }
        result = await runChild(job, async () => (await api(`/api/worker/generation/${job.id}/check`, { lease: job.lease })).active, { signal: shutdown.signal, onProgress: report, trace }); }
      catch (error) {
        result.failure = FAILURE_CODES.has(error.code) ? error.code : 'worker_error';
        result.diagnostics = safeDetails(error.diagnostics);
        report(result.failure, result.diagnostics);
        if (shutdown.signal.aborted) {
          // A redeploy is not the contributor's failure: requeue instead of using up their quota.
          await api(`/api/worker/generation/${job.id}/release`, { lease: job.lease });
          break;
        }
        console.error('Generation failed or hit a limit; no artifact published.');
      }
      // Give best-effort activity a short drain window. A broken activity API must not delay completion.
      await Promise.race([progressQueue, sleep(2000)]);
      progressEnabled = false;
      await deliverResult(() => api(`/api/worker/generation/${job.id}/complete`, { lease: job.lease, ...result }));
    } catch {
      if (shutdown.signal.aborted) break;
      console.error('Generation worker unavailable; retrying connection.'); await sleep(2000);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Invalid generation worker configuration. Check origin, credentials, model and private trace-directory settings.'); process.exitCode = 1; });
}
