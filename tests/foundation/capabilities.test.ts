import { createServer, type Server, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { probeCapabilities, type InstallationFacts } from '../../packages/host/src/capabilities.js';
import { selectIntegration } from '../../packages/lmstudio-plugin/src/integration.js';
import type { CapabilityReport } from '../../packages/core/src/contracts.js';

const installation: InstallationFacts = { lmStudioVersion: '0.4.26.0', sdkVersion: '1.5.0', compressorVersion: '0.8.3', compressorRevision: 27, sdkMethods: ['withPredictionLoopHandler', 'startToolUseSession', 'prepareFile', 'abortSignal'], compressorOwnsPredictionLoop: true };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function serve(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('Нет тестового порта');
  return `http://127.0.0.1:${addr.port}`;
}
const modelList = { models: [{ key: 'fixture-model', type: 'llm', loaded_instances: [{ id: 'private-instance-name' }] }] };
function report(states: Record<string, 'verified' | 'unsupported' | 'unknown'> = {}): CapabilityReport {
  return { lmStudioVersion: '0.4.26', checkedAt: '2026-10-29T10:00:00.000Z', features: Object.fromEntries(Object.entries({ connection: 'verified', singlePredictionOwner: 'unknown', predictionOwnerExtend: 'unknown', predictionOwnerReplace: 'unknown', ...states }).map(([name, state]) => [name, { state, evidence: 'Контрольная проверка' }])) } as CapabilityReport;
}
describe('read-only диагностика', () => {
  it('unsupportedThinkingEvenWhenApiAndSdkAreAvailable', async () => {
    const requests: string[] = [];
    const baseUrl = await serve((req, res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelList)); });
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
    expect(value.features.connection?.state).toBe('verified');
    expect(value.features.thinking?.state).toBe('unknown');
    expect(value.features.toolsSession?.state).toBe('unknown');
    expect(value.features.stableChatScopeId?.state).toBe('unknown');
    expect(value.features.persistentFileHandle?.state).toBe('unknown');
    expect(requests).toEqual(['GET /api/v1/models']);
    expect(JSON.stringify(value)).not.toContain('private-instance-name');
    expect(JSON.stringify(value)).not.toContain('fixture-model');
  });
  it('serverUnavailableDoesNotPretendLmStudioIsConnected', async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(503); res.end('fixture secret'); });
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
    expect(value.features.connection?.state).toBe('unknown');
    expect(selectIntegration(value, null).ok).toBe(false);
    expect(JSON.stringify(value)).not.toContain('fixture secret');
  });
  it('authenticationFailureDoesNotReadCredentials', async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(401); res.end('token=secret'); });
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
    expect(value.features.connection?.state).toBe('unknown');
    expect(value.features.connection?.evidence).toContain('401');
    expect(JSON.stringify(value)).not.toContain('secret');
  });
  it('invalidApiPayloadRemainsUnknown', async () => {
    for (const body of ['not-json', '{}', '{"models":[null]}', '{"models":[{}]}', '{"models":[{"key":"x"}]}']) {
      const baseUrl = await serve((_req, res) => res.end(body));
      const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
      expect(value.features.connection?.state).toBe('unknown');
    }
  });
  it('packageVersionAloneDoesNotVerifySdkDeclarations', async () => {
    const baseUrl = await serve((_req, res) => res.end('{"models":[]}'));
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation: { ...installation, sdkMethods: [] } });
    expect(value.features.sdkSurface?.state).toBe('unknown');
  });
  it('redirectIsNotFollowed', async () => {
    let targetCalls = 0;
    const target = await serve((_req, res) => { targetCalls++; res.end(JSON.stringify(modelList)); });
    const baseUrl = await serve((_req, res) => { res.writeHead(302, { Location: `${target}/api/v1/models` }); res.end(); });
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
    expect(value.features.connection?.state).toBe('unknown'); expect(targetCalls).toBe(0);
  });
  it('timeoutBoundsHeadersAndBody', async () => {
    for (const sendHeaders of [false, true]) {
      const baseUrl = await serve((_req, res) => { if (sendHeaders) { res.writeHead(200); res.write('{"models":['); } });
      const start = performance.now();
      const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation, timeoutMs: 40 });
      expect(value.features.connection?.state).toBe('unknown'); expect(performance.now() - start).toBeLessThan(1500);
    }
  });
  it('cancelBeforeProbeDoesNotSendRequest', async () => {
    let calls = 0; const baseUrl = await serve((_req, res) => { calls++; res.end('{}'); });
    const controller = new AbortController(); controller.abort();
    await expect(probeCapabilities(controller.signal, { baseUrl, installation })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
  it('cancelDuringRequestStopsWaiting', async () => {
    const controller = new AbortController(); const baseUrl = await serve(() => controller.abort());
    await expect(probeCapabilities(controller.signal, { baseUrl, installation, timeoutMs: 2000 })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejectsRemoteOrCredentialBearingUrlsBeforeRequest', async () => {
    for (const baseUrl of ['https://example.com', 'http://user:password@127.0.0.1:1234', 'http://127.0.0.1:1234/?token=secret']) {
      await expect(probeCapabilities(new AbortController().signal, { baseUrl, installation })).rejects.toThrow();
    }
  });
  it('limitsResponseSize', async () => {
    const baseUrl = await serve((_req, res) => res.end(JSON.stringify({ models: [], extra: 'x'.repeat(1_100_000) })));
    const value = await probeCapabilities(new AbortController().signal, { baseUrl, installation });
    expect(value.features.connection?.state).toBe('unknown');
  });
});
describe('выбор режима без регистрации обработчика', () => {
  it('twoPredictionOwnersAreRejected', () => {
    expect(selectIntegration(report({ singlePredictionOwner: 'unsupported' }), 'context-compressor').ok).toBe(false);
  });
  it('unverifiedIntegrationFallsBackToToolsOnly', () => {
    expect(selectIntegration(report(), 'context-compressor')).toMatchObject({ ok: true, value: 'tools-only' });
  });
  it('compressorConflictRejected', () => {
    expect(selectIntegration(report({ predictionOwnerExtend: 'verified', compressorCompatible: 'unsupported' }), 'context-compressor').ok).toBe(false);
  });
  it('methodPresenceDoesNotAuthorizeExtension', () => {
    expect(selectIntegration(report({ predictionOwnerExtend: 'verified', compressorCompatible: 'verified' }), 'context-compressor').ok).toBe(false);
  });
  it('extendDoesNotImplyThinking', () => {
    const value = report({ predictionOwnerExtend: 'verified', compressorCompatible: 'verified', singlePredictionOwner: 'verified', preservesAttachments: 'verified', preservesToolContinuation: 'verified', cancellation: 'verified', thinking: 'unknown' });
    expect(selectIntegration(value, 'context-compressor')).toMatchObject({ ok: true, value: 'extend' });
    expect(value.features.thinking?.state).toBe('unknown');
  });
  it('replacementRequiresExplicitAuthorization', () => {
    const value = report({ predictionOwnerReplace: 'verified', compressorCompatible: 'verified', singlePredictionOwner: 'verified', preservesAttachments: 'verified', preservesToolContinuation: 'verified', cancellation: 'verified' });
    expect(selectIntegration(value, 'context-compressor').ok).toBe(false);
    value.features.replacementAuthorized = { state: 'verified', evidence: 'Явное переключение в тестовом профиле' };
    expect(selectIntegration(value, 'context-compressor')).toMatchObject({ ok: true, value: 'replace' });
  });
});
