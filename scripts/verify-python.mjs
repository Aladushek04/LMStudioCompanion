import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = resolve(root, 'packages/web-tools');
const candidates = [
  process.env.COMPANION_PYTHON,
  resolve(root, '.tools/web-venv/Scripts/python.exe'),
  resolve(root, '.tools/web-venv/bin/python'),
  'python',
  'python3',
].filter(Boolean);

const python = candidates.find(candidate => {
  if (candidate.includes('/') || candidate.includes('\\')) {
    if (!existsSync(candidate)) return false;
  }
  const result = spawnSync(candidate, ['--version'], { cwd: root, stdio: 'ignore' });
  return !result.error && result.status === 0;
});

if (!python) {
  console.error(
    'Python не найден. Укажите COMPANION_PYTHON или подготовьте .tools/web-venv (packages/web-tools/Install.cmd).',
  );
  process.exit(1);
}

console.log(`Python: ${python}`);

function run(args, label, cwd = root) {
  const result = spawnSync(python, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`${label} — FAILED: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} — FAILED (exit ${result.status ?? 'unknown'})`);
    process.exit(result.status ?? 1);
  }
}

run(['-m', 'pytest', 'tests', '-q'], 'pytest', webRoot);
run(['-m', 'ruff', 'check', '.'], 'ruff', webRoot);
console.log('Python checks — OK');
