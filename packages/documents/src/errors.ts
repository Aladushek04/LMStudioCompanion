import type {DocumentFailureCode} from './types.js';

const messages:Record<DocumentFailureCode,string>={
 INVALID_INPUT:'Передайте явно выбранные файлы: имя без пути и байты TXT/PDF.',
 LIMIT_EXCEEDED:'Превышен допустимый размер или количество выбранных файлов.',
 EMPTY_FILE:'Файл пуст; текст не прочитан.',INVALID_ENCODING:'TXT должен быть в UTF-8. Пересохраните файл в этой кодировке.',
 BINARY_TEXT:'Вместо обычного TXT обнаружены бинарные данные.',UNSUPPORTED_FORMAT:'Поддерживаются только TXT и текстовый PDF.',
 INVALID_PDF:'Содержимое выбранного файла не похоже на PDF.',NO_TEXT:'Извлечённого текста нет. Возможно, это скан; OCR не выполнялся.',
 TEXT_LIMIT:'Извлечённый текст превышает допустимый объём; он не обрезан и не объявлен готовым.',
 INVALID_RESULT:'Парсер вернул неподдерживаемый результат; текст не принят.',UNSUPPORTED_PARSER:'Этот парсер или его версия ещё не проверены; другой backend не загружался.',
 INVALID_HANDLE:'Не удалось подтвердить временный файл, подготовленный для этого документа.',
 API_UNAVAILABLE:'Файловый API LM Studio недоступен или не поддерживается. Проверьте запуск и совместимость версии.',
 PARSER_ERROR:'Не удалось прочитать документ. PDF может быть повреждён или защищён паролем.',
 CANCELLED:'Чтение документов отменено.',TIMEOUT:'Время чтения документов истекло; готовность текста не подтверждена.',
 STALE:'Выбор документов изменился. Получите актуальную копию и повторите чтение.',
 BUSY:'Предыдущее чтение ещё не завершилось. Дождитесь завершения или закройте его отдельное подключение.',
};
export class DocumentFailure extends Error {
 readonly retryable:boolean;
 constructor(readonly code:DocumentFailureCode){super(messages[code]);this.name='DocumentFailure';this.retryable=['API_UNAVAILABLE','TIMEOUT','BUSY','CANCELLED','STALE'].includes(code);}
}
export function abortFailure(signal:AbortSignal):DocumentFailure{
 const code=signal.reason instanceof DocumentFailure?signal.reason.code:'CANCELLED';
 return new DocumentFailure(code==='TIMEOUT'?'TIMEOUT':code==='STALE'?'STALE':'CANCELLED');
}
export function asDocumentFailure(error:unknown,signal?:AbortSignal):DocumentFailure{
 if(signal?.aborted)return abortFailure(signal);
 return error instanceof DocumentFailure?error:new DocumentFailure('PARSER_ERROR');
}
