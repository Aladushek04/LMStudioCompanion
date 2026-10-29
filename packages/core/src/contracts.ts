import { z } from 'zod';

/** Канонические контракты DESIGN.md; схемы проверяют внешние данные во время выполнения. */
const nonempty = z.string().min(1);
export const capabilityStateSchema = z.enum(['verified', 'unsupported', 'unknown']);
export const capabilityReportSchema = z.object({
  lmStudioVersion: nonempty,
  checkedAt: z.string().datetime(),
  features: z.record(z.object({ state: capabilityStateSchema, evidence: nonempty }).strict()),
}).strict();
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const uiNoticeSchema = z.object({
  level: z.enum(['info', 'warning', 'error']), message: nonempty, operationId: nonempty,
}).strict();
export type UiNotice = z.infer<typeof uiNoticeSchema>;

export function operationResultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value, warnings: z.array(z.string()) }).strict(),
    z.object({ ok: z.literal(false), code: nonempty, message: nonempty, retryable: z.boolean() }).strict(),
  ]);
}
export type OperationResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; code: string; message: string; retryable: boolean };

export const turnBudgetSchema = z.object({
  maxQueries: z.number().int().nonnegative(), maxPages: z.number().int().nonnegative(),
  maxRepairs: z.number().int().min(0).max(1), deadlineMs: z.number().int().positive(),
}).strict();
export type TurnBudget = z.infer<typeof turnBudgetSchema>;

export const sourceRecordSchema = z.object({
  id: nonempty, turnId: nonempty, uri: nonempty, title: z.string(),
  kind: z.enum(['web_text', 'web_visual', 'document']),
  status: z.enum(['ok', 'partial', 'blocked', 'empty', 'timeout', 'error']),
  retrievedAt: z.string().datetime(), contentHash: nonempty.nullable(),
  chunks: z.array(z.object({ id: nonempty, text: z.string(), locator: nonempty }).strict()),
}).strict();
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const turnContextSchema = z.object({
  turnId: nonempty, chatScopeId: nonempty.nullable(), sessionId: nonempty.nullable(), projectId: nonempty.nullable(),
  mode: z.enum(['fast', 'auto', 'deep']), signal: z.instanceof(AbortSignal),
}).strict().superRefine((ctx, refine) => {
  if (ctx.chatScopeId === null && (ctx.projectId !== null || ctx.sessionId !== null)) {
    refine.addIssue({ code: z.ZodIssueCode.custom, message: 'Без подтверждённого ID чата проектная и временная области недоступны.' });
  }
});
export type TurnContext = z.infer<typeof turnContextSchema>;
export type IntegrationMode = 'extend' | 'replace' | 'tools-only';
