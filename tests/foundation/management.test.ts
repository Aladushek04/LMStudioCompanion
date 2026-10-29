import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { startManagementServer, type ManagementServer } from '../../packages/host/src/server.js';
import { SettingsStore } from '../../packages/host/src/settings.js';
import { ChatScopeStore } from '../../packages/host/src/chat-scopes.js';
import { defaultSettings } from '../../packages/core/src/settings.js';

const servers: ManagementServer[] = []; const roots: string[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'companion management кириллица ')); roots.push(path); return path; }
const report = { lmStudioVersion: 'test', checkedAt: '2026-10-29T10:00:00.000Z', features: { connection: { state: 'verified' as const, evidence: 'Локальная проверка' } } };
it('refusesStartDuringInstallation', async () => {
  const root = await directory(); const dir = join(root, 'data/host'); await mkdir(dir, { recursive: true });
  await writeFile(join(root, '.install-lock'), 'fixture');
  await expect(startManagementServer(dir, new AbortController().signal, { assets: new Map() })).rejects.toThrow('установ');
});
async function host(probe = async (_signal: AbortSignal) => report) {
  const dir = await directory();
  const server = await startManagementServer(dir, new AbortController().signal, { probe, assets: new Map([['/', { content: Buffer.from('<!doctype html><html lang="ru"><title>Панель</title></html>'), type: 'text/html; charset=utf-8' }]]) });
  servers.push(server); return { ...server, dir };
}
function headers(s: ManagementServer) { return { Authorization: `Bearer ${s.token}`, Origin: s.origin, 'Content-Type': 'application/json' }; }
it('rejectsUntrustedOrigin', async () => {
  const s = await host();
  const response = await fetch(s.origin + '/api/settings', { method: 'PUT', headers: { ...headers(s), Origin: 'https://evil.example' }, body: JSON.stringify(defaultSettings) });
  expect(response.status).toBe(403);
});
it('requiresMutationTokenAndOrigin', async () => {
  const s = await host();
  for (const h of [{ Origin: s.origin }, { Authorization: `Bearer ${s.token}` }]) {
    expect((await fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: h })).status).toBe(403);
  }
  expect((await fetch(s.origin + '/api/status')).status).toBe(403);
});
it('rejectsDnsRebindingHostAndCrossOriginGet', async () => {
  const s = await host();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(s.origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  expect(status).toBe(403);
  expect((await fetch(s.origin + '/api/status', { headers: { ...headers(s), Origin: 'https://evil.example' } })).status).toBe(403);
});
it('settingsSurviveRestartAndInvalidDataDoesNotOverwrite', async () => {
  const dir = await directory(); const store = new SettingsStore(dir);
  const next = { ...defaultSettings, defaultProjectId: 'Проект яблоки' };
  await store.writeSettings(next); expect(await new SettingsStore(dir).readSettings()).toEqual(next);
  await expect(store.writeSettings({ ...next, mode: 'invented' } as never)).rejects.toThrow();
  expect(await store.readSettings()).toEqual(next);
});
it('cancelledSettingsWriteKeepsPreviousState', async () => {
  const dir = await directory(); const store = new SettingsStore(dir); await store.writeSettings(defaultSettings);
  const controller = new AbortController(); controller.abort();
  await expect(store.writeSettings({ ...defaultSettings, mode: 'deep' }, controller.signal)).rejects.toThrow();
  expect(await store.readSettings()).toEqual(defaultSettings);
});
it('abortedHttpSettingsRequestDoesNotSavePartialBody', async () => {
  const s = await host();
  await new Promise<void>(resolve => {
    const request = httpRequest(s.origin + '/api/settings', { method: 'PUT', headers: headers(s) });
    request.on('error', () => undefined); request.once('close', () => resolve());
    request.write('{"version":1,"mode":', () => request.destroy());
  });
  const response = await fetch(s.origin + '/api/settings', { headers: headers(s) });
  expect(await response.json()).toMatchObject({ settings: defaultSettings });
  await expect(readFile(join(s.dir, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
it('changingDefaultDoesNotRebindChat', async () => {
  const scopes = new ChatScopeStore();
  const binding = scopes.bindChatScope('chat-1', 'project-a'); expect(binding.ok).toBe(true);
  expect(scopes.bindChatScope('chat-1', 'project-b').ok).toBe(false);
  expect(scopes.bindChatScope('chat-1', 'project-a')).toEqual(binding);
  const restarted = new ChatScopeStore().bindChatScope('chat-1', 'project-a');
  if (binding.ok && restarted.ok) expect(restarted.value.sessionId).not.toBe(binding.value.sessionId);
});
it('bindsDefaultOnlyOnFirstChatTurn', async () => {
  const dir = await directory(); const store = new SettingsStore(dir); const scopes = new ChatScopeStore();
  await store.writeSettings({ ...defaultSettings, defaultProjectId: 'a' });
  const first = scopes.bindChatScope('chat-1', (await store.readSettings()).defaultProjectId);
  await store.writeSettings({ ...defaultSettings, defaultProjectId: 'b' });
  expect(scopes.getBinding('chat-1')).toEqual(first.ok ? first.value : null);
  expect(scopes.bindChatScope('chat-2', (await store.readSettings()).defaultProjectId)).toMatchObject({ ok: true, value: { projectId: 'b' } });
});
it('writesValidatedPreferencesWithoutApplyingToLmStudio', async () => {
  const s = await host(); const next = { ...defaultSettings, webMode: 'research' };
  const response = await fetch(s.origin + '/api/settings', { method: 'PUT', headers: headers(s), body: JSON.stringify(next) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ settings: next, appliedToLmStudio: false });
  expect(JSON.parse(await readFile(join(s.dir, 'settings.json'), 'utf8'))).toEqual(next);
});
it('rejectsOversizedAndMalformedSettings', async () => {
  const s = await host();
  for (const [body, expected] of [['{', 400], [JSON.stringify({ ...defaultSettings, raw: {} }), 400], ['x'.repeat(70000), 413]] as const) {
    expect((await fetch(s.origin + '/api/settings', { method: 'PUT', headers: headers(s), body })).status).toBe(expected);
  }
});
it('diagnosticsExposeNoSessionTokenAndReturnConservativeMode', async () => {
  const s = await host(); const response = await fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: headers(s) });
  expect(response.status).toBe(200); const text = await response.text(); expect(text).not.toContain(s.token);
  expect(JSON.parse(text)).toMatchObject({ report, integration: { ok: true, value: 'tools-only' } });
  const page = await fetch(s.origin); expect(await page.text()).not.toContain(s.token);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
});
it('cancelStopsDiagnosticAndKeepsPreviousReport', async () => {
  let calls = 0; let didAbort = false;
  const s = await host(async signal => { if (++calls === 1) return report; await new Promise<void>(resolve => signal.addEventListener('abort', () => { didAbort = true; resolve(); }, { once: true })); signal.throwIfAborted(); return report; });
  await fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: headers(s) });
  const controller = new AbortController();
  const running = fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: headers(s), signal: controller.signal }).catch(() => null);
  for (let n = 0; n < 100 && calls < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toBe(2);
  expect((await fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: headers(s) })).status).toBe(409);
  controller.abort(); await running;
  for (let n = 0; n < 50 && !didAbort; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(didAbort).toBe(true);
  const snapshot = await (await fetch(s.origin + '/api/status', { headers: headers(s) })).json();
  expect(snapshot).toMatchObject({ report });
});
it('preventsTwoHostsFromWritingSameSettingsDirectory', async () => {
  const s = await host();
  await expect(startManagementServer(s.dir, new AbortController().signal, { port: 0 })).rejects.toThrow();
  await s.close();
  const next = await startManagementServer(s.dir, new AbortController().signal, { port: 0, assets: new Map() }); servers.push(next);
});
it('shutdownWaitsForOperationsBeforeReleasingSettingsOwnership', async () => {
  let started = false; let cleaned = false;
  const s = await host(async signal => {
    started = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; resolve(); }, 80), { once: true }));
    signal.throwIfAborted(); return report;
  });
  const pending = fetch(s.origin + '/api/diagnostics', { method: 'POST', headers: headers(s) }).catch(() => null);
  for (let n = 0; n < 100 && !started; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(started).toBe(true); await s.close();
  expect(cleaned).toBe(true); await pending;
});
