# D1: надёжное чтение выбранных документов — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Один D1 за заход, TDD и одно итоговое независимое ревью. Не подключать экран, чат, retrieval или новый релиз.

**Goal:** Адаптер получает снимок явно выбранного TXT/PDF и возвращает проверенный текст с идентичностью, версией и честным состоянием.

**Architecture:** Свой Node-адаптер и отдельный тонкий SDK backend. Вход — копируемые bytes + basename, не произвольный filesystem path и не сохранённый временный handle. SDK backend создаёт собственный FileHandle из этих bytes, проверяет его и builtIn/1 до разбора; не копирует rag-v1 и не загружает модели. Терминальный текст не сохраняется на диск.

**Tech Stack:** TypeScript/Zod, Node crypto, существующий @lmstudio/sdk 1.5.0, Vitest. Общие OperationResult/TurnContext сохраняются.

**Spec:** [D1](04-documents-stages.md), [решения D0](../research/documents-api-report.md), [DESIGN](../DESIGN.md).

## Контракты и ограничения

- createDocumentAdapter(backend, limits?) возвращает prepareDocuments(inputs: unknown[], ctx: TurnContext, options?): Promise<OperationResult<DocumentState[]>>. Это внутренний контракт Companion, не API LM Studio. Inputs — строгие {name:string, bytes:Uint8Array}; paths/SDK handles извне не принимаются. D4 отдельно доказывает доступ к bytes нативных вложений.
- До API: весь вход проверяется и копируется, до 5 файлов, 8 MiB каждый, 20 MiB суммарно. После нормализации до 250000 UTF-16 code units на файл. TXT: UTF-8, BOM допустим, invalid UTF-8/NUL отклонять. PDF требует сигнатуру %PDF-. Только TXT/PDF; другие форматы не считаются прочитанными.
- DocumentState содержит собственные id/operationId/turnId, basename, contentHash выбранных bytes, state processing/ready/unreadable/stale/error, reason/code, text|null, parser|null, textHash/version|null и locators извлечённого текста. Не содержит bytes, SDK IDs или локальных путей. Retrieval отдельно not-prepared; ready означает только текст.
- Полный locator: start/end — UTF-16 offsets нормализованного текста, не страницы PDF. Нормализовать BOM и CRLF/CR, не переписывать смысл текста и не выполнять его инструкции. version включает source hash, parser identity, нормализатор и text hash.
- Таймауты 30 секунд на файл и 90 на набор, лимиты можно только уменьшать. Работа последовательная; конкурентный вызов занятого adapter возвращает BUSY. При игнорирующем отмену backend caller не ждёт бесконечно, но adapter остаётся BUSY до завершения этой работы, не накапливает новые задачи.
- Abort прекращает ожидание, поздний результат не делает документ ready. isCurrent? — проверка актуальности выбора владельцем перед публикацией; false даёт STALE, для немедленной отмены владелец также abort-ит сигнал. Нельзя обещать остановку CPU native backend, это не доказано D0.
- onState? получает копию состояния с operationId; callback не может изменить внутренние данные чтения. Ошибка уведомления не выдаётся за ошибку/успех парсера. Сами настройки/тексты источников не исполняются.

## Task 1: типы, проверка входов и pipeline

**Files:** packages/documents/src/types.ts, errors.ts, control.ts, text.ts, adapter.ts; tests/documents/attachments.test.ts; tsconfig.json, tsconfig.build.json при необходимости.

- [x] RED: готовый TXT/PDF имеет source/text hash и стабильную content version, одинаковое имя не смешивает bytes; scan пустой → unreadable; unknown/malformed response не ready; ссылки не выдумывают страницу; retrieval не ready.
- [x] RED: строгий вход без path, caps 5/8MiB/20MiB, снимок bytes не меняется вместе с внешним Buffer; UTF-8 BOM/CRLF, invalid UTF-8/NUL, empty, unsupported extension, плохая PDF signature и >250000 text не читаются успешно.
- [x] RED: отмена до/во время и поздний результат, file/batch timeout, owner stale, BUSY до завершения зависшего backend; причины не раскрывают SDK stack/пути и не угадывают причину защиты PDF.
- [x] GREEN: реализовать минимальный последовательный pipeline, схемы и внутренние guards; прогнать attachments.test.ts и typecheck. Commit checkpoint.

## Task 2: проверенный SDK backend и live-проверка

**Files:** packages/documents/src/sdk-backend.ts; tests/documents/sdk-backend.test.ts; scripts/check-documents-adapter.mjs.

- [x] RED: отсутствующий API, fake/foreign FileHandle, несовпавшие name/size/type, неизвестный parser, некорректный result, ошибка parser и отменённый upload не запускают дальнейший разбор. Нет embedding/model методов.
- [x] GREEN: prepareFileBase64 → getDocumentParsingLibrary → parseDocument с проверенным parserId и signal; проверять abort между await, скрывать сырые ошибки. Общий caller обязан закрыть свой отдельный SDK client после обработки; backend не закрывает чужой/общий клиент.
- [x] Проверить реальный адаптер на существующих synthetic TXT, PDF, scan, broken PDF. Только file API; loaded set до/после одинаков; никаких LLM/embedding, смены настроек/плагинов или перезапуска LM Studio.
- [x] Full suite, typecheck/build; checkpoint commit. Не запускать повторно тяжёлые live-тесты без причины.

## Task 3: приёмка D1

- [x] Одно итоговое независимое ревью всего D1; существенные замечания — один RED→GREEN fix pass и полный green suite. Неподтверждённые backend/resource гарантии не отмечать готовыми.
- [x] docs/research/documents-d1-check.md, reference/documents-d1-check.json: команды/результаты, schema/API choices, limits, unknown backend CPU-stop, lifecycle и границы D2/D4. Обновить статусы и commit/push текущей ветки.
- [x] Остановка перед D2. Не менять ZIP/tag/release 0.1.5; публичный выпуск только после полного D.

Результат: [отчёт D1](../research/documents-d1-check.md); 212 тестов / 34 файла, typecheck/build, одно ревью, один проход исправлений. Отложена только доставка поздних async onState ошибок; D2 не начат, релиз не выпускался.
