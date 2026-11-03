# Карта кода Companion

Это короткая карта для человека и ИИ. Она отвечает на три вопроса: куда входит запрос, кто владеет данными и какие импорты допустимы.

## Входные точки

| Точка | Файл | Назначение |
|---|---|---|
| Панель | `packages/control-panel/src/main.tsx` | React-панель, собирается Vite |
| Host | `packages/host/src/main.ts` | Локальный HTTP-сервер панели |
| Диагностика | `packages/host/src/diagnose.ts` | CLI-проверка без панели |
| Установка | `packages/host/src/install-cli.ts` | Установка/обновление/откат |
| Плагин чата | `packages/lmstudio-plugin/src/index.ts` | companion-web preprocessor |
| Companion Core | `packages/conversation-engine/src/index.ts` | prediction loop, отдельный пакет |
| Веб | `packages/web-tools/webtools/server.py`, `companion_bridge.py` | Python MCP/stdio |
| Скрипты | `scripts/*.mjs` | Сборка, упаковка, проверки |

## Поток данных

```text
control-panel ──HTTP 127.0.0.1 + Bearer──▶ host
                                             ├── memory (JSON snapshot, revisions, receipts)
                                             ├── documents (LM Studio SDK, in-memory workspaces)
                                             └── memory-channel (named pipe, HMAC)

LM Studio chat
  ├── companion-web (preprocessor) ──▶ Python web-tools ──▶ SearXNG / Chromium
  └── companion-core (prediction loop) ──▶ memory-channel ──▶ host
```

Панель и чат — разные пути. Панель не владеет генерацией. Core не включается автоматически и не должен работать одновременно с другим владельцем ответа.

## Кто чем владеет

| Данные/действие | Владелец | Правило |
|---|---|---|
| Записи памяти | `packages/memory` через `host` | Один писатель; правки по `revision`; квитанции по `operationId` |
| Файлы документов | `packages/host/src/document-workspaces.ts` | Временный набор в памяти; исходные файлы не редактируются |
| Ответ модели | `packages/conversation-engine` или companion-web | Только один владелец в конкретном чате |
| Веб-запросы | `packages/web-tools` | Только публичные HTTP(S); приватные адреса запрещены |
| Настройки Companion | `packages/host/src/settings.ts` | Атомарная запись, только loopback |
| Секреты подключения | `data/host/` | Не коммитить, не логировать, не пересылать |

## Разрешённые импорты

Проверяется `npm run check:boundaries`. Тесты и `*.d.ts` не сканируются.

| Пакет | Может импортировать |
|---|---|
| `core` | только внешние пакеты |
| `memory` | `core` |
| `documents` | `core` |
| `host` | `core`, `memory`, `documents` |
| `control-panel` | `core`; `memory`/`documents` — только `import type` |
| `lmstudio-plugin` | `core`, `memory` |
| `conversation-engine` | `core`, `memory` |

Запрещены, среди прочего:

- `host -> lmstudio-plugin`;
- `conversation-engine -> lmstudio-plugin`;
- `core -> memory/documents/host`;
- runtime-импорт из панели в `memory`/`documents`;
- `control-panel -> host`.

Если нужен новый тип на границе панели и сервера, выносите его в `core` или в нейтральный модуль `memory`/`documents`, а не импортируйте `host` из панели.

## Форматы модулей

- Корень — ESM (`"type": "module"`).
- `packages/lmstudio-plugin` — CJS, потому что его ближайший `package.json` не содержит `"type": "module"`. Не добавляйте туда `"type": "module"` без обновления сборки и `dist/lmstudio-plugin/package.json`.
- `packages/conversation-engine` — CommonJS, отдельный пакет и отдельная лицензия.
- `packages/control-panel` собирается Vite; импорты в исходниках всё равно используют `.js`-расширения по правилам NodeNext.

## Живые данные

Никогда не редактировать и не коммитить:

- `data/`, `backups/`, `releases/`;
- `%USERPROFILE%\.lmstudio\extensions`;
- живую `memory.db` вторым писателем;
- личные чаты, токены, `.env`, сгенерированные настройки.

Для проверок использовать временные каталоги и fixtures. Импорт/миграция памяти — только через владельца хранилища и с резервной копией.

## Куда добавлять функцию

### Новый HTTP-маршрут

1. Схема входа/выхода — в `core` или в модуле домена.
2. Логика — в `host/src/routes/*` или доменном пакете.
3. Проверка — в `tests/foundation` или `tests/<домен>`.
4. Тип для панели — в `core`, не в `host`.

### Новый экран панели

1. Компонент — в `packages/control-panel/src/features/<домен>/`.
2. Запрос — через `src/api.ts`; токен не хранить в коде.
3. Тип ответа — из `core` или type-only из домена.
4. Проверка — unit-тест компонента или E2E `scripts/check-panel.mjs`.

### Новая операция памяти

1. Схема и квитанция — в `memory/src/operations.ts`.
2. Владелец — `memory/src/store.ts`; не писать в файл напрямую.
3. Маршрут — `host/src/routes/memory.ts`.
4. Канал чата — `memory/src/channel-client.ts`.
5. Проверка — `tests/memory`, включая повтор, конфликт, отмену и ошибку диска.

### Новый инструмент Core

1. Схема аргументов — в `conversation-engine/src/companion/`.
2. Разрешение/отмена — через существующий turn lifecycle.
3. Проверка — `packages/conversation-engine/tests/companion/`.
4. Не добавлять второй источник модели и не обходить memory-channel.

## Известные заглушки

`MemoryStore.beginBackgroundUpdate` и `applyBackgroundResult` не используются и не являются готовым API: второй всегда возвращает `CONFIRMATION_REQUIRED`. Не строить на них CORE-3 без отдельной реализации.

## Версии

| Что | Источник |
|---|---|
| Продукт | корневой `package.json` (в панель подставляется при сборке) |
| Core | `packages/conversation-engine/package.json` + `manifest.json` |
| Плагин чата | `packages/lmstudio-plugin/package.json` |

## Проверки

```powershell
npm run verify        # Node, типы, тесты, границы, стиль, сборка
npm run verify:full   # + Python, Ruff, E2E панели
npm run test:core     # 424 Core-теста
npm run check:boundaries
npm run lint
npm run format:check
```
