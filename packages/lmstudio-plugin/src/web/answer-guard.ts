import type { SourceRecord } from '../../../core/src/contracts.js';
import type { SourceRegistry } from '../../../core/src/sources/registry.js';
import { normalizeWebUrl } from '../../../core/src/web/intent.js';

export function decideWebAnswer(requestedUrl: string|null, sources: SourceRecord[], registry?: SourceRegistry): { kind: 'generate'|'source-unavailable'; message: string|null } {
  const requested = requestedUrl ? normalizeWebUrl(requestedUrl) : null;
  let relevant = requestedUrl === null ? sources : sources.filter(s => requested !== null && (normalizeWebUrl(s.uri) === requested || registry?.matchesRequest(requested, s.id)));
  if (requested !== null) { const latest = registry?.latestSourceId(requested); relevant = latest ? relevant.filter(s => s.id === latest) : relevant.slice(-1); }
  if (relevant.some(s => ['ok', 'partial'].includes(s.status) && s.chunks.some(c => c.text.trim()))) return { kind: 'generate', message: null };
  const blocked = relevant.some(s => s.status === 'blocked');
  return { kind: 'source-unavailable', message: `${blocked ? 'Источник заблокировал доступ.' : 'Получить содержимое источника не удалось.'}${requested ? ` ${requested}` : ''} Содержимое не прочитано; пересказ по адресу не выполняется.` };
}
