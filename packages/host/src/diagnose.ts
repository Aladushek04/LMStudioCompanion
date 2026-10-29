import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { probeCapabilities, type ProbeOptions } from './capabilities.js';
import { selectIntegration } from '../../lmstudio-plugin/src/integration.js';

interface DiagnosticOptions extends ProbeOptions { outputPath?: string }

/** Отмена действует до начала атомарного rename; начатая фиксация завершается. */
export async function runDiagnostics(signal: AbortSignal, options: DiagnosticOptions = {}) {
  const report = await probeCapabilities(signal, options);
  const integration = selectIntegration(report, null);
  const outputPath = resolve(options.outputPath ?? fileURLToPath(new URL('../../../data/diagnostics/capabilities.json', import.meta.url)));
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  signal.throwIfAborted();
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, outputPath);
  } finally { await rm(temporary, { force: true }); }
  return { report, integration, outputPath };
}

export function parseArguments(argv: string[]): DiagnosticOptions & { help: boolean } {
  const options: DiagnosticOptions & { help: boolean } = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help') { options.help = true; continue; }
    if (!['--url', '--output', '--timeout-ms'].includes(flag ?? '')) throw new Error('Неизвестный параметр. Используйте --help.');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('У параметра отсутствует значение.');
    if (flag === '--url') options.baseUrl = value;
    if (flag === '--output') options.outputPath = value;
    if (flag === '--timeout-ms') {
      const timeout = Number(value);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Таймаут должен быть от 1 до 30000 мс.');
      options.timeoutMs = timeout;
    }
  }
  return options;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Диагностика LM Studio Companion (только чтение)\n--url http://127.0.0.1:1234\n--output <путь JSON-отчёта>\n--timeout-ms <1..30000>\nОтмена: Ctrl+C. Модели и настройки не меняются.');
      return;
    }
    const { report, integration, outputPath } = await runDiagnostics(controller.signal, options);
    console.log(`LM Studio Companion — диагностика\nВерсия LM Studio: ${report.lmStudioVersion}`);
    const labels: Record<string, string> = {
      connection: 'Доступ к API', sdkSurface: 'Декларации SDK', installedCompressor: 'Установка context-compressor',
      predictionOwnerExtend: 'Расширение текущего обработчика', predictionOwnerReplace: 'Замена обработчика',
      compressorCompatible: 'Совместимость с компрессией', toolsSession: 'Сеанс инструментов адаптера',
      cancellation: 'Отмена в новом адаптере', stableChatScopeId: 'Постоянный ID чата',
      persistentFileHandle: 'Постоянная библиотека файлов', thinking: 'Управление Thinking',
    };
    for (const [key, label] of Object.entries(labels)) {
      const state = report.features[key]?.state;
      console.log(`${label}: ${state === 'verified' ? 'подтверждено' : state === 'unsupported' ? 'не поддерживается' : 'не проверено'}`);
    }
    console.log(integration.ok
      ? `Режим по отчёту: ${integration.value === 'tools-only' ? 'независимые инструменты; контроль ответа не включён' : integration.value}. Это решение по отчёту; настройки не применялись.`
      : integration.message);
    console.log(`Отчёт: ${outputPath}`);
    if (!integration.ok) process.exitCode = 1;
  } catch (error) {
    console.error(controller.signal.aborted ? 'Диагностика отменена. Предыдущий итоговый отчёт сохранён.'
      : error instanceof Error && error.name !== 'TypeError' ? error.message : 'Не удалось выполнить диагностику.');
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
