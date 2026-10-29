import { expect, it } from 'vitest';
import { SourceRegistry } from '../../packages/core/src/sources/registry.js';
import { decideWebAnswer } from '../../packages/lmstudio-plugin/src/web/answer-guard.js';
import type { SourceRecord } from '../../packages/core/src/contracts.js';
const source = (uri: string, status: SourceRecord['status'] = 'ok'): Omit<SourceRecord, 'id'|'turnId'> => ({ uri, title: 'Fixture', kind: 'web_text', status, retrievedAt: '2026-10-29T16:00:00Z', contentHash: 'a'.repeat(64), chunks: status === 'ok' ? [{ id: 'chunk', text: 'Actual evidence', locator: 'chars=0:15' }] : [] });
it('unknownSourceIdRejectedAndTurnCannotBeSpoofed', () => {
  const registry = new SourceRegistry('turn-a'); const item = registry.registerSource('turn-a', source('https://example.org/a'));
  expect(registry.validateSourceIds('turn-a', [item.id]).ok).toBe(true);
  expect(registry.validateSourceIds('turn-b', [item.id]).ok).toBe(false);
  expect(registry.validateSourceIds('turn-a', ['made-up']).ok).toBe(false);
  expect(() => registry.registerSource('turn-b', source('https://example.org/b'))).toThrow();
});
it('allReadsFailedCannotClaimRead', () => {
  const registry = new SourceRegistry('turn');
  for (const status of ['blocked', 'empty', 'timeout', 'error'] as const) {
    const record = registry.registerSource('turn', source('https://example.org/a', status));
    expect(decideWebAnswer('https://example.org/a', [record])).toMatchObject({ kind: 'source-unavailable' });
  }
  expect(decideWebAnswer('https://example.org/a', []).kind).toBe('source-unavailable');
});
it('differentSuccessfulPageCannotSubstituteForRequestedBlockedUrl', () => {
  const r = new SourceRegistry('turn');
  const blocked = r.registerSource('turn', source('https://example.org/a', 'blocked'));
  const other = r.registerSource('turn', source('https://example.org/b'));
  expect(decideWebAnswer('https://example.org/a', [blocked, other]).kind).toBe('source-unavailable');
});
it('redirectNeedsRegistryBindingAndValidIdDoesNotProveSemanticTruth', () => {
  const r = new SourceRegistry('turn'); const actual = r.registerSource('turn', source('https://example.org/final'), 'https://example.org/start');
  expect(decideWebAnswer('https://example.org/start', [actual]).kind).toBe('source-unavailable');
  expect(decideWebAnswer('https://example.org/start', [actual], r).kind).toBe('generate');
  expect(r.validateSourceIds('turn', [actual.id]).ok).toBe(true); // identity only, no claim-level truth check
});
it('registryStoresImmutableSnapshotAndCanReleaseTurn', () => {
  const r = new SourceRegistry('turn'); const input = source('https://example.org/a');
  const item = r.registerSource('turn', input); input.chunks[0]!.text = 'mutated'; item.chunks[0]!.text = 'also mutated';
  expect(r.list()[0]?.chunks[0]?.text).toBe('Actual evidence');
  r.clear(); expect(r.validateSourceIds('turn', [item.id]).ok).toBe(false);
});
it('latestBlockedReadDoesNotReuseOldSuccessForSameRequest', () => {
  const r = new SourceRegistry('turn');
  const old = r.registerSource('turn', source('https://example.org/a'));
  const blocked = r.registerSource('turn', source('https://example.org/a', 'blocked'));
  expect(decideWebAnswer('https://example.org/a', [old, blocked], r).kind).toBe('source-unavailable');
});
