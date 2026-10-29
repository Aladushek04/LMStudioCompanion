import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url)); const run = promisify(execFile);
const work = await mkdtemp(join(root, '.tools', 'source-check-')); const source = join(work, 'новые исходники');
const psHome = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0');
try {
  await mkdir(source);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await copyFile(join(root, name), join(source, name));
  for (const name of ['scripts', 'packages/core', 'packages/host', 'packages/lmstudio-plugin', 'packages/control-panel']) await cp(join(root, name), join(source, name), { recursive: true });
  await mkdir(join(source, '.tools')); await mkdir(join(work, 'profile'));
  for (const name of ['node-24.22.2.zip', 'npm-12.2.1.tgz']) await copyFile(join(root, '.tools', name), join(source, '.tools', name));
  const env = { ...process.env, USERPROFILE: join(work, 'profile'), PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), PSModulePath: join(psHome, 'Modules') };
  await run(join(psHome, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'scripts/Install.ps1'), '-Apply'], { env, cwd: process.env.SystemRoot ?? 'C:\\Windows', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  await access(join(source, 'dist/host/src/main.js')); await access(join(source, 'dist/panel/index.html'));
  assert.equal((await run(join(source, 'runtime/node.exe'), ['--version'], { env })).stdout.trim(), 'v24.22.2');
  const child = spawn(join(psHome, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'scripts/Start.ps1'), '-NoOpen', '-Port', '0'], { env, cwd: process.env.SystemRoot ?? 'C:\\Windows', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { errors += b.toString(); });
  try {
    const started = Date.now();
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) { if (child.exitCode !== null || Date.now() - started > 15000) throw new Error(errors || 'Source start timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal((await fetch(output.match(/http:\/\/127\.0\.0\.1:\d+/)[0])).status, 200);
  } finally { const closed = once(child, 'close'); await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); await closed; }
  console.log('Source bootstrap: PS5.1, no LM Studio Node, no npm/PATH Node; pinned runtime, build and fresh-shell launch passed.');
} finally {
  if (dirname(work) !== join(root, '.tools') || !work.split(/[\\/]/).at(-1).startsWith('source-check-')) throw new Error('Refusing fixture cleanup');
  await rm(work, { recursive: true, force: true });
}
