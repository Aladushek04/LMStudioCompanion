# Понятная работа с документами на базе rag-v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Порядок отдельных заходов D0–D5: [разбивка этапа D](04-documents-stages.md). D0 завершён: [проверка API](../research/documents-api-report.md); D1 завершён: [ограниченный адаптер чтения](../research/documents-d1-check.md). Экран и подключение к чату D2–D5 не реализованы. Задача 1 ниже покрывается D0–D2, задача 2 — D3–D5. Задача 3, постоянные библиотеки папок, остаётся этапом G; она не входит в первый выпуск D. Возможность строгого режима ещё требуется доказать, новый владелец генерации не предполагается.

**Goal:** Пользователь добавляет документы и понимает, что прочитано и откуда взят ответ.

**Architecture:** Сначала улучшить прикрепления через существующие parseDocument/retrieve/citations. Библиотеки папок — отдельный шаг после проверки устойчивых FileHandle и жизненного цикла индекса. Не запускать два конкурирующих RAG-препроцессора.

**Tech Stack:** TypeScript, LM Studio files/embedding API, адаптер или лицензированный fork rag-v1, локальный каталог метаданных, Vitest.

**Spec:** [DESIGN.md](../DESIGN.md), [CURRENT-STATE.md](../CURRENT-STATE.md). Зависимость: план 00.

## Global Constraints

Все 10 ограничений DESIGN.md обязательны. RAG не обещает прочесть весь архив целиком и не гарантирует корректный ответ. Исходные файлы не меняются. OCR сканов, полное понимание таблиц и картинок PDF не входят в первый выпуск; отсутствие текста явно показано.

Решение пользователя от 2026-10-29: поддержать автоматический подбор фрагментов по вопросу и явное указание файлов, глав, страниц или разделов. Явное указание ограничивает область поиска; автоматический подбор выполняется внутри неё. Номера страниц используются только при наличии подтверждённых метаданных. Выбранные материалы текущего запроса имеют приоритет по DESIGN.md; нехватка места и частичное изучение видны пользователю.

## Review Focus

- Пустая выдача в режиме «только по документам»: честный итог без ответа из памяти модели — задача 2.
- PDF-скан, ошибка парсинга, embedding не загружается: отдельное состояние, не «готово» — задача 1.
- Дубли файлов с одинаковым именем: сохранять идентичность, путь/библиотеку и хеш — задачи 1 и 3.
- Изменённый/удалённый файл: старые фрагменты исключаются из нового поиска — задача 3.
- Файл с инструкциями для модели: материал остаётся цитируемыми данными — задача 2.
- Явно указанный раздел и автоматический подбор: выбранная пользователем область соблюдается; частичное чтение не выдаётся за полный охват — задачи 1–2.

## Task 1: Адаптер текущих прикреплений

**Files:** создать `packages/documents/src/adapter.ts`, `types.ts`, `tests/documents/attachments.test.ts`, `docs/research/documents-api-report.md`.

**Interfaces (уточнены D1):** `createDocumentAdapter(backend, limits?).prepareDocuments(inputs: unknown[], ctx: TurnContext, options?): Promise<OperationResult<DocumentState[]>>`. Вход — строгие `{name, bytes: Uint8Array}` выбранных снимков, не произвольный path или сохранённый FileHandle. Собственный SDK backend создаёт/проверяет свой handle перед чтением. [Полная схема DocumentState](../../packages/documents/src/types.ts) включает состояния, source/text hashes, версию, text-range locators и отдельное `retrieval: not-prepared`. [Контракт D1](04-documents-d1.md) заменяет первоначальное предположение о прямой передаче внешних handles; получение bytes нативных вложений ещё требует проверки D4.

- [ ] Тесты `scannedPdfIsUnreadable`, `embeddingUnavailableExplained`, `sameNameDifferentContent`: `expect(scan.state).toBe('unreadable')`; разные contentHash не объединяются; отсутствие embedding не показывает готовность retrieval.
- [ ] Запустить `npm exec vitest -- run tests/documents/attachments.test.ts`; получить падение.
- [ ] Проверить лицензию rag-v1 и API текущего SDK. Переиспользовать выбор full-text/retrieval и native parsing/citations, добавить бюджет под ответ/память/tools. Убедиться, что модификация сообщения сохраняет картинки и вложения. Показывать реальный прогресс; embedding не грузить без видимого статуса и оценки ресурса.
- [ ] Повторить тесты и проверить неперсональные TXT, текстовый PDF, PDF-скан. Записать фактические metadata locators; не выдумывать номера страниц. В рамках одного чата выбрать только один RAG-preprocessor.
- [ ] Проверить diff и сохранить commit.

