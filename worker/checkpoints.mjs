// Operational state is separate from optional transcripts. Atomic, durable, private,
// bounded and keyed only by a host-generated numeric job id. No model path input.
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, readdir, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
function canonical(value) {
  return JSON.stringify(sort(value));
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}
export async function atomicJson(path, data) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Checkpoint size limit');
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const parent = await open(resolve(path, '..'), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
export class CheckpointStore {
  static async open(directory) {
    if (!isAbsolute(directory)) throw new Error('Checkpoint directory must be absolute');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (await realpath(directory)) !== resolve(directory)
    )
      throw new Error('Checkpoint directory must be private, nonsymlinked and mode 0700');
    return new CheckpointStore(directory);
  }
  constructor(directory) {
    this.directory = directory;
  }
  path(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid job id');
    return join(this.directory, `job-${id}.json`);
  }
  async load(job) {
    let text;
    try {
      const file = await open(this.path(job.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        text = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    let saved;
    try {
      saved = JSON.parse(text);
    } catch {
      throw new Error('Invalid checkpoint');
    }
    if (
      saved.version !== 2 ||
      saved.identity !== hash({ id: job.id, prompt: job.prompt, simulationId: job.simulationId })
    )
      throw new Error('Checkpoint identity mismatch');
    return saved.state;
  }
  async save(job, state) {
    await atomicJson(this.path(job.id), {
      version: 2,
      at: Date.now(),
      identity: hash({ id: job.id, prompt: job.prompt, simulationId: job.simulationId }),
      state,
    });
  }
  async prune(maxDays = 7, maxFiles = 500) {
    const files = [];
    for (const name of await readdir(this.directory)) {
      if (!/^job-\d+\.json$/.test(name)) continue;
      const path = join(this.directory, name),
        info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) files.push({ path, time: info.mtimeMs });
    }
    files.sort((a, b) => b.time - a.time);
    for (let i = 0; i < files.length; i++)
      if (i >= maxFiles || files[i].time < Date.now() - maxDays * 86400000) await rm(files[i].path);
  }
}
