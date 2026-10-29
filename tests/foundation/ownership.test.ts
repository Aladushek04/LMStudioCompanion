import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { acquireSettingsOwnership } from '../../packages/host/src/ownership.js';

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function directory() { const p = await mkdtemp(join(tmpdir(), 'Companion владелец ')); roots.push(p); return p; }
it('neverDisplacesPossibleLegacyOwner', async () => {
  const dir = await directory(); await writeFile(join(dir, '.host-lock'), String(process.pid));
  await expect(acquireSettingsOwnership(dir)).rejects.toThrow();
  expect(await readFile(join(dir, '.host-lock'), 'utf8')).toBe(String(process.pid));
});
it('windowsKernelOwnershipSurvivesDeletedMetadataAndReleasesOnCrash', async () => {
  if (process.platform !== 'win32') return;
  const dir = await directory();
  const code = `const {acquireSettingsOwnership}=await import(${JSON.stringify(new URL('../../packages/host/src/ownership.ts', import.meta.url).href)}); await acquireSettingsOwnership(${JSON.stringify(dir)}); process.stdout.write('READY\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ownership fixture timed out')), 4000);
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('READY')) { clearTimeout(timeout); resolve(); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timeout); reject(new Error('Ownership fixture exited before ready')); });
    });
    await rm(join(dir, '.host-lock'));
    await expect(acquireSettingsOwnership(dir)).rejects.toThrow();
    const closed = once(child, 'close'); child.kill(); await closed;
    const release = await acquireSettingsOwnership(dir); await release();
  } finally { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } }
});
it('doesNotReadOrReplaceHardlinkedMetadata', async () => {
  if (process.platform !== 'win32') return;
  const dir = await directory(); const release = await acquireSettingsOwnership(dir);
  const metadata = await readFile(join(dir, '.host-lock')); await release();
  const protectedFile = join(dir, 'user-fixture.txt'); await writeFile(protectedFile, metadata); await link(protectedFile, join(dir, '.host-lock'));
  await expect(acquireSettingsOwnership(dir)).rejects.toThrow();
  expect(await readFile(protectedFile)).toEqual(metadata);
});
