// Operational state is separate from optional transcripts. Atomic, durable, private,
// bounded and keyed only by a host-generated numeric job id. No model path input.
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, readdir, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { GenerationError } from './protocol.mjs';
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
// Only these host-owned fields go to ordinary operator logs, never the underlying
// error message/stack, checkpoint contents, prompts, credentials or assignment lease.
export class CheckpointStorageError extends GenerationError {
  constructor(operation, path, error) {
    super('storage_error');
    this.component = 'checkpoint_storage';
    this.operation = operation;
    this.path = path;
    this.systemCode = /^[A-Z_]{1,24}$/.test(error?.code || '') ? error.code : 'INVALID_STORAGE';
  }
}
const storageError = (operation, path, error) =>
  error instanceof CheckpointStorageError
    ? error
    : new CheckpointStorageError(operation, path, error);
export function storageDetails(error) {
  if (!(error instanceof CheckpointStorageError)) return {};
  return {
    component: error.component,
    operation: error.operation,
    systemCode: error.systemCode,
    path: error.path,
  };
}
async function syncDirectory(directory) {
  const file = await open(directory, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function atomicJson(path, data) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new GenerationError('output_limit');
  const temp = `${path}.${randomUUID()}.tmp`;
  let file,
    operation = 'create',
    failure;
  try {
    file = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    operation = 'write';
    await file.writeFile(text);
    operation = 'file_sync';
    await file.sync();
    operation = 'close';
    await file.close();
    file = undefined;
    operation = 'rename';
    await rename(temp, path);
    operation = 'directory_sync';
    await syncDirectory(resolve(path, '..'));
  } catch (error) {
    failure = storageError(operation, path, error);
  } finally {
    try {
      if (file) await file.close();
      await rm(temp, { force: true });
    } catch (error) {
      failure ||= storageError('cleanup', path, error);
    }
  }
  if (failure) throw failure;
}
export class CheckpointStore {
  static async open(directory) {
    if (!isAbsolute(directory)) throw new Error('Checkpoint directory must be absolute');
    let info;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.mode & 0o077 ||
        (await realpath(directory)) !== resolve(directory)
      ) {
        throw new Error('Checkpoint directory must be private, nonsymlinked and mode 0700');
      }
    } catch (error) {
      if (error.code) throw storageError('open_directory', directory, error);
      throw error;
    }
    const store = new CheckpointStore(directory);
    // Directory ownership/mode says nothing about a read-only Docker layer/mount.
    // Exercise the same create/write/sync/rename/delete path as real checkpoints
    // BEFORE advertising readiness, contacting the control API or claiming work.
    await store.assertWritable();
    return store;
  }
  constructor(directory) {
    this.directory = directory;
  }
  async assertWritable() {
    const path = join(this.directory, `.storage-probe-${randomUUID()}.json`);
    await atomicJson(path, { probe: 'commonlab-checkpoint-storage' });
    await this.remove(path);
  }
  path(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid job id');
    return join(this.directory, `job-${id}.json`);
  }
  async remove(path) {
    try {
      await rm(path, { force: true });
      await syncDirectory(this.directory);
    } catch (error) {
      throw storageError('delete', path, error);
    }
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
      throw storageError('read', this.path(job.id), error);
    }
    let saved;
    try {
      saved = JSON.parse(text);
    } catch {
      const error = new CheckpointStorageError('validate', this.path(job.id), {
        code: 'INVALID_CHECKPOINT',
      });
      error.message = 'Invalid checkpoint';
      throw error;
    }
    if (
      !saved ||
      typeof saved !== 'object' ||
      !saved.state ||
      typeof saved.state !== 'object' ||
      Array.isArray(saved.state) ||
      saved.version !== 2 ||
      saved.identity !== hash({ id: job.id, prompt: job.prompt, simulationId: job.simulationId })
    ) {
      const error = new CheckpointStorageError('validate', this.path(job.id), {
        code: 'IDENTITY_MISMATCH',
      });
      error.message = 'Checkpoint identity mismatch';
      throw error;
    }
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
    try {
      for (const name of await readdir(this.directory)) {
        if (!/^job-\d+\.json$/.test(name)) continue;
        const path = join(this.directory, name),
          info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink()) files.push({ path, time: info.mtimeMs });
      }
      files.sort((a, b) => b.time - a.time);
      for (let i = 0; i < files.length; i++)
        if (i >= maxFiles || files[i].time < Date.now() - maxDays * 86400000)
          await this.remove(files[i].path);
    } catch (error) {
      throw storageError('prune', this.directory, error);
    }
  }
}
