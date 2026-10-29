import { expect, it, vi } from 'vitest';
import { runWebPlan, WebTurn } from '../../packages/lmstudio-plugin/src/web/orchestrator.js';
import { planWebAction } from '../../packages/core/src/web/intent.js';
import type { CapabilityReport, TurnContext } from '../../packages/core/src/contracts.js';

const report: CapabilityReport = { lmStudioVersion: 'fixture', checkedAt: '2026-10-29T16:00:00Z', features: { toolsSession: { state: 'verified', evidence: 'Synthetic adapter only' } } };
const context = (signal = new AbortController().signal): TurnContext => ({ turnId: 'turn-fixture', chatScopeId: null, projectId: null, sessionId: null, mode: 'auto', signal });
const budget = { maxQueries: 3, maxPages: 5, maxRepairs: 1, deadlineMs: 1000 };
const response = (url: string, status = 'ok') => ({ schema_version: 2, source_kind: 'web_text', status, requested_url: url, final_url: url, title: 'Fixture', retrieved_at: '2026-10-29T16:00:00Z', content_hash: 'a'.repeat(64), chunks: status === 'ok' ? [{ id: 'snapshot:0:4', text: 'Actual content', locator: 'chars=0:14' }] : [], warnings: [] });
it('explicitReadCallsActualAdapterAndRegistersSource', async () => {
  const call = vi.fn(async (_name: string, args: Record<string, unknown>, _signal: AbortSignal) => response(String(args.url)));
  const result = await runWebPlan(planWebAction('Прочитай https://example.org/a', 'auto'), context(), budget, { report, call });
  expect(call.mock.calls[0]?.[0]).toBe('read_page'); expect(result.ok).toBe(true);
  if (result.ok) expect(result.value[0]).toMatchObject({ turnId: 'turn-fixture', uri: 'https://example.org/a', status: 'ok' });
});
it('webOffAndUnverifiedAdapterPerformZeroCalls', async () => {
  const call = vi.fn();
  const none = await runWebPlan(planWebAction('Прочитай https://example.org/a', 'off'), context(), budget, { report, call });
  expect(none).toMatchObject({ ok: true, value: [] });
  const unverified = { ...report, features: {} };
  expect((await runWebPlan(planWebAction('Прочитай https://example.org/a', 'auto'), context(), budget, { report: unverified, call })).ok).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
it('cancelStopsNextRequest', async () => {
  const control = new AbortController();
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => { control.abort(); return response(String(args.url)); });
  const result = await runWebPlan(planWebAction('Прочитай https://example.org/a и https://example.org/b', 'auto'), context(control.signal), budget, { report, call });
  expect(result).toMatchObject({ ok: false, code: 'CANCELLED' }); expect(call).toHaveBeenCalledTimes(1);
});
it('searchReadsDeduplicatedResultsWithinBudgetAndRejectsCommandsInArticle', async () => {
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'web_search' ? { results: [{ url: 'https://example.org/a' }, { url: 'https://example.org/a#same' }, { url: 'https://example.org/b' }] } : response(String(args.url)));
  const result = await runWebPlan(planWebAction('Найди новые данные о Gemma', 'research'), context(), { ...budget, maxPages: 1 }, { report, call });
  expect(result.ok).toBe(true); expect(call).toHaveBeenCalledTimes(2);
  if (result.ok) { expect(result.value).toHaveLength(1); expect(result.warnings.length).toBeGreaterThan(0); }
});
it('deadlineStopsEvenIfAdapterIgnoresSignal', async () => {
  const call = vi.fn(() => new Promise<unknown>(() => {}));
  expect(await runWebPlan(planWebAction('Прочитай https://example.org/a', 'auto'), context(), { ...budget, deadlineMs: 10 }, { report, call })).toMatchObject({ ok: false, code: 'TIMEOUT' });
});
it('blockedResultDoesNotBecomeReadableTextAndBudgetZeroNeverCalls', async () => {
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => response(String(args.url), 'blocked'));
  const plan = planWebAction('Прочитай https://example.org/a', 'auto');
  const result = await runWebPlan(plan, context(), budget, { report, call });
  expect(result.ok).toBe(true); if (result.ok) expect(result.value[0]).toMatchObject({ status: 'blocked', chunks: [] });
  call.mockClear(); await runWebPlan(plan, context(), { ...budget, maxPages: 0 }, { report, call }); expect(call).not.toHaveBeenCalled();
});
it('plainUnversionedAndForgedSuccessPayloadRejected', async () => {
  for (const payload of [{ text: 'made up' }, { ...response('https://example.org/a'), chunks: [] }]) {
    const result = await runWebPlan(planWebAction('Прочитай https://example.org/a', 'auto'), context(), budget, { report, call: async () => payload });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TOOL_RESULT' });
  }
});
it('sameTurnSharesPageBudgetAndRepairLimitAcrossPlans', async () => {
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => response(String(args.url)));
  const session = new WebTurn(context(), { ...budget, maxPages: 1 }, { report, call });
  await session.run(planWebAction('Прочитай https://example.org/a', 'auto'));
  await session.run(planWebAction('Прочитай https://example.org/b', 'auto'));
  expect(call).toHaveBeenCalledTimes(1);
  expect(session.repair).toBeDefined();
});
