# Понятная постоянная память — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Подэтапы C0–C5 и правило «один заход — один подэтап»: [порядок выполнения](03-memory-stages.md). C0 и C1 завершены; [результаты C1](../research/memory-c1-check.md). C2 выполнен: [экран памяти и проверки](../research/memory-c2-check.md). C3 выполнен для общей памяти: [результаты](../research/memory-c3-check.md). C4: команды и предложения с подтверждением в панели; [результаты](../research/memory-c4-check.md). C5 ещё не выполнен.

**Goal:** Пользователь видит сохранённые факты и может надёжно управлять ими без знания memory-tools.

**Architecture:** Совместимый адаптер/fork persistent-memory с одним владельцем хранения. Панель и LM Studio обращаются к нему через management API; живая база старого плагина не редактируется вторым процессом.

**Tech Stack:** TypeScript, SQLite/sql.js после проверки лицензии и persistence, существующие TF-IDF/категории, Vitest, локальная панель.

**Spec:** [DESIGN.md](../DESIGN.md), [текущее поведение](../CURRENT-STATE.md). Зависимость: план 00.

## Global Constraints

Все 10 общих ограничений DESIGN.md обязательны. Существующие личные записи не использовать в тестах. Миграция — отдельное действие с backup. По умолчанию явное сохранение; «Предлагать сохранить» включается пользователем. Факты из сайтов, цитат и вымышленных примеров не сохраняются автоматически как личные.

## Review Focus

- Два писателя и сбой сохранения: отсутствие тихой потери данных — задача 1.
- Поздний фоновый результат или старая формулировка из переписки: ручная правка остаётся главной, прежний факт не возвращается отдельной активной записью — задачи 1–3.
- Одинаковая тема в двух проектах: в prompt только global + текущий project — задача 2.
- «Не сохраняй это» и временный факт: не попадают в постоянную память — задача 2.
- Удалённая запись уже присутствует в старом чате: объяснить остаточный контекст, не обещать стирание истории — задача 3.
- Русская перефразировка и короткая реплика: проверять релевантность без ограничения «меньше 10 символов — никогда» — задача 2.

## Task 1: Единственный владелец, CRUD и импорт

**Files:** создать `packages/memory/src/store.ts`, `migration.ts`, `types.ts`, `tests/memory/store.test.ts`, `tests/fixtures/memory-v2.json`, `docs/research/memory-compatibility.md`.

**Interfaces — уточнение C1:** актуальная запись и методы владельца определены в [контракте C1](03-memory-c1.md) и `packages/memory/src/types.ts`: добавлены identityKey/revision/pinned/manualPriority/deletedAt и совместимые дополнительные поля. update/delete требуют expectedRevision; background использует одноразовый token и не записывает результат без подтверждения. Backup/restore C1 работает только с собственным snapshot; импорт прежней памяти перенесён в C5 и пока не реализован. Общий OperationResult сохранён.

- [ ] Тесты `singleWriterEnforced`, `failedFlushIsNotSuccess`, `migrationPreservesFields`, `migrationIsIdempotent`: `expect(result.ok).toBe(false)` при отказе диска; повторный импорт не удваивает записи; копия исходной fixture не меняется. Дополнительные upstream-поля сохранить при миграции, даже если UI их пока не показывает.
- [ ] Запустить `npm exec vitest -- run tests/memory/store.test.ts`; получить падение.
- [ ] Проверить upstream LICENSE и атрибуцию. Реализовать одного владельца с сериализованной записью, ошибками наружу и атомарным сохранением через временный файл. Не импортировать методы, которые подавляют persist error, без исправления. Использовать отдельный data-dir; migration только из согласованной offline-копии после остановки старого плагина. Session хранить отдельно в RAM.
- [ ] Повторить тесты; проверить restart, disk-full/permission denied, backup и rollback на синтетических данных. Исходную личную БД не трогать. Добавить optimistic revision/conflict для одновременного редактирования одной записи из двух окон.
- [ ] Добавить проверки `backgroundResultDoesNotOverwriteManualEdit`, `oldFactDoesNotReturnAsNewRecord`, `manualEditPrioritySurvivesRestart`: отложенный фоновый результат и повтор старого факта не изменяют актуальную ручную запись и не создают противоречащий активный дубль. Владелец хранения проверяет актуальность операции по стабильной идентичности записи и ревизии; одного сравнения текста или метки source недостаточно. Конкретный механизм согласовать до реализации хранения.
- [ ] Проверить diff и сохранить commit.

## Task 2: Подбор памяти и сохранение без вмешательства в ответ

