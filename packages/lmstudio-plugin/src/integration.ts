import { capabilityReportSchema, type CapabilityReport, type IntegrationMode, type OperationResult } from '../../core/src/contracts.js';

/** Только решение по доказательствам. Эта функция не регистрирует и не переключает обработчики. */
export function selectIntegration(report: CapabilityReport, currentHandler: string | null): OperationResult<IntegrationMode> {
  const parsed = capabilityReportSchema.safeParse(report);
  const fail = (code: string, message: string, retryable = false): OperationResult<IntegrationMode> => ({ ok: false, code, message, retryable });
  if (!parsed.success) return fail('INVALID_REPORT', 'Отчёт о возможностях не соответствует контракту.');
  const verified = (name: string) => parsed.data.features[name]?.state === 'verified';
  if (!verified('connection')) return fail('API_UNAVAILABLE', 'Доступ к локальному API не подтверждён. Проверьте сервер LM Studio и повторите диагностику.', true);
  if (parsed.data.features.singlePredictionOwner?.state === 'unsupported') return fail('OWNER_CONFLICT', 'Обнаружен конфликт владельцев генерации.');
  const candidate = verified('predictionOwnerExtend') ? 'extend' : verified('predictionOwnerReplace') ? 'replace' : null;
  if (candidate === null) return { ok: true, value: 'tools-only', warnings: ['Выбран консервативный режим независимых инструментов. Это не проверка работы инструментов конкретного чата. Автоматический контроль ответа, строгие документы и Thinking не включены.'] };
  for (const feature of ['singlePredictionOwner', 'compressorCompatible', 'preservesAttachments', 'preservesToolContinuation', 'cancellation']) {
    if (!verified(feature)) return fail('INTEGRATION_UNVERIFIED', 'Режим управления ответом не подтверждён: ' + feature + '.');
  }
  if (candidate === 'replace' && currentHandler !== null && !verified('replacementAuthorized')) {
    return fail('REPLACEMENT_NOT_AUTHORIZED', 'Для замены действующего обработчика требуется явное переключение с сохранением прежнего выбора.');
  }
  return { ok: true, value: candidate, warnings: [] };
}
