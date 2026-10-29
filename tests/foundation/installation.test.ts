import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectInstallation } from '../../packages/host/src/installation.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'companion-installation-')); roots.push(root); return root; }
it('missingInstallationDoesNotInventVersionsOrCapabilities', async () => {
  const root = await fixture(); const value = await inspectInstallation(new AbortController().signal, root);
  expect(value).toEqual({ lmStudioVersion: null, sdkVersion: null, compressorVersion: null, compressorRevision: null, sdkMethods: [], compressorOwnsPredictionLoop: false });
});
it('readsOnlyKnownPackageMetadataAndDeclarations', async () => {
  const root = await fixture();
  const plugin = join(root, 'extensions/plugins/rootmonster/context-compressor');
  const sdk = join(plugin, 'node_modules/@lmstudio/sdk');
  await mkdir(join(sdk, 'dist'), { recursive: true }); await mkdir(join(plugin, 'src'));
  await writeFile(join(plugin, 'package.json'), '{"name":"lms-plugin-context-compressor","version":"0.8.3"}');
  await writeFile(join(plugin, 'manifest.json'), '{"type":"plugin","owner":"rootmonster","name":"context-compressor","revision":27}');
  await writeFile(join(sdk, 'package.json'), '{"name":"@lmstudio/sdk","version":"1.5.0"}');
  await writeFile(join(sdk, 'dist/index.d.ts'), 'withPredictionLoopHandler(handler: Handler): PluginContext; startToolUseSession(): Promise<Session>;');
  await writeFile(join(plugin, 'src/index.ts'), 'context.withPredictionLoopHandler(handler);');
  const value = await inspectInstallation(new AbortController().signal, root);
  expect(value.sdkVersion).toBe('1.5.0'); expect(value.compressorRevision).toBe(27);
  expect(value.sdkMethods).toEqual(['withPredictionLoopHandler', 'startToolUseSession']);
  expect(value.compressorOwnsPredictionLoop).toBe(true);
  expect(value.lmStudioVersion).toBeNull();
});
it('malformedMetadataDoesNotTurnIntoPositiveEvidence', async () => {
  const root = await fixture(); const plugin = join(root, 'extensions/plugins/rootmonster/context-compressor');
  await mkdir(plugin, { recursive: true }); await writeFile(join(plugin, 'package.json'), '{"version":77}');
  await writeFile(join(plugin, 'manifest.json'), '{"revision":"latest"}');
  const value = await inspectInstallation(new AbortController().signal, root);
  expect(value.compressorVersion).toBeNull(); expect(value.compressorRevision).toBeNull();
});
it('cancelledInspectionDoesNotReadAnything', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(inspectInstallation(controller.signal, 'does-not-exist')).rejects.toMatchObject({ name: 'AbortError' });
});
it.skipIf(process.platform !== 'win32')('readsWindowsVersionFromObjectShapedInstallationMetadata', async () => {
  const root = await fixture(); await mkdir(join(root, '.internal'));
  // Настоящие Windows version resources без запуска указанного приложения.
  await writeFile(join(root, '.internal/app-install-location.json'), JSON.stringify({ path: process.execPath, argv: ['must-not-run'], cwd: root }));
  const value = await inspectInstallation(new AbortController().signal, root);
  expect(value.lmStudioVersion).toBe(process.versions.node);
});
