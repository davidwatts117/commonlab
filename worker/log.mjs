// Only call with host-owned codes/IDs and safeDetails. Never pass raw exceptions,
// provider responses, prompts, artifacts, headers or credentials to ordinary logs.
export function operatorEvent(record) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}
export function operatorError(record) {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}
