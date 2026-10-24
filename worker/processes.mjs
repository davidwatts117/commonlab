import { readdir, readFile } from 'node:fs/promises';
export async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return `${boot}:${start}`;
  } catch {
    return null;
  }
}
export async function stopRecordedProcess(record) {
  if (
    !Number.isSafeInteger(record?.pid) ||
    record.pid < 2 ||
    record.pid === process.pid ||
    !record.identity
  )
    return false;
  if ((await processIdentity(record.pid)) !== record.identity) return false;
  try {
    process.kill(-record.pid, 'SIGKILL');
  } catch {
    await killTree(record.pid);
  }
  return true;
}
// Linux worker containers: kill descendants as well as a timed-out browser driver.
// No shell, Docker socket or credentials are involved.
export async function killTree(pid) {
  const parents = new Map();
  for (const name of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const n = Number(name);
      if (!parents.has(ppid)) parents.set(ppid, []);
      parents.get(ppid).push(n);
    } catch {
      /* process exited */
    }
  }
  const seen = new Set();
  const kill = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const child of parents.get(n) || []) kill(child);
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      /* already dead */
    }
  };
  kill(pid);
}
