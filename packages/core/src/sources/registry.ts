import { randomUUID } from 'node:crypto';
import { sourceRecordSchema, type SourceRecord, type OperationResult } from '../contracts.js';

/** One instance per turn. IDs establish identity only, never factual truth. */
export class SourceRegistry {
  private readonly records = new Map<string, SourceRecord>();
  private readonly requests = new Map<string, Set<string>>();
  constructor(readonly turnId: string) { if (!turnId) throw new Error('Нужен ID текущего хода.'); }
  registerSource(turnId: string, record: Omit<SourceRecord, 'id'|'turnId'>, requestedUri?: string): SourceRecord {
    if (turnId !== this.turnId || this.records.size >= 64) throw new Error('Источник не относится к текущему ходу или превышен лимит.');
    const parsed = sourceRecordSchema.parse({ ...record, id: `source-${randomUUID()}`, turnId });
    this.records.set(parsed.id, structuredClone(parsed));
    for (const uri of [parsed.uri, requestedUri].filter((uri): uri is string => Boolean(uri))) {
      const ids = this.requests.get(uri) ?? new Set(); ids.add(parsed.id); this.requests.set(uri, ids);
    }
    return structuredClone(parsed);
  }
  validateSourceIds(turnId: string, ids: string[]): OperationResult<void> {
    if (turnId !== this.turnId || ids.some(id => !this.records.has(id))) return { ok: false, code: 'UNKNOWN_SOURCE', message: 'Ссылка на источник отсутствует в текущем ходе.', retryable: false };
    return { ok: true, value: undefined, warnings: [] };
  }
  /** Publish an already measured batch atomically, preserving its actual source/chunk IDs. */
  registerSources(turnId:string,records:SourceRecord[]):SourceRecord[]{
    const parsed=sourceRecordSchema.array().max(64).parse(records);
    if(turnId!==this.turnId||this.records.size+parsed.length>64||new Set(parsed.map(r=>r.id)).size!==parsed.length||parsed.some(r=>r.turnId!==turnId||this.records.has(r.id)))throw new Error('Пакет источников не относится к текущему ходу или повторяет ID.');
    for(const record of parsed){this.records.set(record.id,structuredClone(record));const ids=this.requests.get(record.uri)??new Set<string>();ids.add(record.id);this.requests.set(record.uri,ids);}
    return structuredClone(parsed);
  }
  matchesRequest(uri: string, id: string): boolean { return this.requests.get(uri)?.has(id) ?? false; }
  latestSourceId(uri: string): string | undefined { return [...(this.requests.get(uri) ?? [])].at(-1); }
  list(): SourceRecord[] { return structuredClone([...this.records.values()]); }
  clear() { this.records.clear(); this.requests.clear(); }
}
