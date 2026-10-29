import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const work = await mkdtemp(join(root, '.tools', 'release-check-'));
const source = join(work, 'дистрибутив с пробелами'); const target = join(work, 'тестовый профиль');
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const run = promisify(execFile);
const env = { ...process.env, USERPROFILE: join(work, 'empty-profile'), PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), NODE_PATH: '' };
const script = (path, args = []) => run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args], { cwd: process.env.SystemRoot ?? 'C:\\Windows', env, windowsHide: true, timeout: 30000 });
const state = async () => JSON.parse(await readFile(join(target, 'install-state.json'), 'utf8'));
let child;
async function stop() {
  if (!child) return;
  const closed = once(child, 'close');
  await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); await closed; child = undefined;
  // Keep crash metadata: the application/installer must recover it safely.
}
try {
  await run(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:COMPANION_ARCHIVE, $env:COMPANION_UNPACK)'], { env: { ...env, COMPANION_ARCHIVE: join(root, `releases/LMStudioCompanion-${version}-win-x64.zip`), COMPANION_UNPACK: source }, windowsHide: true });
  for (const name of ['Rollback', 'Uninstall']) {
    const explained = await script(join(source, `scripts/${name}.ps1`));
    assert.match(explained.stdout, /переносно|распакован/i); assert.equal(explained.stderr, '');
  }
  assert.equal((await run(join(source, 'runtime/node.exe'), ['--version'], { env })).stdout.trim(), 'v24.22.2');
  await script(join(source, 'scripts/Install.ps1'), ['-Preview', '-Target', target]);
  await assert.rejects(access(join(target, 'install-state.json')));
  await script(join(source, 'scripts/Install.ps1'), ['-Apply', '-Target', target]); const first = await state();
  let output = ''; let errors = '';
  child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(target, 'scripts/Start.ps1'), '-NoOpen', '-Port', '0'], { cwd: process.env.SystemRoot ?? 'C:\\Windows', env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { output += bytes.toString('utf8'); }); child.stderr.on('data', bytes => { errors += bytes.toString('utf8'); });
  const start = Date.now();
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) { if (child.exitCode !== null || Date.now() - start > 15000) throw new Error(`Start failed: ${errors}`); await new Promise(resolve => setTimeout(resolve, 50)); }
  const origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const html = await (await fetch(origin)).text(); assert.match(html, /<html/);
  const asset = html.match(/src="([^"]+\.js)"/)[1]; assert.equal((await fetch(origin + asset)).status, 200);
  assert.equal((await fetch(origin + '/api/status')).status, 403);
  assert.doesNotMatch(output, /#token=|Bearer /);
  const ownerBefore = await readFile(join(target, 'data/host/.host-lock'));
  await assert.rejects(script(join(target, 'scripts/Start.ps1'), ['-NoOpen', '-Port', '0']));
  assert.deepEqual(await readFile(join(target, 'data/host/.host-lock')), ownerBefore);
  await assert.rejects(script(join(source, 'scripts/Install.ps1'), ['-Apply', '-Target', target]));
  await stop();
  await access(join(target, 'data/host/.host-lock'));
  await writeFile(join(target, 'data/host/personal-fixture.txt'), 'preserved');
  await script(join(source, 'scripts/Install.ps1'), ['-Apply', '-Target', target]); const second = await state(); assert.notEqual(first.activeVersion, second.activeVersion);
  await script(join(target, 'scripts/Rollback.ps1')); assert.equal((await state()).activeVersion, first.activeVersion);
  // A synthetic Node executable with the bundled advisor's name/path exercises
  // the Windows process guard without opening a real advisor window.
  const advisor = join(target, 'versions', first.activeVersion, 'packages/advisor/Advisor.exe'); const advisorBytes = await readFile(advisor);
  await copyFile(join(target, 'versions', first.activeVersion, 'runtime/node.exe'), advisor);
  const advisorProcess = spawn(advisor, ['-e', 'setInterval(() => {}, 1000)'], { env, windowsHide: true, stdio: 'ignore' });
  await once(advisorProcess, 'spawn');
  try { await assert.rejects(script(join(target, 'scripts/Uninstall.ps1'))); assert.equal((await state()).activeVersion, first.activeVersion); }
  finally { const closed = once(advisorProcess, 'close'); advisorProcess.kill(); await closed; await writeFile(advisor, advisorBytes); }
  await writeFile(join(target, 'Start-Companion.cmd'), 'custom fixture launcher');
  await script(join(target, 'scripts/Uninstall.ps1'));
  assert.equal((await state()).activeVersion, null);
  assert.equal(await readFile(join(target, 'data/host/personal-fixture.txt'), 'utf8'), 'preserved');
  assert.equal(await readFile(join(target, 'Start-Companion.cmd'), 'utf8'), 'custom fixture launcher');
  for (const version of [first.activeVersion, second.activeVersion]) await assert.rejects(access(join(target, 'versions', version, 'runtime/node.exe')));
  await writeFile(join(source, 'runtime/node.exe'), 'corrupt fixture');
  // Launch the intact runtime from cache to test a corrupted source manifest (corrupt exe cannot run).
  const cli = join(source, 'dist/host/src/install-cli.js');
  await assert.rejects(run(process.execPath, [cli, 'preview', '--source', source, '--target', join(work, 'corrupt-target')], { env }));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data/release-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), runtime: '24.22.2', checks: ['archive without npm or LM Studio Node', 'preview without writes', 'PS5.1 Cyrillic/spaces/other cwd', 'static UI and token rejection', 'running host blocks update', 'update', 'rollback', 'running advisor blocks uninstall before changes', 'uninstall preserves personal data and modified launcher', 'runtime cleanup after child exits', 'tampered payload rejected'], ok: true }, null, 2));
  console.log('Release smoke: 11 checks passed; synthetic profile only.');
} finally {
  await stop();
  if (dirname(work) !== join(root, '.tools') || !work.split(/[\\/]/).at(-1).startsWith('release-check-')) throw new Error('Refusing fixture cleanup');
  await rm(work, { recursive: true, force: true });
}
