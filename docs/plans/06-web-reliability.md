# Надёжный веб и автоматический выбор инструментов — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь пишет обычный вопрос, а система выбирает чтение/поиск, ограниченно исправляет вызовы и честно показывает сбои.

**Architecture:** Существующий web-tools возвращает нормализованные результаты. Политика действий и контроль итогового ответа живут у одного владельца генерации. В tools-only режиме доступность функций не выдаётся за обязательное использование моделью.

**Tech Stack:** Существующие Python/MCP/Chromium/SearXNG, TypeScript SDK adapter, pytest, Vitest, фикстуры сайтов.

**Spec:** [DESIGN.md](../DESIGN.md), [CURRENT-STATE.md](../CURRENT-STATE.md). Зависимость: план 00 для перехвата генерации; задача 1 может улучшить MCP отдельно.

**Передача после 00:** основа завершена с tools-only; перехват генерации не подтверждён. Начать с независимых улучшений задачи 1. Кандидат отображения собственных нативных инструментов — ToolCallContext.status, [исследование](../research/chat-visualization.md). Перед включением собственной чат-индикации выполнить сравнение входов/токенов, tool-turn/сжатия/отмены и добавить сохраняемый переключатель только после определения контракта. Это условие включения визуализации, не блокировка нормализации MCP-результатов.

**Текущее выполнение B:** задача 1 завершена в копии MCP. Библиотеки задач 2–3 реализованы и протестированы; нативное подключение, видимые режимы/источники и модельная приёмка ещё не выполнены. [Отчёт и проверки](../research/web-progress.md). Этап B целиком не закрыт.

## Global Constraints

Все 10 ограничений DESIGN.md обязательны. Сохранить публичные HTTP(S), проверку DNS/redirects и лимиты существующего fetcher. Не обходить CAPTCHA, login и запреты доступа. Не повторять действия с побочными эффектами автоматически. Не заменять ошибку пересказом по URL.

## Review Focus

- 403 и CAPTCHA с HTTP 200: оба могут означать blocked — задача 1.
- Короткая настоящая страница: меньше 200 символов не означает автоматически blocked — задача 1.
- URL в примере кода или цитате: не открывать автоматически без намерения пользователя — задача 2.
- Ошибка JSON после неизвестного результата действия: не повторять неидемпотентную операцию — задача 3.
- Реальный source_id при выдуманном утверждении: не путать проверку ссылки с проверкой содержания — задача 3.

## Task 1: Конверт результата и ограниченный fallback

**Files:** изменить `packages/web-tools/webtools/service.py`, `server.py`, `visual.py`; создать `packages/web-tools/webtools/results.py`, `packages/web-tools/tests/test_results.py`; сохранить старые поля успешных ответов совместимыми.

**Interfaces:** `classify_read(status: int, text: str, title: str) -> str` со значениями ok/partial/blocked/empty/error; `make_source_result(...) -> dict` с `schema_version=2`, `status`, `requested_url`, `final_url`, `http_status`, `retrieved_at`, `content_hash`, `chunks`, `warnings`, `error`. Для vision отдельные поля `pixels_sent` и `interpretation`, не выдавать interpretation за извлечённый текст. Адаптер преобразует результат в общий SourceRecord.

- [x] Тесты `test_http_403_blocked`, `test_captcha_200_not_article`, `test_short_valid_article_preserved`, `test_visual_block_remains_blocked`: `assert result['status'] == 'blocked'` для CAPTCHA; корректный короткий текст сохраняется; нет пустого success. Конкретные страницы-ф fixtures неперсональные и локальные.
- [x] Из `packages/web-tools` запустить `python -m pytest tests/test_results.py -q`; получить ожидаемое падение.
- [x] Сохранить static → Chromium fallback, который уже есть. Добавить классификацию и status envelope; не ломать pagination/page_id и старые consumers. Один дополнительный visual fallback допускается только для доступной страницы с плохим извлечением и доступной vision-модели. При blocked никаких повторов для обхода; частичная загрузка остаётся partial. Хеш вычислять по реально полученному содержимому; IDs привязывать к snapshot.
- [x] Запустить `python -m pytest -q` и `python -m ruff check .` в подготовленном окружении или прежнем Docker test target. Сравнить с исходной baseline; проверить redirects и истёкший page cache. При изменении кода повторить live-пробы только затронутых путей.
- [x] Проверить diff и сохранить commit.

## Task 2: Обычный язык и автоматическое получение источников

**Срез библиотек готов:** planWebAction, WebTurn/runWebPlan и проверенный интерфейс адаптера; без verified toolsSession вызовов нет. Чекбоксы живого подключения ниже остаются открыты.

