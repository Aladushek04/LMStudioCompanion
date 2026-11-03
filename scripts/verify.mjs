import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSteps } from './lib/verify-steps.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const full = process.argv.includes('--full');
const steps = buildSteps({ root, node: process.execPath, full });
const total = steps.length;

for (let index = 0; index < steps.length; index++) {
  const [label, command, args] = steps[index];
  const prefix = `[${index + 1}/${total}] ${label}`;
  console.log(`${prefix}…`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`${prefix} — FAILED: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${prefix} — FAILED (exit ${result.status ?? 'unknown'})`);
    process.exit(result.status ?? 1);
  }
  console.log(`${prefix} — OK`);
}

console.log(full ? 'VERIFY:FULL PASSED' : 'VERIFY PASSED');
