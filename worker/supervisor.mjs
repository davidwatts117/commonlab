import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, FAILURE_CODES, GenerationError, safeDetails, safeEvent } from './protocol.mjs';
import { TraceStore } from './trace.mjs';
import { CheckpointStore, atomicJson, hash } from './checkpoints.mjs';
import { preflight } from './preflight.mjs';
import { operatorEvent, operatorError } from './log.mjs';
import { processIdentity, stopRecordedProcess } from './processes.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function watchLease(renew, stop, { pollMs = PROTOCOL.heartbeatMs, maxFailures = 3 } = {}) {
  let checking = false,
    failures = 0;
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const active = await renew();
      failures = 0;
      if (!active) stop('lease_lost');
    } catch {
      if (++failures >= maxFailures) stop('lease_lost');
    } finally {
      checking = false;
    }
  }, pollMs);
  return () => clearInterval(poll);
}
export async function runChild(
  job,
  stillActive,
  {
    runtimeMs = Math.max(
      1,
      (job.deadlineAt || Date.now() / 1000 + PROTOCOL.jobSeconds) * 1000 -
        Date.now() -
        PROTOCOL.deliveryReserveMs,
    ),
    signal,
    onProgress = () => {},
    trace = null,
    checkpointDir,
    onStarted = async () => {},
    ...watch
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-worker-'));
  const temporaryStore = !checkpointDir;
  if (!checkpointDir) checkpointDir = join(dir, 'checkpoints');
  await CheckpointStore.open(checkpointDir);
  try {
    return await new Promise((resolve, reject) => {
      const env = {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: dir,
        LANG: 'C.UTF-8',
        CL_CHECKPOINT_DIR: checkpointDir,
        CL_AGENT_TRACE_PIPE: trace ? '1' : '0',
      };
      for (const k of [
        'CL_MODEL_PROVIDER',
        'CL_MODEL_ID',
        'CL_MODEL_API_KEY',
        'CL_REVIEW_MODEL_PROVIDER',
        'CL_REVIEW_MODEL_ID',
        'CL_REVIEW_MODEL_API_KEY',
        'CL_REVIEW_IMAGES',
        'CL_AUTHOR_IMAGES',
        'CL_PUBLIC_ROOT',
        'PLAYWRIGHT_BROWSERS_PATH',
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE',
      ])
        if (process.env[k]) env[k] = process.env[k];
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./runner.mjs', import.meta.url))],
        {
          cwd: dir,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe', trace ? 'pipe' : 'ignore'],
          env,
        },
      );
      let output = '',
        pending = '',
        tracePending = '',
        traceBytes = 0,
        eventBytes = 0,
        failure = null,
        diagnostics = {};
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const stop = (code) => {
        failure = code || 'worker_error';
        kill();
      };
      const abort = () => stop('worker_error');
      const deadline = setTimeout(() => stop('timeout'), runtimeMs);
      const unwatch = stillActive ? watchLease(stillActive, stop, watch) : () => {};
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const clean = () => {
        clearTimeout(deadline);
        unwatch();
        signal?.removeEventListener('abort', abort);
        kill();
      };
      if (trace) {
        child.stdio[3].setEncoding('utf8');
        child.stdio[3].on('data', (chunk) => {
          traceBytes += Buffer.byteLength(chunk);
          if (traceBytes > 32 * 1024 * 1024) return;
          tracePending += chunk;
          if (Buffer.byteLength(tracePending) > 4 * 1024 * 1024) {
            tracePending = '';
            return;
          }
          let end;
          while ((end = tracePending.indexOf('\n')) >= 0) {
            const line = tracePending.slice(0, end);
            tracePending = tracePending.slice(end + 1);
            try {
              const record = JSON.parse(line);
              if (typeof record.kind === 'string' && /^[a-z_]{1,40}$/.test(record.kind))
                trace.write(record.kind, record.data);
            } catch {
              /* private pipe framing only */
            }
          }
        });
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        eventBytes += Buffer.byteLength(chunk);
        if (eventBytes > 256 * 1024) {
          stop('output_limit');
          return;
        }
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const e = safeEvent(JSON.parse(line));
            if (e) {
              diagnostics = { ...diagnostics, ...e.details };
              onProgress(e.code, e.details);
            }
          } catch {
            /* never forward arbitrary stderr */
          }
        }
      });
      child.on('error', () => {
        clean();
        reject(new GenerationError('worker_error', diagnostics));
      });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > 512 * 1024) stop('output_limit');
      });
      child.on('close', (code) => {
        clean();
        if (failure || code !== 0) {
          trace?.finish({ status: 'failed', failure: failure || 'worker_error', diagnostics });
          reject(new GenerationError(failure || 'worker_error', diagnostics));
          return;
        }
        try {
          const result = JSON.parse(output);
          if (
            typeof result.model !== 'string' ||
            !['succeeded', 'failed', 'needs_attention'].includes(result.outcome) ||
            (!result.artifact && !FAILURE_CODES.has(result.failure))
          )
            throw new Error('Invalid result');
          trace?.finish({
            status: result.outcome === 'succeeded' ? 'succeeded' : 'failed',
            failure: result.failure,
            diagnostics: result.diagnostics,
          });
          resolve(result);
        } catch {
          reject(new GenerationError('worker_error', diagnostics));
        }
      });
      child.once('spawn', async () => {
        try {
          await onStarted({ pid: child.pid, identity: await processIdentity(child.pid) });
          if (!failure && !signal?.aborted)
            child.stdin.end(
              JSON.stringify({
                id: job.id,
                prompt: job.prompt,
                simulationId: job.simulationId,
                deadlineAt: job.deadlineAt,
                attempt: job.attempt,
              }),
            );
          else child.stdin.end();
        } catch {
          stop('worker_error');
        }
      });
    });
  } finally {
    trace?.finish({ status: 'interrupted', failure: 'worker_error' });
    if (temporaryStore) await rm(checkpointDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
}
export async function deliverResult(send, wait = sleep) {
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      return await send();
    } catch (e) {
      if (e.status === 409) return null;
      if (attempt === 2 || (e.status && e.status < 500)) throw e;
      await wait(500 * 2 ** attempt);
    }
}
// Bounded, retryable event delivery is independent of the lease heartbeat.
export class ProgressQueue {
  constructor(send, attempt = 1, max = 90) {
    this.prefix = randomUUID();
    this.send = send;
    this.attempt = attempt;
    this.max = max;
    this.queue = [];
    this.sequence = 0;
    this.sent = 0;
    this.dropped = 0;
    this.pending = null;
    this.closed = false;
    this.streamed = new Set();
  }
  push(code, details) {
    // Only Axum's committed completion/expiry writes a terminal timeline event.
    if (this.closed || FAILURE_CODES.has(code) || ['finalized', 'needs_attention'].includes(code))
      return;
    if (code === 'model_streaming') {
      const key = `${details.role}:${details.requests}`;
      if (this.streamed.has(key)) return;
      this.streamed.add(key);
    }
    const event = {
      code,
      details: safeDetails({ ...details, attempt: this.attempt, eventsDropped: this.dropped }),
      event_key: `${this.attempt}:${this.prefix}:${++this.sequence}`,
    };
    if (code === 'model_streaming' && this.queue.at(-1)?.code === code)
      this.queue[this.queue.length - 1] = event;
    else if (this.queue.length >= 32) {
      this.queue.shift();
      this.dropped++;
      this.queue.push(event);
    } else this.queue.push(event);
    this.drain();
  }
  drain() {
    if (this.pending || this.closed) return;
    this.pending = (async () => {
      while (this.queue.length && !this.closed && this.sent < this.max) {
        const event = this.queue[0];
        try {
          await deliverResult(() => this.send(event));
          this.sent++;
        } catch {
          this.dropped++;
        }
        this.queue.shift();
      }
      if (this.sent >= this.max) {
        this.dropped += this.queue.length;
        this.queue = [];
      }
    })().finally(() => {
      this.pending = null;
      if (this.queue.length && !this.closed) this.drain();
    });
  }
  async close() {
    await Promise.race([this.pending || Promise.resolve(), sleep(2000)]);
    this.closed = true;
  }
}
async function main() {
  let base;
  try {
    base = new URL(process.env.CL_API_BASE_URL || '');
  } catch {
    throw new GenerationError('configuration_error');
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && process.env.CL_WORKER_ALLOW_HTTP === 'true'))
  )
    throw new GenerationError('configuration_error');
  const token = process.env.GENERATION_WORKER_TOKEN;
  if (!token || token.length < 32) throw new GenerationError('configuration_error');
  const api = async (path, body = {}, timeoutMs = 10000) => {
    const r = await fetch(new URL(path, base), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = new Error('Worker API failure');
      e.status = r.status;
      throw e;
    }
    return r.json();
  };
  const store = await CheckpointStore.open(
    process.env.CL_CHECKPOINT_DIR || '/var/lib/commonlab/checkpoints',
  );
  await store.prune();
  const assignment = join(store.directory, 'assignment.json');
  await rm('/tmp/commonlab-worker-ready', { force: true });
  const remote = await api('/api/worker/generation/handshake', {
    protocolVersion: PROTOCOL.version,
  });
  if (remote.protocolVersion !== PROTOCOL.version || hash(remote.policy) !== hash(PROTOCOL))
    throw new GenerationError('configuration_error');
  await preflight();
  await writeFile('/tmp/commonlab-worker-ready', 'ready', { mode: 0o600 });
  const traces = TraceStore.fromEnv(),
    shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  while (!shutdown.signal.aborted) {
    let job,
      unwatch = () => {},
      progress;
    try {
      try {
        job = JSON.parse(await readFile(assignment, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw new GenerationError('configuration_error');
      }
      if (
        job?.owner &&
        job.owner.identity !== (await processIdentity(process.pid)) &&
        (await processIdentity(job.owner.pid)) === job.owner.identity
      )
        throw new GenerationError('configuration_error');
      if (job?.runner) {
        await stopRecordedProcess(job.runner);
        delete job.runner;
        await atomicJson(assignment, job);
      }
      if (
        job &&
        !(await api(`/api/worker/generation/${job.id}/heartbeat`, { lease: job.lease })).active
      ) {
        await rm(assignment, { force: true });
        job = null;
      }
      if (!job) {
        job = await api('/api/worker/generation/claim', {
          protocolVersion: PROTOCOL.version,
          model: `${process.env.CL_MODEL_PROVIDER}/${process.env.CL_MODEL_ID}`,
        });
        if (!job) {
          await sleep(2000);
          continue;
        }
        await atomicJson(assignment, job);
      }
      job.owner = { pid: process.pid, identity: await processIdentity(process.pid) };
      await atomicJson(assignment, job);
      if (job.protocolVersion !== PROTOCOL.version || hash(job.policy) !== hash(PROTOCOL))
        throw new GenerationError('configuration_error');
      const controller = new AbortController();
      const abort = () => controller.abort();
      shutdown.signal.addEventListener('abort', abort, { once: true });
      if (shutdown.signal.aborted) abort();
      let leaseLost = false;
      let lastDetails = {};
      unwatch = watchLease(
        async () =>
          (
            await api(`/api/worker/generation/${job.id}/heartbeat`, {
              lease: job.lease,
              details: lastDetails,
            })
          ).active,
        () => {
          leaseLost = true;
          controller.abort();
        },
      );
      progress = new ProgressQueue(
        (event) =>
          api(`/api/worker/generation/${job.id}/progress`, { lease: job.lease, ...event }, 2000),
        job.attempt,
      );
      let result;
      try {
        result = await runChild(job, null, {
          signal: controller.signal,
          checkpointDir: store.directory,
          onStarted: async (runner) => {
            if (!runner.identity) throw new GenerationError('worker_error');
            job.runner = runner;
            await atomicJson(assignment, job);
          },
          trace: traces?.create(job),
          onProgress: (code, details) => {
            lastDetails = safeDetails({ ...lastDetails, ...details });
            progress.push(code, details);
            operatorEvent({
              job: job.id,
              attempt: job.attempt,
              code,
              details: safeDetails(details),
            });
          },
        });
      } catch (e) {
        result = {
          artifact: null,
          outcome: 'failed',
          model: `${process.env.CL_MODEL_PROVIDER}/${process.env.CL_MODEL_ID}`,
          failure: leaseLost ? 'lease_lost' : e.code || 'worker_error',
          diagnostics: safeDetails(e.diagnostics),
        };
      } finally {
        shutdown.signal.removeEventListener('abort', abort);
      }
      if (shutdown.signal.aborted) {
        await api(`/api/worker/generation/${job.id}/release`, { lease: job.lease });
        await rm(assignment, { force: true });
        break;
      }
      if (leaseLost) {
        await rm(assignment, { force: true });
        continue;
      }
      // Durable outbox, including failures from external watchdogs. Delivery retry never runs a model.
      const saved = (await store.load(job)) || {};
      if (!result.artifact && saved.candidate && !saved.deliveryRejected) {
        result.artifact = {
          definition: saved.candidate.definition,
          moduleCode: saved.candidate.moduleCode,
        };
        result.outcome = 'needs_attention';
        result.report = {
          verification: 'unresolved',
          review: 'unresolved',
          artifactHash: hash(saved.candidate),
          harnessHash: saved.harnessHash || null,
        };
      }
      saved.result = result;
      await store.save(job, saved);
      await progress.close();
      try {
        await deliverResult(() =>
          api(`/api/worker/generation/${job.id}/complete`, { lease: job.lease, ...result }, 2000),
        );
      } catch (error) {
        if (error.status !== 422) throw error;
        // Keep rejected candidate evidence privately; don't loop forever sending
        // the same invalid artifact or rerun generation to repair a delivery error.
        saved.deliveryRejected = result;
        result = {
          artifact: null,
          outcome: 'failed',
          model: result.model,
          failure: 'verification_failed',
          diagnostics: result.diagnostics,
          report: { verification: 'server_rejected', review: 'unresolved' },
        };
        saved.result = result;
        await store.save(job, saved);
        await deliverResult(() =>
          api(`/api/worker/generation/${job.id}/complete`, { lease: job.lease, ...result }, 2000),
        );
      }
      await rm(assignment, { force: true });
    } catch (e) {
      operatorError({
        code: e.code || 'delivery_unavailable',
        job: job?.id || null,
        status: e.status || null,
      });
      await sleep(2000);
    } finally {
      unwatch();
      await progress?.close();
    }
  }
  await rm('/tmp/commonlab-worker-ready', { force: true });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    operatorError({ code: e.code || 'configuration_error' });
    process.exitCode = 1;
  });
