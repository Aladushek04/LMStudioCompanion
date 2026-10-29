# Управление Thinking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать режимы «Быстро / Авто / Подробно» понятными и подтверждёнными реальной генерацией.

**Architecture:** Модельный адаптер управляет проверенным механизмом шаблона до генерации. Политика режима подключается к единственному владельцу ответа из плана 00 и не меняет сохранённую историю ради переключения.

**Tech Stack:** TypeScript, текущий LM Studio SDK/runtime, адаптер Gemma 4, Vitest, ручные live-пробы.

**Spec:** [DESIGN.md](../DESIGN.md). Зависимость: выбранная интеграция из плана 00.

## Global Constraints

Все 10 ограничений DESIGN.md обязательны. Фразы «не думай», скрытие thought-блока и обрезание вывода не являются подтверждённым выключением Thinking. Нельзя менять глобальную настройку модели посреди другого ответа. Auto не включать до прохождения задачи 1.

## Review Focus

- Поле SDK существует, но deprecated: не считать его стабильным переключателем — задача 1.
- Выключены видимые мысли, но токены продолжают расходоваться: проверить шаблон и reasoning usage — задача 1.
- Короткий сложный вопрос и длинный простой перевод: не судить по одной длине — задача 2.
- Вызовы инструментов/vision при смене режима: сохранять протокол и вложения — задача 3.
- Продолжение agentic-turn: не удалять нужное состояние рассуждений внутри его tool-цикла — задача 3.

## Task 1: Подтверждение механизма на конкретной Gemma

**Files:** создать `packages/lmstudio-plugin/src/thinking/gemma4.ts`, `tests/thinking/capability.test.ts`, `docs/research/thinking-report.md`.

**Interfaces:** `probeThinking(modelId: string, signal: AbortSignal): Promise<OperationResult<{supported: boolean; mechanism: string; evidence: string[]}>>`; `configureThinking(modelId: string, mode: 'fast'|'deep'): OperationResult<Record<string, unknown>>`. Возвращаемая конфигурация используется только конкретным verified adapter, не передаётся произвольно в raw.

- [ ] Тест `unsupportedAdapterHasNoFakeSwitch`: `expect(configureThinking('unknown', 'fast').ok).toBe(false)`. Fixture шаблонов fast/deep должен различаться реальным служебным форматированием, а не текстом пожелания.
- [ ] Запустить `npm exec vitest -- run tests/thinking/capability.test.ts`; получить падение.
- [ ] Проверить актуальный поддержанный способ конфигурации шаблона. Сравнить токены подготовленного prompt и фактические reasoning spans в ответе на фиксированных задачах. Локальный promptTemplate deprecated, raw экспериментален: изолировать исследование, не включать как стабильный путь без явного versioned adapter и regression checks. При отсутствии надёжного пути вернуть supported=false.
- [ ] Повторить тесты; записать prompt/template evidence и реальные задержки на 12B. Для 26B статус unknown до отдельной проверки. Критерий fast — служебный thought-канал выключен корректно, а не просто не отображён.
- [ ] Проверить diff и сохранить commit. При отрицательном результате остальные автоматические задачи остаются заблокированы, штатный UI LM Studio доступен.

## Task 2: Объяснимая политика режима

**Files:** создать `packages/core/src/thinking/policy.ts`, `tests/thinking/policy.test.ts`.

**Interfaces:** `chooseThinking(input: {requested: 'fast'|'auto'|'deep'; intent: 'chat'|'translate'|'debug'|'research'|'other'; conflictingSources: boolean; supported: boolean}): OperationResult<{effective: 'fast'|'deep'; reason: string}>`.

- [ ] Тесты `longTranslationFast`, `shortDebugDeep`, `manualChoiceWins`, `unsupportedAutoExplained`: `expect(chooseThinking({...fixture, intent:'translate'}).value.effective).toBe('fast')`; явный fast сохраняется даже при conflictingSources=true.
- [ ] Запустить `npm exec vitest -- run tests/thinking/policy.test.ts`; получить падение.
- [ ] Реализовать небольшие правила: ручной выбор приоритетен; auto fast для перевода/болтовни; deep для подтверждённой отладки и исследования с противоречиями; неоднозначные случаи объяснять. Intent берётся из нормализованного пользовательского запроса, а не текста веб-страницы. Отдельную LLM-классификацию не добавлять.
- [ ] Повторить тесты и прогнать набор из 20 неперсональных запросов. Не заявлять универсальную точность: сохранить ошибочные решения и дать ручной override.
- [ ] Проверить diff и сохранить commit.

## Task 3: Подключение к чату и панели

**Files:** создать `packages/control-panel/src/features/thinking/Thinking.tsx`, `packages/lmstudio-plugin/src/thinking/integration.ts`, `tests/thinking/integration.test.ts`.

**Interfaces:** `applyTurnThinking(ctx: TurnContext, modelId: string): Promise<OperationResult<{effective: 'fast'|'deep'; reason: string}>>`; настройки брать из Settings плана 00. Конфигурация относится ко всему текущему tool-turn; изменение UI применяется со следующего хода.

- [ ] Тесты `preservesToolContinuation`, `preservesImageAttachment`, `modeChangesNextTurn`: `expect(after.attachments).toEqual(before.attachments)`; mode текущего turn не меняется от нового UI selection.
- [ ] Запустить `npm exec vitest -- run tests/thinking/integration.test.ts`; получить падение.
- [ ] Подключить адаптер к одному владельцу генерации, добавить переключатель и короткую причину выбора. При unsupported — причина и ссылка-инструкция на штатные настройки; не показывать кнопку как рабочую. Исключить искусственные stop strings, обрубающие вызовы функций.
- [ ] Повторить тесты и три live-сценария: перевод, отладка, веб+картинка. Проверить отмену, повтор ответа, отсутствие дублированного ответа и сохранение сжатия контекста.
- [ ] Проверить diff и сохранить commit.
