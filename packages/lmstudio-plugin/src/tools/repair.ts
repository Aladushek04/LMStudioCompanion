import { z } from 'zod';
import type { OperationResult } from '../../../core/src/contracts.js';
const failure = (): OperationResult<never> => ({ ok: false, code: 'INVALID_ARGUMENTS', message: 'Аргументы неоднозначны или не соответствуют схеме; автоматическое исправление прекращено.', retryable: false });
function removeTrailingCommas(raw: string) {
  let output = ''; let quoted = false; let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quoted) { output += ch; if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    if (ch === ',') { let next = i + 1; while (/\s/.test(raw[next] ?? '') && next < raw.length) next++; if (raw[next] === '}' || raw[next] === ']') continue; }
    output += ch;
  }
  return output;
}
function hasDuplicateKeys(raw: string) {
  const stack: Array<Set<string>|null> = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]; if (ch === '{') stack.push(new Set()); else if (ch === '[') stack.push(null); else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      const start = i++; let escape = false;
      for (; i < raw.length; i++) { const c = raw[i]; if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') break; }
      let next = i + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++;
      if (raw[next] === ':') { const key: string = JSON.parse(raw.slice(start, i + 1)); const keys = stack.at(-1); if (keys?.has(key)) return true; keys?.add(key); }
    }
  }
  return false;
}
export function repairToolArguments(raw: string, schema: unknown): OperationResult<{ args: unknown; changed: boolean }> {
  if (raw.length > 65536 || !(schema instanceof z.ZodType)) return failure();
  let candidate = raw; let changed = false; let args: unknown;
  try { args = JSON.parse(candidate); }
  catch { candidate = removeTrailingCommas(raw); changed = candidate !== raw; try { args = JSON.parse(candidate); } catch { return failure(); } }
  try { if (hasDuplicateKeys(candidate)) return failure(); const valid = schema.safeParse(args); return valid.success ? { ok: true, value: { args: valid.data, changed }, warnings: changed ? ['Удалена однозначная завершающая запятая JSON.'] : [] } : failure(); }
  catch { return failure(); }
}
export class TurnRepair {
  private used = 0;
  constructor(private readonly limit: number) { if (limit !== 0 && limit !== 1) throw new Error('Допускается не больше одного исправления на ход.'); }
  repair(raw: string, schema: unknown) {
    try { JSON.parse(raw); } catch { if (this.used >= this.limit) return failure(); this.used++; }
    return repairToolArguments(raw, schema);
  }
}
export function canRetry(toolName: string, execution: 'not-started'|'succeeded'|'failed'|'unknown'): boolean {
  return execution !== 'succeeded' && ['web_search', 'read_page', 'find_in_page', 'inspect_page', 'inspect_image'].includes(toolName);
}
