# Понятные профили загрузки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь выбирает задачу и получает объяснимые настройки модели без ручного перебора ползунков.

**Architecture:** Read-only сбор ресурсов и CLI estimate отделены от применения. Профиль привязан к конкретным модели, runtime, квантованию и контексту; требующаяся перезагрузка выполняется после ответа явным действием.

**Tech Stack:** TypeScript, LM Studio SDK/CLI, Windows resource adapter, Vitest, существующая панель.

**Spec:** [DESIGN.md](../DESIGN.md). Зависимость: план 00, задачи 1–2.

## Global Constraints

Все 10 общих ограничений DESIGN.md обязательны. Подбор не меняет активную модель. Не обещать фиксированные безопасные 64К/128К и не перепутать max context с максимальной скоростью. Данные модели берутся из API, не из имени файла.

## Review Focus

- GPU занят другой программой: учесть текущую свободную память, не только 16 ГБ паспортных — задача 1.
- CLI не вернул понятную оценку: состояние unknown, никакого зелёного «подходит» — задача 1.
- Включено vision или загружен embedding: оставить запас и показать причину — задача 1.
- Генерация активна: применение не запускается до её окончания — задача 2.
- Неуспешная загрузка: восстановление прошлого профиля или явное состояние восстановления — задача 2.

## Task 1: Инвентаризация и кандидаты

**Files:** создать `packages/host/src/hardware/inventory.ts`, `estimate.ts`, `profiles.ts`, `tests/profiles/estimate.test.ts`.

**Interfaces:** `estimateProfile(modelKey: string, candidate: ProfileCandidate, signal: AbortSignal): Promise<OperationResult<ProfileEstimate>>`; `ProfileCandidate = {contextLength: number; gpuRatio: number}`; `ProfileEstimate = {candidate: ProfileCandidate; gpuBytes: number|null; totalBytes: number|null; state: 'fits'|'tight'|'unknown'; measured: false}`. Команда запускается argv-массивом, JSON CLI использовать только при реальной поддержке; нестабильный текстовый вывод нормализовать отдельным versioned parser.

- [ ] Тесты `subtractsOtherAllocations`, `unknownEstimateStaysUnknown`, `visionReserveIncluded`: `expect(result.state).toBe('unknown')` на повреждённом выводе; профиль со свободными 1 ГБ не признаётся fits при оценке 8 ГБ.
- [ ] Запустить `npm exec vitest -- run tests/profiles/estimate.test.ts`; получить падение.
- [ ] Реализовать сбор RAM/GPU и lms inventory, кандидаты 16384 и 32768; 65536 только после успешной оценки. Первоначальный запас автора: не меньше 2 ГБ GPU и 4 ГБ RAM, дополнительно учитывать реальные текущие выделения без двойного вычитания. Если telemetry нет — unknown, только рекомендация.
- [ ] Повторить тесты; записать dry-run для текущей 12B, не загружая другую модель. Проверить, что выбранные поля CLI/SDK поддержаны текущей версией. Значения запаса — стартовая политика, не доказательство отсутствия OOM.
- [ ] Проверить diff и сохранить commit.

## Task 2: Применение и возврат профиля

**Files:** создать `packages/host/src/hardware/apply.ts`, `tests/profiles/apply.test.ts`.

**Interfaces:** `applyProfile(profileId: string, signal: AbortSignal): Promise<OperationResult<{activeProfileId: string; restoredPrevious: boolean}>>`; `getPreviousProfile(): Promise<ModelProfile|null>`; `ModelProfile = {id: string; modelKey: string; runtimeId: string; contextLength: number; gpuRatio: number; loadSettings: Record<string, unknown>}`. Load settings заполняются только поддержанными и проверенными полями; opaque settings не исполняются как команды.

- [ ] Тесты `doesNotReloadDuringGeneration`, `restoresAfterLoadFailure`, `cancelBeforeUnloadKeepsModel`: `expect(loader.unloadCalls).toBe(0)` при занятом владельце ответа; после успешного возврата `expect(active.id).toBe(previous.id)`.
- [ ] Запустить `npm exec vitest -- run tests/profiles/apply.test.ts`; получить падение.
- [ ] Реализовать application lock, перепроверку свободной памяти, сохранение прежней конфигурации и проверку реально загруженных параметров. `.model(config)` не использовать для изменения уже загруженного instance: загрузочные параметры в этом случае могут игнорироваться. Ошибку самого rollback возвращать явно, не как успех.
- [ ] Повторить тесты; в отдельном тестовом сеансе применить профиль той же 12B и вернуть исходный. Смена 26B — отдельный осознанный live-тест при реализации, результаты не выдумывать.
- [ ] Проверить diff и сохранить commit.

## Task 3: Кнопка подбора и короткий бенчмарк

**Files:** создать `packages/control-panel/src/features/profiles/Profiles.tsx`, `packages/host/src/hardware/benchmark.ts`, `tests/profiles/workflow.test.ts`.

**Interfaces:** `benchmarkProfile(profileId: string, signal: AbortSignal): Promise<OperationResult<{promptTokensPerSecond: number|null; outputTokensPerSecond: number|null; firstTokenMs: number|null; runtimeId: string}>>`. Использовать фиксированный неперсональный текст; не выполнять на личной истории.

- [ ] Тесты `separatesEstimateAndMeasurement`, `cancelBenchmarkPreservesProfile`, `noMisleadingFastestLabel`: `expect(estimate.measured).toBe(false)`; непроверенный кандидат не получает метку «Самый быстрый».
- [ ] Запустить `npm exec vitest -- run tests/profiles/workflow.test.ts`; получить падение.
- [ ] Добавить «Подобрать настройки», карточки кандидатов, «Проверить скорость», «Применить после ответа», «Вернуть прежние». Расширенные параметры раскрываются отдельно. Бенчмарк не стартует автоматически; результаты хранят ключи модели/runtime/сценария и дату.
- [ ] Повторить тесты; вручную пройти подбор и отмену. Показать отдельно скорость первого ответа, чтения контекста и генерации; не рекомендовать больший контекст только потому, что он помещается.
- [ ] Проверить diff и сохранить commit.
