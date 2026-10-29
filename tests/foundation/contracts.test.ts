import { describe, expect, it } from 'vitest';
import { capabilityReportSchema, operationResultSchema, sourceRecordSchema, turnBudgetSchema, turnContextSchema, uiNoticeSchema } from '../../packages/core/src/contracts.js';
import { z } from 'zod';

describe('границы общих контрактов', () => {
  it('rejectsUnverifiedCapabilityVocabulary', () => {
    expect(capabilityReportSchema.safeParse({ lmStudioVersion: '0.4.26', checkedAt: '2026-10-29T10:00:00.000Z', features: { thinking: { state: 'supported', evidence: 'метод существует' } } }).success).toBe(false);
  });
  it('preservesRetryabilityAndWarnings', () => {
    const schema = operationResultSchema(z.number());
    expect(schema.parse({ ok: false, code: 'OFFLINE', message: 'API недоступен', retryable: true })).toEqual({ ok: false, code: 'OFFLINE', message: 'API недоступен', retryable: true });
    expect(schema.safeParse({ ok: true, value: 3 }).success).toBe(false);
    expect(schema.parse({ ok: true, value: 3, warnings: [] })).toEqual({ ok: true, value: 3, warnings: [] });
  });
  it('requiresOperationIdentityOnUiNotices', () => {
    expect(uiNoticeSchema.safeParse({ level: 'warning', message: 'Материалы сокращены' }).success).toBe(false);
  });
  it('rejectsInvalidOperationalLimits', () => {
    for (const budget of [
      { maxQueries: -1, maxPages: 5, maxRepairs: 1, deadlineMs: 120000 },
      { maxQueries: 3, maxPages: 5, maxRepairs: 2, deadlineMs: 120000 },
      { maxQueries: 3, maxPages: 5, maxRepairs: 1, deadlineMs: 0 },
    ]) expect(turnBudgetSchema.safeParse(budget).success).toBe(false);
  });
  it('retainsSourceKindTimeoutAndChunkLocators', () => {
    const source = { id: 'source-1', turnId: 'turn-1', uri: 'https://example.com/', title: 'Источник', kind: 'web_text', status: 'timeout', retrievedAt: '2026-10-29T10:00:00.000Z', contentHash: null, chunks: [{ id: 'chunk-1', text: 'Часть текста', locator: 'фрагмент 1' }] };
    expect(sourceRecordSchema.parse(source)).toEqual(source);
    expect(sourceRecordSchema.safeParse({ ...source, chunks: [{ text: 'Текст', locator: '1' }] }).success).toBe(false);
  });
  it('unknownChatDisablesScopedInjection', () => {
    const ctx = { turnId: 't1', chatScopeId: null, projectId: null, sessionId: null, mode: 'auto', signal: new AbortController().signal };
    expect(turnContextSchema.safeParse(ctx).success).toBe(true);
    expect(turnContextSchema.safeParse({ ...ctx, projectId: 'project-1' }).success).toBe(false);
    expect(turnContextSchema.safeParse({ ...ctx, sessionId: 'session-1' }).success).toBe(false);
  });
});