## Task 2: Поиск, цитаты и режим ответа

**Files:** создать `packages/documents/src/retrieve.ts`, `answer-policy.ts`, `packages/control-panel/src/features/documents/Documents.tsx`, `tests/documents/retrieval.test.ts`.

**Interfaces:** `retrieveDocuments(query: string, ids: string[], ctx: TurnContext): Promise<OperationResult<SourceRecord[]>>`; `decideDocumentAnswer(mode: 'documents-only'|'mixed', sources: SourceRecord[]): {kind: 'generate'|'no-evidence'; notice: string|null}`. SourceRecord соответствует общему контракту; locator содержит страницу только при наличии реальных метаданных, иначе имя и номер/диапазон фрагмента.

- [ ] Тесты `strictEmptyStopsAnswer`, `mixedModeLabelsOutsideKnowledge`, `sourceTextIsNotInstruction`, `citationsRemainInspectable`: `expect(decideDocumentAnswer('documents-only', []).kind).toBe('no-evidence')`; выбранные chunk IDs существуют в переданных источниках.
- [ ] Запустить `npm exec vitest -- run tests/documents/retrieval.test.ts`; получить падение.
- [ ] Реализовать явные режимы «По документам» и «Документы + общие знания», выбор источников и открытие фрагмента. Пустой strict-result формирует владелец вывода, а не только просьба в prompt. Если интеграция tools-only, strict-mode недоступен с объяснением. Наличие источника не считать семантическим доказательством всех предложений ответа.
- [ ] Повторить тесты; контрольный набор: 10 ответимых вопросов и 5 неответимых, в strict-режиме все 5 дают отсутствие данных. Проверить RU-перефразировки и ложные совпадения по заголовку. Не фиксировать score 0.5 как универсальную границу без измерения.
- [ ] Проверить `automaticSelectionFindsRelevantChunks`, `explicitScopeLimitsRetrieval`, `partialCoverageIsDisclosed`, `budgetOmissionIsNotNoEvidence`: без указания раздела выбираются фрагменты по вопросу; при явном указании поиск ограничен выбранной областью; пропуски по контексту показаны отдельно от пустой выдачи. Если в строгом режиме найденные фрагменты целиком исключены из запроса модели, владелец вывода останавливает содержательный ответ с причиной «не хватило места». Просьба проверить весь документ при частичном охвате получает предложение разбора по частям; полного прочтения не заявлять. Форму области поиска и результата сокращения согласовать с общими контрактами до реализации.
- [ ] Проверить diff и сохранить commit.

## Task 3: Постоянные библиотеки папок

**Files:** создать `packages/documents/src/library.ts`, `files.ts`, `packages/control-panel/src/features/documents/Libraries.tsx`, `tests/documents/library.test.ts`.

**Interfaces:** `addLibrary(root: string, signal: AbortSignal): Promise<OperationResult<{libraryId: string}>>`; `refreshLibrary(libraryId: string, signal: AbortSignal): Promise<OperationResult<{added: number; changed: number; removed: number}>>`; `removeLibrary(libraryId: string): Promise<OperationResult<void>>`. Сохраняются нормализованный root, content hashes, SDK handles и parser/embedding version; механизм handle persistence сначала доказать в documents-api-report.

- [ ] Тесты `changedFileInvalidatesChunks`, `removedFileNotRetrieved`, `junctionCannotEscapeRoot`, `excludedFoldersNotIndexed`: новый поиск не содержит removedId; `node_modules`, `.git`, `.env`, бинарники и файлы вне разрешённого root не индексируются.
- [ ] Запустить `npm exec vitest -- run tests/documents/library.test.ts`; получить падение.
- [ ] Реализовать file picker/проверку выбранного корня, предварительный список и обновление по кнопке. Первоначально до 1000 разрешённых файлов и 20 МиБ на файл; превышение явно показывать и давать отдельную настройку. Наблюдение за каталогом в фоне не требуется в первом выпуске. Если штатный API не даёт устойчивые handles, не писать свой vector-store молча: оставить прикрепления, оформить отдельное решение по стоимости и поддержке.
- [ ] Повторить тесты; проверить restart, перенос проекта, недоступный диск, отмену индексации, два файла с одинаковым именем и обновление embedding. Удаление библиотеки убирает её из поиска, но не удаляет исходники с диска.
- [ ] Проверить diff и сохранить commit.
