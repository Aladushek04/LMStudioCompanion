# Этап 0 — инженерная подготовка к вайбкодингу

**Дата:** 2026-11-03  
**Ветка:** `vibecoding-stage-0`  
**База:** `926da24` (CORE-2, до Этапа 0)  
**Node:** 24.22.2 (рабочий runtime); системный Node 26.13.0 не поддерживается и блокируется.

## Что сделано

### 1. Единая проверка

- `.nvmrc` → `24.22.2`.
- `.npmrc` → `engine-strict=true`.
- `engines.node` → `>=24 <26`.
- `scripts/check-node.mjs` — понятная ошибка на Node 26 и ниже 24.
- `scripts/verify.mjs` — 8 шагов:
  1. Node;
  2. TypeScript (root);
  3. TypeScript (Core);
  4. общие тесты;
  5. Core-тесты;
  6. границы импортов;
  7. style (Biome);
  8. сборка.
- `npm run verify:full` добавляет Python-тесты, Ruff и E2E панели.
- `npm run test:core` — отдельный прогон 424 Core-тестов.
- `vitest.config.ts`: `testTimeout`/`hookTimeout` → 15 секунд. Это устранило baseline-таймаут install-теста.

### 2. Стиль

- Biome 2.6.4, `biome.json`.
- Форматирование Companion-кода одним отдельным коммитом: 151 файл, +18 472 / −5 201 строк.
- `packages/conversation-engine` исключён из массового форматирования, чтобы сохранить upstream-provenance; там изменены только две строки импортов для границ.
- `npm run lint`, `npm run format`, `npm run format:check`, `npm run check`.

### 3. Границы

- `selectIntegration` перенесён в `packages/core/src/integration.ts`.
- Клиент канала памяти перенесён в `packages/memory/src/channel-client.ts`.
- `abortable` вынесен в `packages/core/src/async.ts`.
- `MigrationPreview` вынесен в `packages/memory/src/migration-types.ts`, чтобы панель не импортировала `host`.
- `docs/CODEMAP.md` описывает входные точки, поток данных, владельцев, правила импортов, форматы модулей и живые данные.
- `scripts/check-boundaries.mjs` проверяет production-импорты; тесты исключены.
- Проверено 107 production-файлов; нарушений нет.

### 4. CI

- `.github/workflows/verify.yml` на `windows-latest`, Node 24.22.2.
- Создаётся `.tools/web-venv`, ставятся Python-зависимости.
- Запускаются `npm ci`, `npm run verify`, pytest, Ruff и E2E панели.
- Секреты и живой LM Studio не нужны.

Первый прогон CI (`41686322503`) выявил отсутствие `.tools/web-venv` в чистом runner: unit-тест транспорта Python падал с `ENOENT`. Исправлено в `fc124f2`: тест пропускается без Python, а CI создаёт venv до `npm run verify`.

### 5. Версии и релиз

- Версия продукта из корневого `package.json` подставляется в панель через Vite `define`.
- Футер показывает `Companion · 0.1.5`.
- `scripts/package.mjs` больше не ссылается на удалённую `feat/foundation-panel`; ссылки ведут на `main`.
- README получил раздел «Проверка исходников».

## Результаты

| Проверка | Результат |
|---|---|
| Baseline до изменений | 253/254, один install-тест по таймауту 5 с |
| `npm test` после изменений | **267/267** |
| `npm run test:core` | **424/424** |
| `npm run verify` | **8/8 шагов, VERIFY PASSED** |
| `npm run verify:full` | **10/10 шагов, VERIFY:FULL PASSED** |
| Python pytest | **58 passed, 2 skipped** |
| Ruff | **All checks passed** |
| Panel E2E | **PASS** (connected, offline, cancel, 320px, 200% text, keyboard) |
| Import boundaries | **107 files, 0 violations** |
| Biome lint/format | **0 errors** |

## CI

- Первый run: `41686322503` — failure из-за отсутствия Python venv.
- Второй run: `41686901715` — failure из-за относительного пути к venv внутри `packages/web-tools`.
- Финальный run: **`41687411316` — успешно за 2m28s** на `windows-latest`: Node 24, `npm ci`, `npm run verify`, pytest, Ruff, panel E2E.
- Осталось предупреждение GitHub Actions о Node 20 в используемых action-версиях; это не влияет на проверки и вынесено в отложенные мелочи.

## Аудит зависимостей

`npm audit` на 2026-11-03:

| Пакет | Severity | Тип | Примечание |
|---|---|---|---|
| `vitest` | critical | dev | требует Vitest 5.x |
| `tinypool` | critical | dev (transitive) | требует Vitest 5.x |
| `@vitest/mocker` | moderate | dev (transitive) | требует Vitest 5.x |
| `zod` | high | production | memory exhaustion; исправление — Zod 4.6.7+ |
| `@lmstudio/sdk` | high | production | через Zod; нужен совместимый SDK/Zod |

Production-аудит: **2 high, 0 critical**. Обновление Zod 3 → 4 и Vitest 3 → 5 — отдельная задача с проверкой совместимости; в Этап 0 не входит.

## Ограничения

- `verify:full` требует Edge и Python-окружение; CI создаёт venv, локально можно указать `COMPANION_PYTHON`.
- Core исключён из массового форматирования; `handler.ts` остаётся плотным до Этапа 1.
- Поведение продукта, схема памяти, чаты, настройки LM Studio и `data/` не изменялись.
- `npm run verify` на Node 26 завершается ошибкой по замыслу; используйте Node 24.22.2.
- Отчёт не заменяет независимый security review зависимостей.

## Отложено

- Обновление Zod 4 / Vitest 5.
- Разбиение `handler.ts` и общие API-схемы — Этап 1.
- Кнопка очистки локальных кэшей Core.
- Постоянный Python-worker для веба.

## Команды для проверки

```powershell
nvm use 24.22.2
npm ci
npm run verify
npm run verify:full
npm run test:core
npm run lint
npm run format:check
npm run check:boundaries
npm run build
```

Ожидаемо: `VERIFY PASSED`, `VERIFY:FULL PASSED`, 267 общих тестов, 424 Core-теста, E2E PASS.
