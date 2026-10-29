import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { runDiagnostics, parseArguments } from '../../packages/host/src/diagnose.js';
import { capabilityReportSchema } from '../../packages/core/src/contracts.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const servers: Server[] = []; const roots: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockImplementation(realFs.writeFile);
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function output() { const root = await mkdtemp(join(tmpdir(), 'companion-diagnostics-')); roots.push(root); return join(root, 'report.json'); }
async function serve(body: string, controller?: AbortController) {
  const server = createServer((_req, res) => { if (controller) { controller.abort(); return; } res.end(body); });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Нет порта');
  return `http://127.0.0.1:${address.port}`;
}
const installation = { lmStudioVersion: null, sdkVersion: null, compressorVersion: null, compressorRevision: null, sdkMethods: [], compressorOwnsPredictionLoop: false };
it('writesValidatedReportAndSelectsConservativeMode', async () => {
  const outputPath = await output(); const baseUrl = await serve('{"models":[]}');
  await writeFile(outputPath, 'previous report');
  const result = await runDiagnostics(new AbortController().signal, { baseUrl, outputPath, installation });
  const report = capabilityReportSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
  expect(report.features.connection?.state).toBe('verified');
  expect(result.integration).toMatchObject({ ok: true, value: 'tools-only' });
  expect(report.features.thinking?.state).toBe('unknown');
});
it('cancelledDiagnosticDoesNotOverwritePreviousReport', async () => {
  const outputPath = await output(); await writeFile(outputPath, 'previous report');
  const controller = new AbortController(); const baseUrl = await serve('', controller);
  await expect(runDiagnostics(controller.signal, { baseUrl, outputPath, installation })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readFile(outputPath, 'utf8')).toBe('previous report');
});
it('cancellationAfterTemporaryWriteKeepsOldReportAndRemovesTemporary', async () => {
  const outputPath = await output(); await writeFile(outputPath, 'previous report');
  const controller = new AbortController(); const baseUrl = await serve('{"models":[]}');
  // Настоящая запись во временный файл; управляется только момент поступления отмены.
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await realFs.writeFile(...args); controller.abort();
  });
  await expect(runDiagnostics(controller.signal, { baseUrl, outputPath, installation })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readFile(outputPath, 'utf8')).toBe('previous report');
  expect(await readdir(join(outputPath, '..'))).toEqual(['report.json']);
});
it('argumentsRejectMissingValuesUnknownFlagsAndInvalidTimeouts', () => {
  for (const argv of [['--output'], ['--unknown'], ['--timeout-ms', '-1'], ['--timeout-ms', 'NaN']]) expect(() => parseArguments(argv)).toThrow();
  expect(parseArguments(['--url', 'http://127.0.0.1:1234', '--output', 'report.json', '--timeout-ms', '100'])).toMatchObject({ baseUrl: 'http://127.0.0.1:1234', outputPath: 'report.json', timeoutMs: 100 });
});
