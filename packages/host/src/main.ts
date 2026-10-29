import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startManagementServer } from './server.js';

const controller = new AbortController(); const stop = () => controller.abort();
for (const event of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.once(event, stop);
try {
  const host = await startManagementServer(fileURLToPath(new URL('../../../data/host/', import.meta.url)), controller.signal, { port: 17837 });
  console.log(`Панель Companion: ${host.origin}\nОстановка — Ctrl+C. Настройки LM Studio не изменяются.`);
  if (process.argv.includes('--open')) {
    try {
      await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:COMPANION_PANEL_URL'], {
        env: { ...process.env, COMPANION_PANEL_URL: `${host.origin}/#token=${host.token}` }, windowsHide: true, timeout: 10000,
      });
    } catch { console.error('Не удалось открыть браузер. Проверьте браузер по умолчанию и повторите запуск панели.'); }
  }
  if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  await host.close();
} catch (error) { console.error(error instanceof Error ? error.message : 'Не удалось запустить панель.'); process.exitCode = 1; }
finally { for (const event of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.removeListener(event, stop); }
