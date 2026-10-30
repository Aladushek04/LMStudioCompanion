# D3: подбор фрагментов, источники и бюджет — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Выполнение inline, одно итоговое независимое ревью всего D3, не ревью на каждую задачу.

**Goal:** По вопросу находить фрагменты только в выбранных файлах/текстовых разделах, проверять реальный токенный бюджет и открывать именно включённый фрагмент.

**Architecture:** Лексический baseline без embeddings, временные снимки D1/D2, SourceRecord без изменения формата. Сначала scope/hash/version → фрагменты → ранжирование → фактическое измерение полного кандидата → атомарная публикация источников. Панель проверяет на пустой истории загруженной модели, без генерации. В действующий чат ничего не подставляется до D4.

**Tech Stack:** TypeScript/Zod, SDK1.5.0, React, Vitest, Edge. Без новых зависимостей.

**Spec:** [D3 в разбивке D](04-documents-stages.md), [DESIGN](../DESIGN.md), [выводы D0](../research/documents-api-report.md), контракты D1/D2.

## Global Constraints

- Русские тексты. Не читать личные файлы/чаты/settings, не менять memory.db/плагины/модели.
- Не использовать model()/load()/generation/embedding. Только уже загруженный экземпляр и его tokenizer/template/contextLength. При отсутствии/неоднозначности модели — явная ошибка.
- Никаких выдуманных физических страниц. Текстовые заголовки определяются ограниченным синтаксисом; область неизвестного раздела не расширяется.
- До 5 снимков по 250000 символов, до 100 распознанных заголовков на файл; больше — явный отказ, не молчаливое усечение. Фрагмент до1200 символов, непересекающиеся диапазоны; лимит включённых фрагментов12, измеряемых кандидатов24. Объём, не просмотренный из-за лимита, виден отдельно.
- Ответ/tools резерв как B/C: max(2048, ceil(contextLength*.15)) +1024. Контекст >=4096. Мерить полный сериализованный payload с реальными ID и предупреждением, без оценки «символы/4».
- Один запрос токенизации панели, deadline8секунд; отмена и смена выбора исключают публикацию; raw/close settlement держит слот. Снимок результата один на RAM-набор, очищается при изменении; TTL владельца D2.
- Коммиты и push текущей feat/foundation-panel; без релиза, merge main и D4.

## Контракты (проверить Zod до обработки)

- Snapshot: `{documentId, revision, document:DocumentState}`. documentId — ID элемента D2, не внутренний id адаптера D1.
- Scope entry: `{documentId, revision, contentHash, version, sections:null|string[]}`. null — весь извлечённый текст, [] — ничего; ID разделов проверяются по тому же тексту/версии. Scope=[] не означает «все файлы». Объединение пересекающихся диапазонов не создаёт дубли.
- Section: `{id,title,start,end,level}`. Markdown #–###### либо явные строки «Глава/Раздел N…», граница — следующий заголовок того же/высшего уровня. Это метаданные извлечённого текста, не PDF-страницы.
- Request: `{query,selection:scope[],wholeDocument:boolean}`. До4096 символов вопроса, строгие поля и уникальные document IDs.
- Result: `{searchId,turnId,state,scope,found,included,sources,payload,coverage,budget,notices}`. state = found/no-matches/budget-omitted/empty-scope; ошибки отдельно OperationResult false. found/included содержат chunk ID, document ID/hash/version, text-range и score; полный текст только у реально включённых SourceRecord.chunks. Пропуски budget/limit и неполный охват не равны отсутствию данных. Просьба изучить всё при неполноте предлагает разбор по частям.
- SourceRegistry получает атомарный метод публикации уже измеренных SourceRecord с сохранением ID. До финальной проверки/commit источники не добавляются; ошибка не оставляет половину набора.
- Host: POST /api/documents/:id/search с body request; GET /api/documents/:id/searches/:searchId/sources/:sourceId/chunks/:chunkId. Прежние Host/Origin/token. Владелец проверяет точный текущий выбор/ревизии и fence после каждого await; открытие устаревшего источника —409/404.

