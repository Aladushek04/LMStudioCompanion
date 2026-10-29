import { randomUUID } from 'node:crypto';
import type { OperationResult } from '../../core/src/contracts.js';

interface Binding { chatScopeId: string; projectId: string | null; sessionId: string }
/** RAM-области текущего запуска; подключать только при verified стабильном chatScopeId. */
export class ChatScopeStore {
  private readonly bindings = new Map<string, Binding>();
  bindChatScope(chatScopeId: string, projectId: string | null): OperationResult<Binding> {
    if (!chatScopeId.trim() || (projectId !== null && !projectId.trim())) return { ok: false, code: 'INVALID_SCOPE', message: 'Не указан идентификатор области.', retryable: false };
    const existing = this.bindings.get(chatScopeId);
    if (existing && existing.projectId !== projectId) return { ok: false, code: 'CHAT_ALREADY_BOUND', message: 'Для смены проекта начните новый чат.', retryable: false };
    const binding = existing ?? { chatScopeId, projectId, sessionId: randomUUID() };
    this.bindings.set(chatScopeId, binding); return { ok: true, value: { ...binding }, warnings: [] };
  }
  getBinding(chatScopeId: string): Binding | null { const value = this.bindings.get(chatScopeId); return value ? { ...value } : null; }
}
