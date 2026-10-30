# C2: экран управления памятью — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Выполнить только C2; подстановка и сохранение из чата относятся к C3/C4, импорт — C5.

**Goal:** Управлять собственными записями Companion из существующей локальной панели.

**Architecture:** Защищённый management API открывает ровно одного владельца C1 лениво в `settingsDir/memory`; путь не передаётся из HTTP. Закрытие сервера ждёт запросы и владельца памяти. Ошибка памяти не лишает пользователя остальной панели. React показывает обычный текст, редактор, поиск, области и подтверждение удаления; нет генерации модели.

**Tech Stack:** Существующие React/Vite/Zod/Vitest, нативный dialog и download Blob; без новых зависимостей. Применены modern-web-guidance forms/dialog: labels, native validation, role=status/alert, safe initial focus, showModal/Escape, responsive layout.

**Spec:** [подэтапы C](03-memory-stages.md), [план 03](03-memory.md), [хранилище C1](03-memory-c1.md), [DESIGN.md](../DESIGN.md).

## Контракт и ограничения

- `GET /api/memory` → `{records: MemoryRecord[], revision: number}`; список активных записей. Поиск и фильтры локальные, их текст не попадает в URL.
- `POST /api/memory` → OperationResult<MemoryRecord>; body `{content,category,pinned,scope:'global'|'project',projectId}`. identityKey/ID/source/manualPriority определяет владелец/сервер, а не клиент. Имя проекта задаётся вручную, автоматическая связь с чатом отсутствует.
- `PATCH /api/memory/<uuid>` → OperationResult<MemoryRecord>; body `{content,category,pinned,expectedRevision}`. Область не меняется этим методом.
- `DELETE /api/memory/<uuid>` → OperationResult<void>; body `{expectedRevision}`. Сначала подтверждение UI; устаревшая revision даёт HTTP 409.
- `GET /api/memory/export` → snapshot C1 постоянных записей, только с Bearer. Экспорт может содержать личные данные; загрузка начинается явным нажатием. Session отсутствует.
- Все API проходят существующие Host/Origin/token/CSP проверки; JSON body до 64 KiB; неверный body — 400, конфликт — 409, сбой записи — 500, недоступное хранилище — 503.
- UI создаёт global/project; session недоступна до привязки чата C3. Проектная запись пока только запись в панели, не доказательство автоматической изоляции чатов.
- Не редактировать старую memory.db, не перенастраивать плагины, не включать модель. Собственное хранилище доступно без LM Studio.
- Список ограничен первыми 50 совпадениями с «Показать ещё», поиск охватывает загруженные записи. Draft сохраняется при переходе в другие разделы; сбой/конфликт не закрывает редактор и не показывает «Сохранено».

## Task 1: API и жизненный цикл

**Files:** `packages/host/src/routes/memory.ts`, `packages/host/src/server.ts`; `tests/memory/api.test.ts`.

- [x] RED → GREEN: CRUD, неизвестные поля, конфликт двух редакторов, экспорт/restart, отсутствие токена и чужой Origin, отказ записи с сохранением прежнего значения.
- [x] Ленивое открытие и безопасное закрытие одного владельца. Ошибка инициализации памяти не ломает status API.
- [x] Подключить только фиксированный подкаталог собственной памяти; пути, background flags и import не принимаются из запроса.

## Task 2: интерфейс и браузерная проверка

**Files:** `packages/control-panel/src/features/memory/Memory.tsx`, `MemoryEditor.tsx`; `api.ts`, `App.tsx`, `style.css`; `scripts/check-memory-panel.mjs` и актуализация прежнего `check-panel.mjs`.

- [x] RED: браузерный сценарий ожидает доступный экран/добавление, которого ещё нет.
- [x] GREEN: пустой список, добавление, поиск/проектный фильтр, редактор/pinned, native confirm delete, явный экспорт, ошибки/conflict без потери draft.
- [x] Проверить настоящим Edge: сохранение после restart, два окна/409, write failure, cancel delete/Escape, удаление, plain text/XSS, 320 px/200%/keyboard, отсутствие pageerror.
- [x] Исправить утверждение overview/footer «память не меняется»: панель теперь меняет только собственные записи; чат C3 ещё не подключён.

## Task 3: завершение C2

- [x] Полный Vitest, typecheck, build и обе браузерные проверки; значимый release smoke при изменении host lifecycle.
- [x] Одно независимое ревью среза. Исправить существенные замечания с регрессионной проверкой.
- [x] Отчёт/инструкция/статус C2, коммиты и push. Остановиться перед C3.

## Review Focus

Shutdown при записи; сбой инициализации/занятый owner; draft и revision после 409; двойное подтверждение удаления; утечка токена/фактов в URL, HTML или консоль; копирование session в экспорт; несоответствие текущей панели прежнему ZIP.
