import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CheckpointStore, hash } from '../checkpoints.mjs';
import { killTree } from '../processes.mjs';
import { PROTOCOL } from '../protocol.mjs';
import { SMOKE_ARTIFACT } from '../preflight.mjs';
// Run this test inside the locked network=none image: loopback fake control API,
// actual supervisor/runner, actual browser preflight, durable outbox, no inference.
test(
  'actual supervisor preflights, claims protocol 2, and retries lost completion without generation',
  { skip: process.env.CL_TEST_BROWSER !== '1', timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commonlab-e2e-'));
    const job = {
      id: 42,
      prompt: 'Seeded outbox delivery only',
      simulationId: SMOKE_ARTIFACT.definition.id,
      attempt: 1,
      lease: 'test-only-job-lease-not-a-real-secret',
      deadlineAt: Math.floor(Date.now() / 1000) + 60,
      protocolVersion: 2,
      policy: PROTOCOL,
    };
    const result = {
      artifact: { definition: SMOKE_ARTIFACT.definition, moduleCode: SMOKE_ARTIFACT.moduleCode },
      outcome: 'succeeded',
      model: 'scripted/checkpoint',
      diagnostics: { requests: 0 },
      report: { verification: 'passed', review: 'passed' },
    };
    const store = await CheckpointStore.open(join(directory, 'checkpoints'));
    await store.save(job, { version: 2, result, ledger: { requests: 0 }, files: {} });
    let claimed = false,
      completions = 0,
      firstHash,
      completeResolve;
    const delivered = new Promise((resolve) => {
      completeResolve = resolve;
    });
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
      const send = (value) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      };
      assert.equal(req.headers.authorization, 'Bearer test-only-worker-credential-0000000000');
      if (req.url === '/api/worker/generation/handshake') {
        send({ protocolVersion: 2, policy: PROTOCOL });
        return;
      }
      if (req.url === '/api/worker/generation/claim') {
        assert.equal(body.protocolVersion, 2);
        if (!claimed) {
          claimed = true;
          send(job);
        } else send(null);
        return;
      }
      if (req.url.endsWith('/heartbeat')) {
        send({ active: true });
        return;
      }
      if (req.url.endsWith('/complete')) {
        completions++;
        const h = hash(body);
        if (!firstHash) firstHash = h;
        assert.equal(h, firstHash);
        assert.equal(body.outcome, 'succeeded');
        assert.equal(body.diagnostics.requests, 0);
        if (completions === 1) {
          res.destroy();
          return;
        }
        send({ recorded: true });
        completeResolve();
        return;
      }
      if (req.url.endsWith('/release')) {
        send({ status: 'queued' });
        return;
      }
      send({ recorded: true });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      LANG: 'C.UTF-8',
      CL_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CL_WORKER_ALLOW_HTTP: 'true',
      GENERATION_WORKER_TOKEN: 'test-only-worker-credential-0000000000',
      CL_MODEL_PROVIDER: 'openrouter',
      CL_MODEL_ID: 'xiaomi/mimo-v2.6-flash',
      CL_MODEL_API_KEY: 'not-a-real-key-never-sent',
      CL_REVIEW_MODEL_ID: 'deepseek/deepseek-v4.1-flash-1017',
      CL_REVIEW_IMAGES: '1',
      CL_CHECKPOINT_DIR: store.directory,
    };
    for (const key of [
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE',
      'CL_PUBLIC_ROOT',
    ])
      if (process.env[key]) env[key] = process.env[key];
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL('../supervisor.mjs', import.meta.url))],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    worker.stdout.on('data', (c) => {
      output += c;
    });
    worker.stderr.on('data', (c) => {
      output += c;
    });
    const closed = new Promise((resolve) => worker.once('exit', resolve));
    let timer;
    try {
      await Promise.race([
        delivered,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Supervisor did not deliver: ${output.slice(-1000)}`)),
            20000,
          );
        }),
      ]);
      assert.equal(completions, 2);
      worker.kill('SIGTERM');
      await closed;
      assert.equal((await store.load(job)).result.outcome, 'succeeded');
    } finally {
      clearTimeout(timer);
      await killTree(worker.pid);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
