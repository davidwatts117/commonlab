import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, chmod, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CheckpointStore, CheckpointStorageError, atomicJson } from '../checkpoints.mjs';
import { reportStorageFailure } from '../supervisor.mjs';
import { PROTOCOL } from '../protocol.mjs';
import { killTree } from '../processes.mjs';
const notRoot = process.getuid?.() !== 0;
const browser = process.env.CL_TEST_BROWSER === '1';
const readonly = process.env.CL_TEST_READONLY_DIR;

test('storage preflight exercises durable writes and removes its probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commonlab-storage-'));
  try {
    await CheckpointStore.open(directory);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test(
  'private permissions alone cannot pass storage preflight without write access',
  { skip: !notRoot },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commonlab-storage-'));
    try {
      await chmod(directory, 0o500);
      await assert.rejects(
        CheckpointStore.open(directory),
        (e) =>
          e instanceof CheckpointStorageError &&
          e.code === 'storage_error' &&
          e.systemCode === 'EACCES',
      );
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test(
  'checkpoint writes retain a specific storage cause instead of worker_error',
  { skip: !notRoot },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commonlab-storage-'));
    try {
      await chmod(directory, 0o500);
      await assert.rejects(
        atomicJson(join(directory, 'job-1.json'), { private: 'not logged' }),
        (e) => e.code === 'storage_error' && e.systemCode === 'EACCES' && e.operation === 'create',
      );
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test('storage failure delivery needs no checkpoint access and keeps paths/leases out of public diagnostics', async () => {
  const calls = [];
  const e = new CheckpointStorageError('create', '/private/operator/checkpoints', {
    code: 'EROFS',
  });
  const job = { id: 42, lease: 'test-only-lease' };
  await reportStorageFailure(
    async (path, body) => {
      calls.push({ path, body });
      return { recorded: true };
    },
    job,
    e,
    { diagnostics: { phase: 'preflight', requests: 0 } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.failure, 'storage_error');
  assert.equal(calls[0].body.outcome, 'failed');
  assert.equal(calls[0].body.diagnostics.cause, 'storage_error');
  assert.ok(!JSON.stringify(calls[0].body.diagnostics).includes('/private/'));
});

async function supervisorScenario({ directory, root, failAfterClaim = false }) {
  const calls = [],
    completions = [];
  const job = {
    id: 42,
    prompt: 'Storage failure test; no model call allowed',
    simulationId: 'ai-000000000000000000000000',
    attempt: 1,
    lease: 'test-only-job-lease',
    deadlineAt: Math.floor(Date.now() / 1000) + 60,
    protocolVersion: 2,
    policy: PROTOCOL,
  };
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      res.writeHead(400).end();
      return;
    }
    calls.push(req.url);
    const send = (value) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.url.endsWith('/handshake')) {
      send({ protocolVersion: 2, policy: PROTOCOL });
      return;
    }
    if (req.url.endsWith('/claim')) {
      if (failAfterClaim) await chmod(directory, 0o500);
      send(job);
      return;
    }
    if (req.url.endsWith('/heartbeat')) {
      send({ active: true });
      return;
    }
    if (req.url.endsWith('/complete')) {
      completions.push(body);
      send({ recorded: true });
      return;
    }
    send({ recorded: true });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    LANG: 'C.UTF-8',
    CL_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CL_WORKER_ALLOW_HTTP: 'true',
    GENERATION_WORKER_TOKEN: 'test-only-worker-credential-0000000000',
    CL_MODEL_PROVIDER: 'openrouter',
    CL_MODEL_ID: 'xiaomi/mimo-v2.6-flash',
    CL_MODEL_API_KEY: 'test-key-never-sent',
    CL_REVIEW_MODEL_ID: 'deepseek/deepseek-v4.1-flash-1017',
    CL_CHECKPOINT_DIR: directory,
  };
  for (const key of [
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE',
    'CL_PUBLIC_ROOT',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../supervisor.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Supervisor failed to exit: ${output.slice(-1000)}`)),
          20000,
        );
      }),
    ]);
    const logs = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      });
    return { code, calls, completions, logs, output };
  } finally {
    clearTimeout(timer);
    await killTree(child.pid);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
test(
  'unwritable startup never advertises readiness or contacts the job API',
  { skip: !notRoot, timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonlab-startup-storage-')),
      directory = join(root, 'checkpoints');
    try {
      await CheckpointStore.open(directory);
      await chmod(directory, 0o500);
      const r = await supervisorScenario({ directory, root });
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.ok(
        r.logs.some(
          (e) =>
            e.code === 'storage_error' &&
            e.systemCode === 'EACCES' &&
            e.component === 'checkpoint_storage',
        ),
      );
      await assert.rejects(access('/tmp/commonlab-worker-ready'));
    } finally {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  'a post-claim assignment write failure reports storage_error and exits without starting generation',
  { skip: !browser || !notRoot, timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonlab-post-claim-storage-')),
      directory = join(root, 'checkpoints');
    try {
      await CheckpointStore.open(directory);
      const r = await supervisorScenario({ directory, root, failAfterClaim: true });
      assert.equal(r.code, 1);
      assert.equal(r.calls.filter((p) => p.endsWith('/claim')).length, 1);
      assert.equal(r.completions.length, 1);
      assert.equal(r.completions[0].failure, 'storage_error');
      assert.equal(r.completions[0].diagnostics.phase, 'preflight');
      assert.ok(!r.logs.some((e) => e.code === 'model_request'));
      assert.ok(
        r.logs.some(
          (e) => e.code === 'storage_error' && e.job === 42 && e.jobFailureReported === true,
        ),
      );
      assert.ok(!r.output.includes('test-only-job-lease'));
      await assert.rejects(access('/tmp/commonlab-worker-ready'));
    } finally {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  'missing checkpoint mount reproduces EROFS in the read-only image before any claim',
  { skip: !readonly, timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonlab-readonly-storage-'));
    try {
      const r = await supervisorScenario({ directory: readonly, root });
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.ok(
        r.logs.some(
          (e) =>
            e.code === 'storage_error' && e.systemCode === 'EROFS' && e.path.startsWith(readonly),
        ),
      );
      await assert.rejects(access('/tmp/commonlab-worker-ready'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
