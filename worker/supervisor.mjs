import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './policy.mjs';
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
export async function runChild(job, stillActive, { runtimeMs = LIMITS.runtimeMs, signal, ...watch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-worker-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url))], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8',
          CL_MODEL_PROVIDER: process.env.CL_MODEL_PROVIDER || '', CL_MODEL_ID: process.env.CL_MODEL_ID || '', CL_MODEL_API_KEY: process.env.CL_MODEL_API_KEY || '' },
      });
      let output = '', stopped = false;
      const stop = () => { stopped = true; child.kill('SIGKILL'); };
      const deadline = setTimeout(stop, runtimeMs);
      const unwatch = watchLease(stillActive, stop, watch);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const clean = () => { clearTimeout(deadline); unwatch(); signal?.removeEventListener('abort', stop); };
      child.on('error', () => { clean(); reject(new Error('Worker process failed.')); });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > LIMITS.outputBytes) stop(); });
      child.on('close', code => {
        clean();
        if (stopped || code !== 0) { reject(new Error('Agent failed or exceeded limits.')); return; }
        try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid worker output.')); }
      });
      // The lease, worker token, account identity, cookies and application URL are deliberately absent.
      child.stdin.end(JSON.stringify({ prompt: job.prompt, simulationId: job.simulationId }));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function main() {
  let base;
  try { base = new URL(process.env.CL_API_BASE_URL || ''); }
  catch { throw new Error('Invalid application origin.'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && process.env.CL_WORKER_ALLOW_HTTP === 'true'))) throw new Error('Use an HTTPS application origin (explicit private-network HTTP opt-in for development).');
  const token = process.env.GENERATION_WORKER_TOKEN;
  if (!token || token.length < 32 || !['anthropic', 'openai', 'google', 'openrouter'].includes(process.env.CL_MODEL_PROVIDER) || !process.env.CL_MODEL_ID || !process.env.CL_MODEL_API_KEY) throw new Error('Missing explicit worker/model configuration.');
  async function api(path, body) {
    const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!response.ok) throw new Error('Worker API request failed.');
    return response.json();
  }
  const shutdown = new AbortController();
  process.on('SIGTERM', () => shutdown.abort()); process.on('SIGINT', () => shutdown.abort());
  while (!shutdown.signal.aborted) {
    try {
      const job = await api('/api/worker/generation/claim');
      if (!job) { await sleep(2000); continue; }
      if (job.protocolVersion !== 1) throw new Error('Unsupported worker protocol.');
      let result = { artifact: null, model: `${process.env.CL_MODEL_PROVIDER}/${process.env.CL_MODEL_ID}` };
      try { result = await runChild(job, async () => (await api(`/api/worker/generation/${job.id}/check`, { lease: job.lease })).active, { signal: shutdown.signal }); }
      catch {
        if (shutdown.signal.aborted) {
          // A redeploy is not the contributor's failure: requeue instead of using up their quota.
          await api(`/api/worker/generation/${job.id}/release`, { lease: job.lease });
          break;
        }
        console.error('Generation failed or hit a limit; no artifact published.');
      }
      await api(`/api/worker/generation/${job.id}/complete`, { lease: job.lease, ...result });
    } catch {
      if (shutdown.signal.aborted) break;
      console.error('Generation worker unavailable; retrying connection.'); await sleep(2000);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Invalid generation worker configuration.'); process.exitCode = 1; });
}