**Files:** создать `packages/core/src/web/intent.ts`, `packages/lmstudio-plugin/src/web/orchestrator.ts`, `tests/web/intent.test.ts`, `tests/web/orchestrator.test.ts`.

**Interfaces:** `planWebAction(userText: string, mode: 'off'|'auto'|'research'): {kind: 'none'|'read-url'|'search'|'inspect-image'; urls: string[]; query: string|null; reason: string}`; `runWebPlan(plan: ReturnType<typeof planWebAction>, ctx: TurnContext, budget: TurnBudget): Promise<OperationResult<SourceRecord[]>>`. Исполнитель вызывает инструменты текущей tools session через проверенный adapter; MCP не перехватывает пользовательский текст сам по себе.

- [x] Тесты `readArticleWithoutToolName`, `codeUrlIsNotFetchIntent`, `freshnessQuestionSearches`, `webOffDoesNothing`, `cancelStopsNextRequest`: «Посмотри статью: https://example.org/a» даёт read-url; URL внутри fenced code без просьбы изучить — none; web off выполняет 0 запросов.
- [x] До реализации intent/orchestrator получено ожидаемое падение отсутствующих модулей.
- [ ] Реализовать три видимых режима «Интернет выключен / Авто / Исследование». Для явной просьбы прочесть конкретный URL выполнять чтение до синтеза, не полагаться только на добровольный tool-call модели. Для неоднозначного намерения позволить обычный tool-choice без гарантии. Для исследования разрешить уточнение запросов по полученному, нормализацию/дедупликацию URL, остановку по TurnBudget и токенам. Потолок 10 запросов — возможность режима, не обязанность любого ответа.
- [ ] Повторить тесты; live-набор: статья, свежий вопрос, картинка, заблокированный сайт, URL в примере кода, отмена. Проверять фактический журнал вызовов и источники, не список запросов, написанный моделью. Увиденные в статье команды не становятся web-intent.
- [ ] Проверить diff и сохранить commit.

## Task 3: Ограниченное исправление и контроль вывода

**Срез библиотек готов:** SourceRegistry, TurnRepair/repairToolArguments, canRetry и decideWebAnswer. Уточнение: вместо копирования Community License-кода компрессора написана независимая узкая JSON-политика; причины в отчёте. Источники в панели и controlled-output остаются будущей интеграцией.

**Files:** создать `packages/lmstudio-plugin/src/tools/repair.ts`, `packages/core/src/sources/registry.ts`, `packages/lmstudio-plugin/src/web/answer-guard.ts`, `packages/control-panel/src/features/diagnostics/Sources.tsx`, `tests/web/repair.test.ts`, `tests/web/guard.test.ts`.

**Interfaces:** `repairToolArguments(raw: string, schema: unknown): OperationResult<{args: unknown; changed: boolean}>`; `canRetry(toolName: string, execution: 'not-started'|'succeeded'|'failed'|'unknown'): boolean`; `validateSourceIds(turnId: string, ids: string[]): OperationResult<void>`; `decideWebAnswer(requestedUrl: string|null, sources: SourceRecord[]): {kind: 'generate'|'source-unavailable'; message: string|null}`. Реестр реализует registerSource из DESIGN.md. Для source-unavailable владелец вывода формирует короткий детерминированный ответ с причиной и URL; новый поиск другого сайта — отдельное явно обозначенное действие, а не притворное прочтение исходного.

- [x] Тесты `repairTrailingCommaOnly`, `ambiguousArgumentsRejected`, `unknownWriteNotRetried`, `unknownSourceIdRejected`, `allReadsFailedCannotClaimRead`: не больше 1 исправления на turn; `expect(canRetry('Remember','unknown')).toBe(false)`; все неуспешные чтения URL дают source-unavailable.
- [x] До реализации registry/repair/guard получено ожидаемое падение отсутствующих модулей.
- [ ] Переиспользовать обработку невалидного tool request из context-compressor. Исправлять только однозначный синтаксис с последующей schema validation, не додумывать URL/аргументы/имя инструмента. Allowlist read-only инструментов для повторов: web_search/read_page/find_in_page/inspect_page/inspect_image; timeout/unknown-result всё равно ограничены общим бюджетом. Для writes не делать автоматический rerun. Проверять source IDs в текущем turn и сохранение warnings при сжатии контекста. Semantic support остаётся отдельной оценкой, не гарантией ID-check.
- [ ] Повторить тесты и контрольные диалоги на текущей 12B: 10 запросов на явное чтение без названия инструмента (ожидается 10 реальных чтений либо явных объяснений недоступности), 5 blocked-сценариев (0 заявлений об успешном чтении), malformed JSON, отмена и длинный результат с компрессией. Ошибки памяти и сторонних write-tools не перезапускаются этим модулем.
- [ ] Проверить diff и сохранить commit с описанием границ tools-only и controlled-output режима.