## Review Focus

- Несовпадение item ID D2 и adapter ID D1; одинаковые имена и одинаковые bytes не смешивают область.
- Дубли/вложенность заголовков, неизвестные разделы, явная пустая область, пересечения — никаких расширений области.
- Невалидный tokenizer, model unload/неоднозначность, non-cooperative raw, deadline и abort — без ложного success или второго владельца генерации.
- Смена выбора/версии, старый поиск после нового запроса, открытый диалог при удалении файла — старые результаты не возвращаются.
- Бюджет рамки/ID/предупреждений, skip по лимиту против отсутствия совпадений, запрос всего документа — честный охват.

## Task 1: scope/retrieval/budget

**Files:** packages/documents/src/retrieval-types.ts, scope.ts, chunks.ts, lexical.ts, retrieve.ts, budget.ts; packages/core/src/sources/registry.ts; tests/documents/retrieval.test.ts, retrieval-evaluation.test.ts; tests/fixtures/documents/retrieval.json.

- [x] RED: automaticSelectionFindsRelevantChunks, explicitScopeLimitsRetrieval, unknownSectionDoesNotBroadenSearch, citationsRemainInspectable, partialCoverageIsDisclosed, budgetOmissionIsNotNoEvidence; hashes/versions/empty/duplicates/cancellation/tokenizer failure/atomic registry.
- [x] GREEN: строгие схемы, bounded heading/chunk extraction, лексическое ранжирование только тела текста, scope fence, полный измеренный payload и атомарные SourceRecord. Универсальный threshold0.5 не использовать.
- [x] Размеченные 10 ответимых +5 неответимых, русские перефразировки, заголовок-ловушка, одинаковые имена, границы главы. Записать recall и false retrieval на этом наборе, не обещать универсальное семантическое качество.
- [x] Target tests +typecheck, commit.

## Task 2: владелец/API и экран проверки

**Files:** packages/host/src/documents-search.ts, document-tokenizer.ts, document-workspaces.ts, routes/documents.ts; workspace-types.ts; features/documents/DocumentSearch.tsx, DocumentPreview.tsx, Documents.tsx, documents.css; tests/documents/search-api.test.ts; scripts/check-documents-panel.mjs.

- [x] RED→GREEN API: только выбранные ready-снимки/области, immutable result/citation, stale deselect/remove/retry; auth/strict schemas, aborted/non-cooperative tokenizer, недоступная модель; без вызовов генерации.
- [x] Форма вопроса, области по текстовым разделам, результат/причины/частичный охват/токенный бюджет на пустой истории. Источник открывает ровно сохранённый фрагмент. Результаты и диалог сбрасываются при смене выбора; новый запрос отменяет старый.
- [x] Edge synthetic: выбор, ограничение главой, no-match/budget/error/cancel, источник/plain text, stale response, 320px/200%/клавиатура; обзор/память/D2 регрессии. Commit.

## Task 3: приёмка

- [x] Минимальная native проверка синтетических TXT/PDF через новый API и tokenizer текущей уже загруженной12B; loaded set и source hashes прежние, никаких predictions. Остальные ошибки — synthetic fixtures.
- [x] Полный Vitest, tsc/build; итоговая проверка D3 автором вместо независимого ревью (см. уточнение ниже), один RED→GREEN проход Important/Critical +green suite, Minor записать. Обновить отчёт/guide/roadmap; commit/push. Остановиться перед D4.

## Уточнение формата приёмки после паузы

Прямое ограничение пользователя на модель/режим субагентов имеет приоритет над требованием skill выбрать самого мощного ревьюера. Допустимость наследуемой модели подтвердить нельзя, поэтому прежний агент не возобновляется и новые не запускаются. Итоговая проверка выполняется автором; завершённого независимого ревью нет. Проверка и её исправления отражаются отдельно в отчёте. Это исключение из первоначального порядка, а не заявление о независимой проверке.
