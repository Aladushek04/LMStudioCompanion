import { z } from 'zod';
import { capabilityReportSchema, type CapabilityReport } from '../../core/src/contracts.js';
import { inspectInstallation, type InstallationFacts } from './installation.js';
export type { InstallationFacts } from './installation.js';

export interface ProbeOptions {
  baseUrl?: string;
  timeoutMs?: number;
  installation?: InstallationFacts;
}
const apiModelsSchema = z.object({ models: z.array(z.object({
  key: z.string().min(1), type: z.enum(['llm', 'embedding']),
  loaded_instances: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
}).passthrough()) });

function localBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Нужен локальный HTTP(S)-адрес LM Studio без учётных данных, параметров и дополнительного пути.');
  }
  return url.origin;
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new Error('RESPONSE_LIMIT');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Ни регистрации плагина, ни вызовов генерации/загрузки: один GET /api/v1/models. */
export async function probeCapabilities(signal: AbortSignal, options: ProbeOptions = {}): Promise<CapabilityReport> {
  signal.throwIfAborted();
  const baseUrl = localBaseUrl(options.baseUrl ?? 'http://127.0.0.1:1234');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Таймаут диагностики должен быть от 1 до 30000 мс.');
  const installation = options.installation ?? await inspectInstallation(signal);
  const features: CapabilityReport['features'] = {};
  const record = (name: string, state: 'verified' | 'unknown', evidence: string) => { features[name] = { state, evidence }; };
  const declarationsVerified = installation.sdkVersion !== null && installation.sdkMethods.length > 0;
  record('sdkSurface', declarationsVerified ? 'verified' : 'unknown', declarationsVerified
    ? `Прочитаны декларации SDK ${installation.sdkVersion}; обнаружены: ${installation.sdkMethods.join(', ') || 'нет известных методов'}. Это проверка деклараций, не интеграции.`
    : 'Чтение известных методов SDK не подтверждено; одной версии в package.json недостаточно.');
  record('installedCompressor', installation.compressorVersion ? 'verified' : 'unknown', installation.compressorVersion
    ? `Установлен context-compressor ${installation.compressorVersion}, revision ${installation.compressorRevision ?? 'unknown'}; регистрация prediction loop в исходнике: ${installation.compressorOwnsPredictionLoop ? 'есть' : 'не подтверждена'}. Активность в текущем чате не проверялась.`
    : 'Метаданные context-compressor в известной установке не подтверждены.');
  record('predictionOwnerExtend', 'unknown', 'Публичная совместимая точка расширения действующего обработчика не доказана. Наличие withPredictionLoopHandler не доказывает композицию.');
  record('predictionOwnerReplace', 'unknown', 'SDK объявляет регистрацию обработчика; отдельный режим с сохранением компрессии, инструментов и вложений не проверен.');
  record('singlePredictionOwner', 'unknown', 'Включённые обработчики конкретного чата не определяются списком моделей. Новый обработчик не регистрировался.');
  record('compressorCompatible', 'unknown', 'Совместное выполнение, сохранность вложений и продолжение tool-turn не проверялись в тестовом чате.');
  record('preservesAttachments', 'unknown', 'Наличие FileHandle не подтверждает сохранность вложений в новой интеграции.');
  record('preservesToolContinuation', 'unknown', 'Продолжение tool-turn новым адаптером не проверялось.');
  record('toolsSession', 'unknown', installation.sdkMethods.includes('startToolUseSession')
    ? 'В декларациях найден startToolUseSession. В исследованном SDK 1.5.0 он deprecated/WIP; реальный сеанс инструментов не создавался.'
    : 'startToolUseSession не обнаружен в прочитанных декларациях. Реальный сеанс инструментов не создавался.');
  record('cancellation', 'unknown', 'Отмена собственной диагностики проверяется тестами. Отмена генерации и вложенных инструментов в новом адаптере не проверена.');
  record('customUi', 'unknown', 'Поддержанный интерфейс полноценной встроенной панели не подтверждён. Отдельная локальная панель Companion доступна через Start-Companion.cmd.');
  record('stableChatScopeId', 'unknown', 'Стабильный публичный ID чата не доказан. Проектная и временная автоподстановка недоступны.');
  record('persistentFileHandle', 'unknown', 'Обнаруженные файловые методы: ' + (installation.sdkMethods.filter(name => ['prepareFile', 'prepareFileBase64', 'parseDocument', 'retrieve'].includes(name)).join(', ') || 'не подтверждены') + '. Сохранение handles, перезапуск и удаление библиотеки не проверялись.');
  record('thinking', 'unknown', 'Отдельная проверка на конкретной модели не выполнялась. Выбор режима интеграции не подтверждает Thinking.');
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(`${baseUrl}/api/v1/models`, { method: 'GET', redirect: 'error', signal: requestSignal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      record('connection', 'unknown', `API вернул HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? 'Авторизация недоступна; секреты не читались.' : 'Список моделей не подтверждён.'}`);
    } else {
      const parsed = apiModelsSchema.parse(await readBoundedJson(response, requestSignal));
      const loaded = parsed.models.reduce((sum, model) => sum + (model.loaded_instances?.length ?? 0), 0);
      record('connection', 'verified', `GET /api/v1/models: HTTP 200, список распознан; моделей ${parsed.models.length}, загруженных экземпляров ${loaded}. Их названия и конфигурации в отчёт не включены.`);
    }
  } catch {
    signal.throwIfAborted();
    record('connection', 'unknown', 'API недоступен, ответ не распознан или превышен лимит ожидания/размера. Генерация и загрузка моделей не вызывались.');
  }
  signal.throwIfAborted();
  return capabilityReportSchema.parse({ lmStudioVersion: installation.lmStudioVersion ?? 'unknown', checkedAt: new Date().toISOString(), features });
}