**Files:** создать `packages/memory/src/retrieval.ts`, `capture.ts`, `packages/lmstudio-plugin/src/memory/inject.ts`, `tests/memory/retrieval.test.ts`.

**Interfaces:** `selectMemories(query: string, ctx: TurnContext, tokenBudget: number): Promise<{records: MemoryRecord[]; usedTokens: number}>`; `proposeMemory(userText: string, ctx: TurnContext): Promise<OperationResult<{candidates: string[]}>>`; `buildMemoryContext(records: MemoryRecord[]): string`. TokenBudget берётся из реального оставшегося контекста; предложение ничего не записывает само. Проект берётся из неизменяемой привязки чата, не из глобальной настройки панели.

Решения пользователя: текущие явно выбранные материалы имеют приоритет над памятью; внутри выделенного памяти бюджета важные закреплённые предпочтения идут раньше обычных записей. Конфликт с ручной правкой формирует предложение на подтверждение и до подтверждения не меняет управляемую память или подстановку. При нехватке места сообщать о пропуске, не утверждать, что запись отсутствует.

- [ ] Тесты `projectIsolationBeforeRanking`, `sessionCannotCrossChatOrHostRestart`, `unknownChatDisablesScopedInjection`, `shortQueryCanRecallPinnedFact`, `doNotRememberWins`, `quotedWebTextNotPersonal`, `rephrasedRussianPreference`: returned records имеют global, текущий project или точный sessionId текущего чата; чужой sessionId не проходит; запрет сохранения даёт candidates=[]; при chatScopeId=null подставляется только global. Из 10 заранее размеченных RU-пар ожидается не меньше 8 релевантных top-5, иначе semantic improvement остаётся отдельным измеренным этапом.
- [ ] Запустить `npm exec vitest -- run tests/memory/retrieval.test.ts`; получить падение.
- [ ] Переиспользовать TF-IDF как baseline, фильтровать scope до ранжирования, добавить закреплённые пользователем предпочтения и простой budget. Не выдавать TF-IDF за смысловой поиск. Извлечение только из прямых пользовательских сообщений; при Parallel=1 ставить после основного ответа с реальной отменой потока и лимитом 12000 мс на всю операцию. Выбранная модель явная, не «первая загруженная».
- [ ] Повторить тесты; проверить отсутствие второго запроса к модели в explicit-режиме и отсутствие автозагрузки модели для памяти. На русских тестах сравнить baseline с улучшением; embedding добавлять только при доказанной пользе и измеренном расходе.
- [ ] Проверить diff и сохранить commit.

## Task 3: Экран «Что модель обо мне знает»

**Files:** создать `packages/control-panel/src/features/memory/Memory.tsx`, `MemoryEditor.tsx`, `packages/host/src/routes/memory.ts`, `tests/memory/workflow.test.ts`, дополнить `docs/USER-GUIDE.md`.

**Interfaces:** API использует CRUD задачи 1; `getMemoryUsage(turnId: string): Promise<{ids: string[]; reasons: string[]}>` в `packages/memory/src/usage.ts`. Индикатор строится по реально подставленным записям, не по заявлению модели.

- [ ] Тесты `editVisibleAfterRestart`, `deletionStopsFutureInjection`, `failedSaveShowsError`, `usedCountIsActual`: `expect(nextInjectedIds).not.toContain(deletedId)`; сохранённый текст совпадает после restart; failure не даёт toast «Сохранено».
- [ ] Запустить `npm exec vitest -- run tests/memory/workflow.test.ts`; получить падение.
- [ ] Сделать поиск, список, редактор, фильтр проекта, «Забыть», экспорт и предложения сохранения с «Сохранить / Исправить / Не сохранять». Показывать статус и источник записи, а не числовую «уверенность» как доказательство. Не менять личные факты бесшумно при конфликте. У временной области подпись «Для этого чата, до перезапуска Companion»; для смены проекта старого чата предлагать новый чат. Закрытие LM Studio не обещает очистку работающего host.
- [ ] Проверить `conflictingSuggestionRequiresConfirmation`: отклонение предложения сохраняет ручную правку; принятие нового значения происходит только явным действием пользователя. Поздняя фоновая операция не обходит это подтверждение.
- [ ] Повторить тесты; проверить delete → новый чат → recall. Старые processed messages и сжатые summaries могут содержать прежний факт: явно объяснить это в UI. В управляемом будущем projection не добавлять удалённую запись повторно; для старых чатов предложить новый чат, не переписывать их задним числом.
- [ ] Проверить diff и сохранить commit.
