import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, cp, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { wrapper } from './launchers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const lock = JSON.parse(await readFile(join(root, 'scripts/runtime-lock.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = join(root, '.tools', `package-${randomUUID()}`);
const output = join(root, 'releases', `LMStudioCompanion-${pkg.version}-win-x64.zip`);
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(stage, { recursive: true }); await mkdir(dirname(output), { recursive: true });
const copy = async (from, to = from) => { await mkdir(dirname(join(stage, to)), { recursive: true }); await copyFile(join(root, from), join(stage, to)); };
try {
  await run(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root });
  const cache = join(root, '.tools', `node-${lock.node.version}.zip`);
  let archive;
  try { archive = await readFile(cache); } catch (e) { if (e.code !== 'ENOENT') throw e; const response = await fetch(lock.node.url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`Node download: ${response.status}`); archive = Buffer.from(await response.arrayBuffer()); await writeFile(cache, archive); }
  if (checksum(archive) !== lock.node.sha256) throw new Error('Node archive SHA-256 mismatch');
  const unpack = join(stage, 'unpack');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:COMPANION_ARCHIVE, $env:COMPANION_UNPACK)'], { env: { ...process.env, COMPANION_ARCHIVE: cache, COMPANION_UNPACK: unpack }, windowsHide: true });
  await mkdir(join(stage, 'runtime')); await mkdir(join(stage, 'licenses'));
  await copyFile(join(unpack, lock.node.folder, 'node.exe'), join(stage, 'runtime/node.exe'));
  await copyFile(join(unpack, lock.node.folder, 'LICENSE'), join(stage, 'licenses/Node-LICENSE.txt'));
  if (dirname(unpack) !== stage || !stage.startsWith(join(root, '.tools') + '\\')) throw new Error('Invalid own staging path');
  await rm(unpack, { recursive: true });
  for (const entry of ['main', 'diagnose', 'install-cli']) await build({ entryPoints: [join(root, `packages/host/src/${entry}.ts`)], outfile: join(stage, `dist/host/src/${entry}.js`), bundle: true, platform: 'node', format: 'esm', target: 'node24', legalComments: 'eof' });
  await cp(join(root, 'dist/panel'), join(stage, 'dist/panel'), { recursive: true });
  for (const name of ['Start-Companion.cmd', 'Install-Companion.cmd', 'Rollback-Companion.cmd', 'Uninstall-Companion.cmd', 'scripts/Start.ps1', 'scripts/Install.ps1', 'scripts/Rollback.ps1', 'scripts/Uninstall.ps1', 'LICENSE', 'docs/USER-GUIDE.md']) await copy(name);
  const guidePath = join(stage, 'docs/USER-GUIDE.md');
  const guide = await readFile(guidePath, 'utf8');
  await writeFile(guidePath, guide.replace(/\]\(((?:plans|research)\/[^)]+)\)/g, '](' + 'https://github.com/Aladushek04/LMStudioCompanion/blob/feat/foundation-panel/docs/$1)'));
  await writeFile(join(stage, 'Diagnose-Companion.cmd'), wrapper('Diagnose', true));
  await writeFile(join(stage, 'Start-Advisor.cmd'), wrapper('Advisor'));
  const advisor = JSON.parse(await readFile(join(root, 'reference/advisor-manifest.json'), 'utf8'));
  for (const [name, digest] of Object.entries(advisor.files)) {
    if (name === '.gitignore' || name.startsWith('tests/') || name === 'Build.ps1' || name.endsWith('.cs')) continue;
    const source = `packages/advisor/${name}`;
    if (checksum(await readFile(join(root, source))) !== digest) throw new Error(`Advisor baseline changed: ${name}`);
    await copy(source);
  }
  for (const dep of ['zod', 'react', 'react-dom', 'scheduler']) await copy(`node_modules/${dep}/LICENSE`, `licenses/${dep}-LICENSE.txt`);
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2));
  await writeFile(join(stage, 'README.txt'), 'LM Studio Companion — Windows x64\r\nРаспакуйте архив. Откройте Start-Companion.cmd для переносного запуска\r\nили Install-Companion.cmd для установки. Node.js уже включён.\r\nИнструкция: docs/USER-GUIDE.md. Данные: data/.\r\n');
  const files = {};
  async function walk(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) await walk(path); else files[relative(stage, path).replaceAll('\\', '/')] = checksum(await readFile(path)); } }
  await walk(stage);
  await writeFile(join(stage, 'release-manifest.json'), JSON.stringify({ product: 'LMStudioCompanion', version: pkg.version, platform: 'win32-x64', files }, null, 2));
  await rm(output, { force: true });
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:COMPANION_STAGE, $env:COMPANION_OUTPUT)'], { env: { ...process.env, COMPANION_STAGE: stage, COMPANION_OUTPUT: output }, windowsHide: true });
  const digest = checksum(await readFile(output)); await writeFile(output + '.sha256', `${digest}  ${output.split(/[\\/]/).at(-1)}\n`);
  console.log(JSON.stringify({ archive: output, sha256: digest, files: Object.keys(files).length, runtime: lock.node.version }, null, 2));
} finally {
  if (dirname(stage) !== join(root, '.tools') || !/^package-[a-f0-9-]{36}$/.test(stage.split(/[\\/]/).at(-1))) throw new Error('Refusing staging cleanup');
  await rm(stage, { recursive: true, force: true });
}
