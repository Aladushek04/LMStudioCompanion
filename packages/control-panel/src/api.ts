import type { CapabilityReport, IntegrationMode, OperationResult } from '../../core/src/contracts.js';

export interface Snapshot { report: CapabilityReport | null; checking: boolean; integration: OperationResult<IntegrationMode> | null }
export function getSessionToken(): string | null {
  const params = new URLSearchParams(location.hash.slice(1)); const token = params.get('token');
  if (token) { sessionStorage.setItem('companion-token', token); history.replaceState(null, '', location.pathname); }
  return sessionStorage.getItem('companion-token');
}
export async function request<T>(token: string, path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? 'Панель потеряла связь с локальным сервисом.');
  }
  return await response.json() as T;
}
