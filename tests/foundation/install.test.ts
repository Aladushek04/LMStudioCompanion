import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { installRelease, planInstall, restoreInstall, readInstallState, bootstrapFiles, uninstallRelease } from '../../packages/host/src/install.js';

const roots: string[] = [];
const fault = vi.hoisted(() => ({ destination: '', moveSource: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: vi.fn(async (...args: Parameters<typeof original.rm>) => {
    if (fault.moveSource && args[0] === fault.moveSource) { fault.moveSource = ''; throw Object.assign(new Error('Synthetic busy file'), { code: 'EPERM' }); }
    return original.rm(...args);
  }), rename: vi.fn(async (...args: Parameters<typeof original.rename>) => {
    if (fault.moveSource && args[0] === fault.moveSource) { fault.moveSource = ''; throw Object.assign(new Error('Synthetic busy file'), { code: 'EPERM' }); }
    return original.rename(...args);
  }), copyFile: vi.fn(async (...args: Parameters<typeof original.copyFile>) => {
    if (fault.destination && args[1] === fault.destination) { fault.destination = ''; throw new Error('Synthetic sharing violation'); }
    return original.copyFile(...args);
  }) };
});
it('uninstallFailureRestoresFilesAndCanBeRetried', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app');
  const receipt = await installRelease(source, target);
  fault.moveSource = join(target, 'versions', receipt.activeVersion, 'dist/host/src/main.js');
  await expect(uninstallRelease(target)).rejects.toThrow('busy');
  expect((await readInstallState(target))?.activeVersion).toBe(receipt.activeVersion);
  for (const name of bootstrapFiles) expect(await readFile(join(target, name), 'utf8')).toContain('0.1.0');
  await expect(uninstallRelease(target)).resolves.toHaveProperty('deferred');
  expect((await readInstallState(target))?.activeVersion).toBeNull();
});
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function root() { const p = await mkdtemp(join(tmpdir(), 'Companion установка ')); roots.push(p); return p; }
async function release(base: string, version: string) {
  const dir = join(base, version); await mkdir(dir);
  const files: Record<string, string> = {};
  for (const name of [...bootstrapFiles, 'runtime/node.exe', 'dist/host/src/main.js', 'dist/panel/index.html']) {
    const text = `fixture ${version} ${name}`;
    await mkdir(join(dir, name, '..'), { recursive: true }); await writeFile(join(dir, name), text);
    files[name] = createHash('sha256').update(text).digest('hex');
  }
  await writeFile(join(dir, 'release-manifest.json'), JSON.stringify({ product: 'LMStudioCompanion', version, platform: 'win32-x64', files }));
  return dir;
}
it('preservesOtherMcpServersWithoutRegisteringFakeServer', () => {
  const config = { mcpServers: { other: { command: 'fixture', args: ['a b'], env: { TOKEN: 'fixture-only' } } }, extra: true };
  const planned = planInstall(config, 'G:\\Projects\\папка с пробелами');
  expect(planned).toMatchObject({ ok: true, value: { nextConfig: config, changedKeys: [] } });
  expect(config.mcpServers.other.args).toEqual(['a b']);
});
it('handlesCyrillicProjectPathAndFirstInstallation', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'установлено приложение');
  const result = await installRelease(source, target);
  const state = await readInstallState(target);
  expect(state?.activeVersion).toBe(result.activeVersion);
  expect(await readFile(join(target, 'versions', result.activeVersion, 'runtime/node.exe'), 'utf8')).toContain('0.1.0');
  expect(await readFile(join(target, 'scripts/Start.ps1'), 'utf8')).toContain('0.1.0');
});
it('rollbackRestoresPreviousVersionAndKeepsPersonalData', async () => {
  const base = await root(); const a = await release(base, '0.1.0'); const b = await release(base, '0.1.1'); const target = join(base, 'app');
  const first = await installRelease(a, target);
  await mkdir(join(target, 'data/host'), { recursive: true }); await writeFile(join(target, 'data/host/settings.json'), 'personal fixture');
  const second = await installRelease(b, target);
  expect(await restoreInstall(second.backupPath)).toMatchObject({ ok: true });
  expect((await readInstallState(target))?.activeVersion).toBe(first.activeVersion);
  expect(await readFile(join(target, 'scripts/Start.ps1'), 'utf8')).toContain('0.1.0');
  expect(await readFile(join(target, 'data/host/settings.json'), 'utf8')).toBe('personal fixture');
});
it('firstInstallRollbackDeactivatesWithoutDeletingData', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app');
  const receipt = await installRelease(source, target); await mkdir(join(target, 'data')); await writeFile(join(target, 'data/user.txt'), 'keep');
  expect((await restoreInstall(receipt.backupPath)).ok).toBe(true);
  expect((await readInstallState(target))?.activeVersion).toBeNull();
  expect(await readFile(join(target, 'data/user.txt'), 'utf8')).toBe('keep');
});
it('rejectsStaleRollbackAfterAnotherUpdate', async () => {
  const base = await root(); const a = await release(base, '0.1.0'); const b = await release(base, '0.1.1'); const target = join(base, 'app');
  const first = await installRelease(a, target); const second = await installRelease(b, target);
  expect((await restoreInstall(first.backupPath)).ok).toBe(false);
  expect((await readInstallState(target))?.activeVersion).toBe(second.activeVersion);
});
it('rejectsUnownedDestinationAndModifiedBootstrap', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const foreign = join(base, 'foreign');
  await mkdir(foreign); await writeFile(join(foreign, 'personal.txt'), 'keep');
  await expect(installRelease(source, foreign)).rejects.toThrow();
  expect(await readFile(join(foreign, 'personal.txt'), 'utf8')).toBe('keep');
  const target = join(base, 'app'); const first = await installRelease(source, target);
  await writeFile(join(target, 'Start-Companion.cmd'), 'custom user launcher');
  await expect(installRelease(source, target)).rejects.toThrow();
  expect((await readInstallState(target))?.activeVersion).toBe(first.activeVersion);
  expect(await readFile(join(target, 'Start-Companion.cmd'), 'utf8')).toBe('custom user launcher');
});
it('rejectsTamperedReleaseAndTraversalBeforeActivation', async () => {
  const base = await root(); const source = await release(base, '0.1.0');
  await writeFile(join(source, 'runtime/node.exe'), 'tampered');
  await expect(installRelease(source, join(base, 'app'))).rejects.toThrow();
  const manifest = JSON.parse(await readFile(join(source, 'release-manifest.json'), 'utf8'));
  manifest.files['../outside.txt'] = 'a'.repeat(64);
  await writeFile(join(source, 'release-manifest.json'), JSON.stringify(manifest));
  await expect(installRelease(source, join(base, 'app2'))).rejects.toThrow();
});
it('abortedOrRunningInstallationDoesNotChangeActiveVersion', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app');
  const first = await installRelease(source, target); const controller = new AbortController(); controller.abort();
  await expect(installRelease(source, target, controller.signal)).rejects.toThrow();
  await mkdir(join(target, 'data/host'), { recursive: true }); await writeFile(join(target, 'data/host/.host-lock'), 'fixture');
  await expect(installRelease(source, target)).rejects.toThrow();
  expect((await readInstallState(target))?.activeVersion).toBe(first.activeVersion);
});
it('uninstallKeepsPersonalDataAndModifiedFiles', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app');
  const receipt = await installRelease(source, target);
  await mkdir(join(target, 'data')); await writeFile(join(target, 'data/user.txt'), 'keep');
  await writeFile(join(target, 'versions', receipt.activeVersion, 'extra.txt'), 'keep');
  await writeFile(join(target, 'Start-Companion.cmd'), 'custom');
  const result = await uninstallRelease(target);
  expect((await readInstallState(target))?.activeVersion).toBeNull();
  expect(await readFile(join(target, 'data/user.txt'), 'utf8')).toBe('keep');
  expect(await readFile(join(target, 'versions', receipt.activeVersion, 'extra.txt'), 'utf8')).toBe('keep');
  expect(result.preserved).toContain('Start-Companion.cmd');
  expect(Object.keys(result.deferred)).toContain(`versions/${receipt.activeVersion}/runtime/node.exe`);
});
it('rollbackCopyFailureRestoresCurrentBootstrapAndState', async () => {
  const base = await root(); const a = await release(base, '0.1.0'); const b = await release(base, '0.1.1'); const target = join(base, 'app');
  await installRelease(a, target); const second = await installRelease(b, target);
  fault.destination = join(target, 'scripts/Start.ps1');
  expect((await restoreInstall(second.backupPath)).ok).toBe(false);
  expect((await readInstallState(target))?.activeVersion).toBe(second.activeVersion);
  for (const name of bootstrapFiles) expect(await readFile(join(target, name), 'utf8')).toContain('0.1.1');
});
it('rejectsVersionsJunctionBeforeWritingOutsideInstallation', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app'); const outside = join(base, 'outside');
  await mkdir(target); await mkdir(outside);
  await writeFile(join(target, 'install-state.json'), JSON.stringify({ product: 'LMStudioCompanion', root: target, activeVersion: null, bootstrapVersion: null, lastBackup: null }));
  await symlink(outside, join(target, 'versions'), 'junction'); vi.mocked(copyFile).mockClear();
  await expect(installRelease(source, target)).rejects.toThrow();
  expect(copyFile).not.toHaveBeenCalled();
});
it('firstInstallationCopyFailureCanBeRetried', async () => {
  const base = await root(); const source = await release(base, '0.1.0'); const target = join(base, 'app');
  fault.destination = join(target, 'scripts/Start.ps1');
  await expect(installRelease(source, target)).rejects.toThrow('sharing');
  expect((await readInstallState(target))?.activeVersion).toBeNull();
  await expect(installRelease(source, target)).resolves.toHaveProperty('activeVersion');
});
