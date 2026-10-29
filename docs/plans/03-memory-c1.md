# C1: надёжное хранилище памяти — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Выполнить только C1; не подключать панель, чат, старый плагин или личную БД.

**Goal:** Проверяемые CRUD, единственный писатель, восстановление после аварийного завершения и защита ручной правки на синтетических данных.

**Architecture:** Независимый snapshot JSON v1 в отдельном локальном каталоге; Zod-валидация и SHA-256 для обнаружения повреждений. Сначала временный файл с fsync, затем atomic rename как точка фиксации; RAM обновляется после успешного rename. Очередь сериализует операции. На Windows процесс удерживает отдельный named pipe по canonical data-dir, который ОС освобождает при аварии. На других ОС используется консервативный exclusive lock-файл без автоматического удаления после аварии.

**Tech Stack:** Существующие Node fs/net/crypto, TypeScript, Zod, Vitest; без новой зависимости, sql.js и копирования upstream-кода.

**Spec:** [подэтапы C](03-memory-stages.md), [исходный план](03-memory.md), [C0](../research/memory-compatibility.md), [DESIGN.md](../DESIGN.md).

## Global Constraints

- Только явно переданный отдельный абсолютный локальный каталог; не угадывать путь старого хранилища.
- Снимок — `memory.json`; format `companion-memory-v1`, storeId UUID, revision, records и checksum. Неизвестная/повреждённая структура останавливает открытие; старый backup автоматически не восстанавливается, чтобы не вернуть удалённый факт.
- До 10 000 записей, файл до 8 MiB, content до 16 000 символов, identityKey до 128 символов. Пределы — технические ограничения C1, не размер контекста модели.
- `identityKey` задаёт тему/факт внутри `(scope, projectId, sessionId)` и не меняется при редактировании. Поиск смысловых дублей не входит в C1; автоматический путь вообще не имеет права создавать записи.
- Ручные операции требуют ожидаемую revision. Новые записи имеют manualPriority=true; поздние фоновые результаты не записываются без подтверждения. Для забытых фактов сохраняется пустая tombstone с ID/ключом/revision; содержимое, теги и дополнительные данные очищаются.
- Session-записи и фоновые токены живут только в RAM. Backup содержит только постоянные записи; восстановление инвалидирует прежние фоновые токены.
- Снимок атомарен на поддерживаемой локальной ФС. Нельзя обещать сохранность при физическом отказе носителя или отключении питания по результатам process-kill теста.

## Контракт C1

`MemoryRecord`: прежние id/content/category/scope/projectId/sessionId/source/createdAt/updatedAt плюс identityKey, revision, pinned, manualPriority, deletedAt; tags, confidence, lastAccessedAt, accessCount, supersedes и JSON `metadata` сохраняют совместимые дополнительные данные.

`openMemoryStore(directory, options?) → Promise<MemoryStore>`; ошибка открытия — исключение с понятной причиной. `options.beforeCommit` — внедрение сбоя/паузы только для проверок, не пользовательская настройка.

Методы владельца:

- `saveMemory(input) → Promise<OperationResult<MemoryRecord>>`: только явное создание; повтор устойчивого ключа — CONFLICT.
- `listMemories(filter?) → Promise<MemoryRecord[]>`, `getMemory(id) → Promise<MemoryRecord|null>`: независимые копии активных записей; нет изменения access counters при чтении.
- `updateMemory(id, patch, expectedRevision)`, `deleteMemory(id, expectedRevision)`, `reviveMemory(id, content, expectedRevision)`: условная ручная запись. Возврат забытого факта — отдельное явное действие revive, не автоматический save.
- `beginBackgroundUpdate(id) → OperationResult<{token}>`, `applyBackgroundResult(token, content) → OperationResult<MemoryRecord>`: одноразовый token принадлежит владельцу и захватывает ID/revision. Результат — устаревший конфликт либо CONFIRMATION_REQUIRED; сам по себе не меняет управляемый факт.
- `exportBackup() → Promise<string>`: проверяемый snapshot только постоянных записей.
- `restoreBackup(serialized, expectedRevision) → OperationResult<void>`: явное восстановление backup того же storeId; сначала собственная копия текущего snapshot `before-restore-UUID.json`. Revision не откатывается; старые токены инвалидируются, session очищается.
- `getRevision()`, `close()`: revision постоянного snapshot; close ждёт очередь и освобождает владельца, последующие mutations дают CLOSED.

## Task 1: тесты и хранение

**Files:** `packages/memory/src/types.ts`, `ownership.ts`, `local-directory.ts`, `persistence.ts`, `store.ts`; `tests/memory/store.test.ts`; регистрация в tsconfig/build/Vitest.

- [x] RED: CRUD/restart и отдельное состояние session; ожидается отсутствие модуля.
- [x] GREEN: строгие типы, сериализация, атомарная фиксация, копии результатов, single writer, revision/conflict.
- [x] RED → GREEN: stale edit, late background, забытый устойчивый ключ, explicit revive, сохранение приоритета после restart.
- [x] RED → GREEN: отказ до rename оставляет старые RAM/диск; повреждение не сбрасывает данные; backup/restore сохраняет metadata и инвалидирует токены.
- [x] Проверить отдельным дочерним процессом: kill до commit оставляет прежний snapshot; kill после успеха оставляет новый; Windows lease освобождается без удаления PID-файла.

## Task 2: итоговая проверка и отчёт

- [x] Полный Vitest, typecheck и build. Модели/API LM Studio не нужны.
- [x] Независимое ревью всего среза C1; исправить существенные замечания с регрессионной проверкой.
- [x] Записать конкретные результаты, обновить контракт плана 03 и статус C1. Commit/push и остановка перед C2.

## Review Focus

Потеря данных при ошибке rename/записи; два владельца одного canonical каталога; повтор старого варианта через новый ID; сброс manualPriority при restore/restart; попадание session в файл/backup; небезопасное автоматическое восстановление старой копии; ссылка вместо файла; работа очереди после close.
