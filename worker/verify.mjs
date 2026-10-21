// Credential-free disposable process. The external watchdog also covers browser
// startup, infinite page JavaScript, server close and hung Chromium teardown.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from './processes.mjs';
import { PROTOCOL } from './protocol.mjs';
export function formatVerification(report) {
  return `Verification ${report.ok ? 'PASSED' : 'FAILED'}: ${JSON.stringify({ ...report, screenshots: undefined }).slice(0, 18000)}. Fix the cause, not the tests. A passing run is not a scientific audit.`;
}
export async function verifyArtifact(
  artifact,
  { timeoutMs = PROTOCOL.limits.verifyMs, signal } = {},
) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./verify-child.mjs', import.meta.url))],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          CL_PUBLIC_ROOT:
            process.env.CL_PUBLIC_ROOT || fileURLToPath(new URL('../public', import.meta.url)),
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '',
          PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '',
        },
      },
    );
    let output = '',
      done = false;
    const finish = async (report) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await killTree(child.pid);
      resolve({ ...report, durationMs: Date.now() - started });
    };
    const unavailable = (message) => ({
      ok: false,
      infrastructure: true,
      runtimeErrors: [],
      consoleErrors: [],
      tests: { total: 0, passed: 0, failed: 0, results: [] },
      canvases: [],
      warnings: [message],
      screenshots: [],
    });
    const abort = () => finish(unavailable('Verification cancelled'));
    const timer = setTimeout(
      () =>
        finish({
          ...unavailable('Verification watchdog expired; engine or browser did not finish'),
          infrastructure: false,
        }),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => finish(unavailable('Verification process failed to start')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 3 * 1024 * 1024)
        finish(unavailable('Verification evidence exceeded size limit'));
    });
    child.on('close', (code) => {
      if (done) return;
      let report;
      try {
        report = JSON.parse(output);
      } catch {
        return finish(unavailable('Verification process returned no valid report'));
      }
      if (code !== 0) return finish(unavailable('Verification process crashed'));
      finish(report);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(artifact));
  });
}
