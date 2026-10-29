import { z } from 'zod';
import { turnBudgetSchema, turnContextSchema, type CapabilityReport, type OperationResult, type SourceRecord, type TurnBudget, type TurnContext } from '../../../core/src/contracts.js';
import { SourceRegistry } from '../../../core/src/sources/registry.js';
import { normalizeWebUrl, type WebPlan } from '../../../core/src/web/intent.js';
import { TurnRepair } from '../tools/repair.js';

export interface WebAdapter {
  report: CapabilityReport;
  call(name: 'web_search'|'read_page'|'inspect_image', args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
const resultSchema = z.object({
  schema_version: z.literal(2), status: z.enum(['ok', 'partial', 'blocked', 'empty', 'timeout', 'error']),
  requested_url: z.string().max(4096), final_url: z.string().max(4096).nullable(), title: z.string().max(1000).default(''),
  source_kind: z.enum(['web_text', 'web_visual']).optional(), kind: z.string().max(80).optional(),
  retrieved_at: z.string().datetime({ offset: true }), content_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  chunks: z.array(z.object({ id: z.string().max(200), text: z.string().max(12000), locator: z.string().max(500) })).max(128),
  warnings: z.array(z.string().max(1000)).max(30).default([]), interpretation: z.string().max(10000).nullable().optional(), pixels_sent: z.boolean().optional(),
}).passthrough();
const failure = (code: string, message: string): OperationResult<never> => ({ ok: false, code, message, retryable: false });

/** Headless runner. Not registered in LM Studio until the native adapter is verified.
 * One WebTurn per user turn shares counters/registry across all plans in that turn.
 */
export class WebTurn {
  readonly registry: SourceRegistry;
  readonly repair: TurnRepair;
  private queries = 0; private pages = 0; private chars = 0;
  private readonly expiresAt: number;
  constructor(readonly ctx: TurnContext, readonly budget: TurnBudget, private readonly adapter?: WebAdapter) {
    turnContextSchema.parse(ctx); turnBudgetSchema.parse(budget);
    this.registry = new SourceRegistry(ctx.turnId); this.expiresAt = Date.now() + budget.deadlineMs;
    this.repair = new TurnRepair(budget.maxRepairs);
  }
  async run(plan: WebPlan): Promise<OperationResult<SourceRecord[]>> {
    if (plan.kind === 'none') return { ok: true, value: [], warnings: [] };
    if (!this.adapter || this.adapter.report.features.toolsSession?.state !== 'verified') return failure('UNSUPPORTED', 'Подключение автоматического веб-чтения к текущему чату ещё не подтверждено.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Math.max(0, this.expiresAt - Date.now()));
    const signal = AbortSignal.any([this.ctx.signal, controller.signal]); const warnings: string[] = []; const collected: SourceRecord[] = [];
    const invoke = async (name: Parameters<WebAdapter['call']>[0], args: Record<string, unknown>) => {
      signal.throwIfAborted();
      if (Date.now() >= this.expiresAt) { controller.abort(); signal.throwIfAborted(); }
      let stop!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('Aborted')); signal.addEventListener('abort', stop, { once: true }); });
      try { const value = await Promise.race([this.adapter!.call(name, args, signal), cancelled]); signal.throwIfAborted(); return value; }
      finally { signal.removeEventListener('abort', stop); }
    };
    try {
      let urls = plan.urls;
      if (plan.kind === 'search') {
        if (this.queries >= Math.min(this.budget.maxQueries, 10)) return { ok: true, value: [], warnings: ['Лимит поисковых запросов исчерпан.'] };
        this.queries++;
        if (!plan.query?.trim() || plan.query.length > 500) return failure('INVALID_PLAN', 'Поисковый запрос пустой или слишком длинный.');
        const search = z.object({ results: z.array(z.object({ url: z.string().max(4096) }).passthrough()).max(10), warnings: z.array(z.string().max(1000)).max(30).default([]) }).passthrough().parse(await invoke('web_search', { query: plan.query, limit: Math.min(10, this.budget.maxPages) || 1 }));
        warnings.push(...search.warnings); urls = search.results.map(item => item.url);
      }
      const unique = [...new Set(urls.map(normalizeWebUrl).filter((url): url is string => url !== null))];
      for (const url of unique) {
        signal.throwIfAborted();
        if (this.pages >= Math.min(this.budget.maxPages, 12) || this.chars >= 24000) { warnings.push('Достигнут лимит страниц или объёма источников; часть материалов пропущена.'); break; }
        this.pages++;
        const visual = plan.kind === 'inspect-image';
        let payload: unknown;
        try { payload = await invoke(visual ? 'inspect_image' : 'read_page', visual ? { url, question: plan.query ?? 'Что изображено?' } : { url, max_chars: 6000 }); }
        catch (error) {
          if (signal.aborted) throw error;
          collected.push(this.registry.registerSource(this.ctx.turnId, { uri: url, title: '', kind: visual ? 'web_visual' : 'web_text', status: 'error', retrievedAt: new Date().toISOString(), contentHash: null, chunks: [] }, url)); warnings.push('Один из источников получить не удалось.'); continue;
        }
        const decoded = resultSchema.safeParse(payload);
        if (!decoded.success) return failure('INVALID_TOOL_RESULT', 'Инструмент вернул неподтверждённый формат источника.');
        const value = decoded.data; const finalUrl = value.final_url ? normalizeWebUrl(value.final_url) : url;
        if (!finalUrl || normalizeWebUrl(value.requested_url) !== url) return failure('INVALID_TOOL_RESULT', 'Результат инструмента относится к другому запросу.');
        const kind = value.source_kind ?? (['web_visual', 'web_image', 'page_screenshot'].includes(value.kind ?? '') ? 'web_visual' : 'web_text');
        let status = value.status;
        let chunks = ['ok', 'partial'].includes(status) ? value.chunks.map(c => ({ id: c.id, text: c.text, locator: c.locator })) : [];
        if (kind === 'web_visual' && value.pixels_sent && value.interpretation?.trim() && ['ok', 'partial'].includes(status)) chunks = [{ id: 'visual-interpretation', text: `Интерпретация изображения моделью, не точная цитата: ${value.interpretation}`, locator: 'visual-interpretation' }];
        if (['ok', 'partial'].includes(status) && !chunks.some(c => c.text.trim())) return failure('INVALID_TOOL_RESULT', 'Успешный результат не содержит доступных данных.');
        const bounded: typeof chunks = [];
        for (const chunk of chunks) {
          const remaining = 24000 - this.chars; if (remaining <= 0) { status = 'partial'; break; }
          const text = chunk.text.slice(0, remaining); this.chars += text.length;
          if (text.length !== chunk.text.length) { status = 'partial'; warnings.push('Источник сокращён по лимиту объёма; полный охват не подтверждён.'); }
          if (text) bounded.push({ ...chunk, text });
        }
        warnings.push(...value.warnings);
        collected.push(this.registry.registerSource(this.ctx.turnId, { uri: finalUrl, title: value.title, kind, status, retrievedAt: new Date(value.retrieved_at).toISOString(), contentHash: value.content_hash, chunks: bounded }, url));
      }
      return { ok: true, value: collected, warnings };
    } catch (error) {
      if (signal.aborted) return failure(this.ctx.signal.aborted ? 'CANCELLED' : 'TIMEOUT', this.ctx.signal.aborted ? 'Веб-проверка отменена.' : 'Истекло время веб-проверки.');
      return failure(error instanceof z.ZodError ? 'INVALID_TOOL_RESULT' : 'TOOL_FAILED', 'Веб-проверка не завершена; содержимое не объявлено прочитанным.');
    } finally { clearTimeout(timeout); }
  }
}
export async function runWebPlan(plan: WebPlan, ctx: TurnContext, budget: TurnBudget, adapter?: WebAdapter) {
  return new WebTurn(ctx, budget, adapter).run(plan);
}
