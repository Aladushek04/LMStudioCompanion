import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OperationResult } from '../../core/src/contracts.js';

export const bootstrapFiles = ['Start-Companion.cmd', 'Diagnose-Companion.cmd', 'Start-Advisor.cmd', 'Rollback-Companion.cmd', 'Uninstall-Companion.cmd', 'scripts/Start.ps1', 'scripts/Rollback.ps1', 'scripts/Uninstall.ps1'] as const;
const product = 'LMStudioCompanion';
const id = z.string().uuid();
const manifestSchema = z.object({ product: z.literal(product), version: z.string().min(1), platform: z.literal('win32-x64'), files: z.record(z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
const stateSchema = z.object({ product: z.literal(product), root: z.string(), activeVersion: id.nullable(), bootstrapVersion: id.nullable(), lastBackup: z.string().nullable() }).strict();
type State = z.infer<typeof stateSchema>;
const backupSchema = z.object({ product: z.literal(product), root: z.string(), expectedActiveVersion: id, previous: stateSchema.nullable() }).strict();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
export function safeReleasePath(name: string) {
  if (!name || isAbsolute(name) || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw new Error('Недопустимый путь в комплекте.');
  return name;
}
/** Reject junctions/symlinks in every existing ancestor, including the root. */
async function plainPath(path: string) {
  const absolute = resolve(path); const parent = dirname(absolute);
  if (parent !== absolute) await plainPath(parent);
  if (await exists(absolute) && (await lstat(absolute)).isSymbolicLink()) throw new Error('Ссылки и junction в пути установки запрещены.');
}
async function manifest(root: string, verify = true) {
  await plainPath(join(root, 'release-manifest.json'));
  const parsed = manifestSchema.parse(JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8')));
  const folded = new Set<string>();
  for (const [name, digest] of Object.entries(parsed.files)) {
    safeReleasePath(name);
    if (folded.has(name.toLowerCase())) throw new Error('Повтор пути в комплекте.');
    folded.add(name.toLowerCase());
    const path = join(root, name); await plainPath(path);
    if (verify && (!(await lstat(path)).isFile() || hash(await readFile(path)) !== digest)) throw new Error(`Повреждён файл комплекта: ${name}`);
  }
  for (const name of [...bootstrapFiles, 'runtime/node.exe', 'dist/host/src/main.js', 'dist/panel/index.html']) if (!parsed.files[name]) throw new Error(`Неполный комплект: ${name}`);
  return parsed;
}
export async function readInstallState(root: string): Promise<State | null> {
  root = resolve(root); await plainPath(join(root, 'install-state.json'));
  if (!await exists(join(root, 'install-state.json'))) return null;
  const state = stateSchema.parse(JSON.parse(await readFile(join(root, 'install-state.json'), 'utf8')));
  if (state.root !== root) throw new Error('Папка установки не совпадает с её записью.');
  return state;
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function mutationLock(root: string) {
  await plainPath(root); await mkdir(root, { recursive: true });
  const lockPath = join(root, '.install-lock');
  const handle = await open(lockPath, 'wx').catch(() => { throw new Error('Установка или удаление уже выполняется.'); });
  try { if (await exists(join(root, 'data/host/.host-lock'))) throw new Error('Сначала остановите панель Companion.'); }
  catch (error) { await handle.close(); await rm(lockPath, { force: true }); throw error; }
  return async () => { await handle.close(); await rm(lockPath, { force: true }); };
}
async function checkBootstrap(root: string, previous: State | null) {
  const old = previous?.bootstrapVersion ? await manifest(join(root, 'versions', previous.bootstrapVersion), false) : null;
  for (const name of bootstrapFiles) {
    const path = join(root, name); await plainPath(path);
    if (await exists(path) && (!old || hash(await readFile(path)) !== old.files[name])) throw new Error(`Сохранён изменённый или чужой файл: ${name}`);
  }
}
async function copyBootstrap(root: string, source: string) {
  for (const name of bootstrapFiles) { await mkdir(dirname(join(root, name)), { recursive: true }); await copyFile(join(source, name), join(root, name)); }
}
export function planInstall(existingConfig: unknown, _projectDir: string): OperationResult<{ nextConfig: unknown; changedKeys: string[] }> {
  // Stage 00 is a local panel, not an MCP server. No registration is invented.
  return { ok: true, value: { nextConfig: structuredClone(existingConfig), changedKeys: [] }, warnings: [] };
}
export async function previewInstall(source: string, target: string) {
  const release = await manifest(resolve(source)); const previous = await readInstallState(target);
  return { version: release.version, target: resolve(target), action: previous?.activeVersion ? 'Обновление' : 'Установка', changes: ['Отдельная версия приложения', 'Ярлыки запуска', 'Резервная копия указателя версии'], preserved: ['Данные Companion', 'Настройки LM Studio и MCP', 'Установленные плагины'] };
}
export async function installRelease(source: string, root: string, signal = new AbortController().signal) {
  source = resolve(source); root = resolve(root); signal.throwIfAborted();
  const rel = relative(source, root);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Выберите папку вне исходного комплекта.');
  const release = await manifest(source); await plainPath(root);
  if (await exists(root) && !await exists(join(root, 'install-state.json')) && (await readdir(root)).length) throw new Error('Непустая папка не принадлежит Companion.');
  const unlock = await mutationLock(root); const versionId = randomUUID(); const versionRoot = join(root, 'versions', versionId);
  let committed = false; let bootstrapTouched = false; let versionCreated = false;
  let previous: State | null = null;
  try {
    previous = await readInstallState(root);
    await checkBootstrap(root, previous); signal.throwIfAborted(); await plainPath(versionRoot);
    // Claim only the previously empty, validated destination. Failed first
    // installs remain recognisable and retryable without deleting anything.
    if (!previous) await atomicJson(join(root, 'install-state.json'), { product, root, activeVersion: null, bootstrapVersion: null, lastBackup: null });
    await mkdir(versionRoot, { recursive: true }); versionCreated = true;
    for (const name of [...Object.keys(release.files), 'release-manifest.json']) {
      signal.throwIfAborted(); await mkdir(dirname(join(versionRoot, name)), { recursive: true }); await copyFile(join(source, name), join(versionRoot, name));
    }
    await manifest(versionRoot); signal.throwIfAborted();
    const backupPath = join(root, 'backups', `install-${versionId}.json`); await plainPath(backupPath); await mkdir(dirname(backupPath), { recursive: true });
    await atomicJson(backupPath, { product, root, expectedActiveVersion: versionId, previous });
    bootstrapTouched = true; await copyBootstrap(root, versionRoot);
    // Commit boundary: do not interrupt between bootstrap and active pointer.
    await atomicJson(join(root, 'install-state.json'), { product, root, activeVersion: versionId, bootstrapVersion: versionId, lastBackup: backupPath }); committed = true;
    return { activeVersion: versionId, backupPath };
  } finally {
    try {
      if (!committed) {
        if (bootstrapTouched) {
          if (previous?.bootstrapVersion) await copyBootstrap(root, join(root, 'versions', previous.bootstrapVersion));
          else for (const name of bootstrapFiles) if (await exists(join(root, name)) && hash(await readFile(join(root, name))) === release.files[name]) await rm(join(root, name));
        }
        // Only the newly-created UUID directory under this verified owned root.
        if (versionCreated) { await plainPath(versionRoot); await rm(versionRoot, { recursive: true, force: true }); }
      }
    } finally { await unlock(); }
  }
}
export async function restoreInstall(backupPath: string): Promise<OperationResult<void>> {
  let unlock: (() => Promise<void>) | undefined;
  try {
    backupPath = resolve(backupPath); await plainPath(backupPath);
    const backup = backupSchema.parse(JSON.parse(await readFile(backupPath, 'utf8')));
    const root = resolve(backup.root);
    if (dirname(backupPath) !== join(root, 'backups') || !/^install-[a-f0-9-]{36}\.json$/.test(backupPath.split(sep).at(-1) ?? '')) throw new Error('Это не резервная копия установки.');
    unlock = await mutationLock(root); const current = await readInstallState(root);
    if (!current || current.activeVersion !== backup.expectedActiveVersion) throw new Error('Резервная копия устарела; активная версия сохранена.');
    if (backup.previous && backup.previous.root !== root) throw new Error('Некорректная папка резервной копии.');
    await checkBootstrap(root, current);
    if (backup.previous?.bootstrapVersion) await manifest(join(root, 'versions', backup.previous.bootstrapVersion));
    try {
      if (backup.previous?.bootstrapVersion) await copyBootstrap(root, join(root, 'versions', backup.previous.bootstrapVersion));
      await atomicJson(join(root, 'install-state.json'), backup.previous ?? { ...current, activeVersion: null, lastBackup: null });
    }
    catch (error) { if (current.bootstrapVersion) await copyBootstrap(root, join(root, 'versions', current.bootstrapVersion)); throw error; }
    return { ok: true, value: undefined, warnings: [] };
  } catch (error) { return { ok: false, code: 'INSTALL_ROLLBACK', message: error instanceof Error ? error.message : 'Откат не выполнен.', retryable: false }; }
  finally { await unlock?.(); }
}
/** Delete only unchanged manifest-owned files; return runtime paths for removal after Node exits. */
export async function uninstallRelease(root: string) {
  root = resolve(root); const current = await readInstallState(root); if (!current) throw new Error('Папка не принадлежит установленному Companion.');
  const unlock = await mutationLock(root);
  try {
    const files: Record<string, string> = {};
    const versionsPath = join(root, 'versions'); await plainPath(versionsPath);
    if (await exists(versionsPath)) for (const version of await readdir(versionsPath)) {
      if (!id.safeParse(version).success) continue;
      const versionRoot = join(versionsPath, version); const release = await manifest(versionRoot, false);
      for (const [name, digest] of Object.entries(release.files)) files[`versions/${version}/${name}`] = digest;
      if (version === current.bootstrapVersion) for (const name of bootstrapFiles) files[name] = release.files[name]!;
    }
    const deferred: Record<string, string> = {}; const preserved: string[] = [];
    const staging = `.uninstall-${randomUUID()}`; const moved: [string, string][] = [];
    try {
      for (const [name, digest] of Object.entries(files)) {
        const path = join(root, name); await plainPath(path); if (!await exists(path)) continue;
        if (hash(await readFile(path)) !== digest) { preserved.push(name); continue; }
        if (name.endsWith('/runtime/node.exe')) { deferred[name] = digest; continue; }
        const stagedName = `${staging}/${name}`; const staged = join(root, stagedName); await plainPath(staged);
        await mkdir(dirname(staged), { recursive: true }); await rename(path, staged); moved.push([path, staged]); deferred[stagedName] = digest;
      }
      await atomicJson(join(root, 'install-state.json'), { ...current, activeVersion: null, bootstrapVersion: null });
    } catch (error) {
      // A locked executable cannot leave the installed app half-removed.
      for (const [path, staged] of moved.reverse()) { await mkdir(dirname(path), { recursive: true }); await rename(staged, path); }
      throw error;
    }
    const dirs = new Set(Object.keys(files).flatMap(name => { const result: string[] = []; let p = dirname(join(root, name)); while (p !== root) { result.push(p); p = dirname(p); } return result; }));
    for (const path of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(path).catch((e: NodeJS.ErrnoException) => { if (!['ENOTEMPTY', 'ENOENT'].includes(e.code ?? '')) throw e; });
    return { root, deferred, preserved };
  } finally { await unlock(); }
}
