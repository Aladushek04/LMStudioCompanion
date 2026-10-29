import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { wrapper } from './launchers.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.tools', 'launcher-check-')); const run = promisify(execFile);
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
try {
  await mkdir(join(work, 'scripts'));
  for (const name of ['Rollback', 'Uninstall']) {
    await copyFile(join(root, `scripts/${name}.ps1`), join(work, `scripts/${name}.ps1`));
    const result = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, `scripts/${name}.ps1`)], { encoding: 'utf8', windowsHide: true });
    assert.match(result.stdout, /переносно|распакован/i); assert.equal(result.stderr, '');
  }
  const diagnostic = join(work, 'Diagnose-Companion.cmd'); await writeFile(diagnostic, wrapper('Diagnose', true));
  for (const code of [0, 7]) {
    await writeFile(join(work, 'scripts/Start.ps1'), `param([switch]$Diagnose)\nWrite-Host 'Fixture diagnostic output'\nexit ${code}\n`);
    const result = spawnSync('cmd.exe', ['/d', '/c', diagnostic], { input: 'x\r\n', encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, code); assert.match(result.stdout, /Fixture diagnostic output/); assert.match(result.stdout, /Press any key|Нажмите любую клавишу/i);
  }
  console.log('PASS launchers: portable rollback/uninstall explain context; diagnostic wrapper retains successful output.');
} finally {
  if (dirname(work) !== join(root, '.tools') || !work.split(/[\\/]/).at(-1).startsWith('launcher-check-')) throw new Error('Invalid fixture cleanup path');
  await rm(work, { recursive: true, force: true });
}
