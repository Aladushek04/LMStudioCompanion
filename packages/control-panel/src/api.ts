import type { CapabilityReport, IntegrationMode, OperationResult } from '../../core/src/contracts.js';

export interface Snapshot { report: CapabilityReport | null; checking: boolean; integration: OperationResult<IntegrationMode> | null }
export function getSessionToken(): string | null {
  const params = new URLSearchParams(location.hash.slice(1)); const token = params.get('token');
  if (token) { sessionStorage.setItem('companion-token', token); history.replaceState(null, '', location.pathname); }
  return sessionStorage.getItem('companion-token');
}
export class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
export async function request<T>(token: string, path: string, method = 'GET', signal?: AbortSignal, body?:unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token,...(body===undefined?{}:{'Content-Type':'application/json'}) }, ...(signal ? { signal } : {}),...(body===undefined?{}:{body:JSON.stringify(body)}) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new ApiError(body?.message ?? 'Панель потеряла связь с локальным сервисом.',response.status);
  }
  return await response.json() as T;
}
