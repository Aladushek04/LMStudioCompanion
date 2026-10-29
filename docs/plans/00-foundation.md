# Общая основа и проверка интеграции — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Доказать совместимый способ подключения и создать общую основу с одной понятной панелью.

**Architecture:** Локальный TypeScript-сервис и адаптер LM Studio используют общий набор контрактов. Один обработчик владеет генерацией. Рабочие плагины не патчатся на месте.

**Tech Stack:** TypeScript, SDK установленной версии, Node.js LTS для host, React/Vite для будущей панели, Vitest; версии закрепить после проверки совместимости.

**Spec:** [DESIGN.md](../DESIGN.md).

**Текущее выполнение:** этап 00 завершён в разрешённом режиме tools-only: диагностика, локальная панель и автономный Windows-комплект установки/отката. [Итоговые проверки](../research/stage00-completion.md), [отчёт возможностей](../research/capability-report.md). Новый обработчик не устанавливается; расширенное управление генерацией остаётся unknown и заблокировано. Индикация Companion использует предусмотренный ТЗ запасной вариант — локальную панель; [исследование](../research/chat-visualization.md).

## Global Constraints

Все 10 ограничений раздела «Общие ограничения» DESIGN.md обязательны. Это будущие задачи; команды ниже сейчас не выполнялись. Общение остаётся в LM Studio; Windows; русский интерфейс; один владелец генерации; без голоса и пункта 7.

## Review Focus

- LM Studio выключена: полезное сообщение и повтор подключения без потери настроек — задача 1.
- Два обработчика генерации: отказ включать конфликтующий режим — задача 1.
- Посторонний Origin/Host и запрос без токена: management API отклоняет действие — задача 2.
- Путь Windows с пробелами и кириллицей: установка и запуск без shell-интерполяции — задача 3.
- Изменение чужих MCP-настроек: installer сохраняет их и умеет откатить свою запись — задача 3.

## Task 1: Отчёт capabilities и выбор владельца ответа

**Files:** созданы `packages/core/src/contracts.ts`, `packages/host/src/capabilities.ts`, `installation.ts`, `diagnose.ts`, `packages/lmstudio-plugin/src/integration.ts`, `tests/foundation/{contracts,capabilities,installation,diagnose}.test.ts`, `docs/research/capability-report.md`, корневые `package.json`, lockfile и конфигурации TypeScript/Vitest. Diagnose-Companion.cmd — запуск текущей собранной диагностики, не установщик задачи 3.

**Interfaces:** контракты из DESIGN.md; `probeCapabilities(signal: AbortSignal): Promise<CapabilityReport>`; `selectIntegration(report: CapabilityReport, currentHandler: string|null): OperationResult<'extend'|'replace'|'tools-only'>`. `extend` означает доказанную точку расширения, а не вызов неподтверждённого SDK API.

- [x] Написаны fixture-тесты для недоступного API, конфликта владельцев, непроверенного Thinking, сохранности scoped IDs и отмены. Probe не делает загрузку или генерацию.
- [x] До реализации получено ожидаемое падение Vitest из-за отсутствующих модулей. Для исправления замечаний ревью также воспроизведены отдельные падающие тесты.
- [x] Созданы корневой TS-проект, схемы контрактов и read-only probe. Версии и декларации исследованы; активный обработчик конкретного чата, tools session, runtime-отмена, встроенная панель, стабильный ID чата и постоянные FileHandle остаются unknown. Thinking вынесен в план 02; raw не используется.
- [x] Тесты повторены; версии, GET-запросы и ограничения записаны в capability-report и журнал. Live-генерация не выполнялась, интеграция не объявляется проверенной.
- [x] Изменённый объём проверен независимым reviewer и контрольными суммами исходников. Git отсутствует, поэтому commit неприменим; исходный манифест сохраняется отдельно.

**Результат:** выбран ровно один путь генерации и определены реально доступные функции. Если ни расширение, ни безопасная замена не доказаны, доступен tools-only, а функции контроля ответа заблокированы с объяснением.

## Task 2: Локальный сервис и панель состояния

**Files:** создать `packages/host/src/server.ts`, `packages/host/src/settings.ts`, `packages/control-panel/src/App.tsx`, `packages/control-panel/src/api.ts`, `tests/foundation/management.test.ts`.

**Interfaces:** `startManagementServer(settingsDir: string, signal: AbortSignal): Promise<{origin: string; token: string; close(): Promise<void>}>`; `readSettings(): Promise<Settings>` и `writeSettings(next: Settings): Promise<void>` из settings.ts. `Settings = {version: 1; defaultProjectId: string|null; mode: 'fast'|'auto'|'deep'; webMode: 'off'|'auto'|'research'; memoryMode: 'explicit'|'suggest'; activeProfileId: string|null}`. defaultProjectId действует только на новые чаты; текущая привязка хранится отдельно в `packages/host/src/chat-scopes.ts`. Контракт `bindChatScope(chatScopeId: string, projectId: string|null): OperationResult<{projectId: string|null; sessionId: string}>` запрещает сменить проект уже привязанного чата; sessionId живёт только до завершения host.

- [x] Добавлены проверки чужого Origin/Host, токена, settings restart, отмены, размера/формата запроса и запрета перепривязки RAM-области чата. Привязка к настоящим чатам отключена до verified стабильного ID; постоянная привязка проектов остаётся условием перед включением проектной памяти.
- [x] До реализации management.test.ts упал из-за отсутствия server.ts.
- [x] Реализованы loopback binding, Host/Origin/token, единственный владелец settings-dir и атомарное сохранение собственных предпочтений. Панель запускается через Start-Companion.cmd; неподдержанные модули недоступны с объяснением. Предпочтения не применяются к LM Studio.
- [x] Проверены подключение/отсутствие подключения, отмена, недоступные разделы, клавиатура, 320 px и 200% текста в отдельном браузере. Выполнен read-only прогон панели с настоящим API. Отмена записи сохраняет прежние настройки до начала атомарного rename; начатая фиксация завершается.
- [x] Проверенные срезы сохранены отдельными коммитами; выполнено независимое ревью и исправления замечаний.

## Task 3: Комплект запуска, диагностика и откат

**Files:** создать `scripts/Start.cmd`, `scripts/Start.ps1`, `scripts/Install.ps1`, `scripts/Uninstall.ps1`, `tests/foundation/install.test.ts`, `docs/USER-GUIDE.md`.

**Interfaces:** `planInstall(existingConfig: unknown, projectDir: string): OperationResult<{nextConfig: unknown; changedKeys: string[]}>`; `restoreInstall(backupPath: string): Promise<OperationResult<void>>` в `packages/host/src/install.ts`. Не считать npm установленным на машине конечного пользователя: способ поставки host-runtime закрепить в capability-report; разрешён bundled runtime с лицензией либо проверенная LM Studio Node-среда.

- [x] Тесты сохраняют чужие MCP-записи, данные и изменённые ярлыки; проверяют кириллицу/пробелы, откат, устаревшую копию, повреждённый комплект, отмену и блокировки. Ошибки копирования и junction дополнительно проверены после ревью.
- [x] До реализации install.test.ts получено падение из-за отсутствующего install.ts.
- [x] Реализованы preview, backup и откат собственных версий. Уточнение плана: у локальной панели нет MCP-сервера, поэтому MCP-конфиг сохраняется без регистрации; handler не переключается. Start не запускает установку заново. Архив содержит проверенный Node и лицензии, не требует npm.
- [x] Выполнен установочный цикл в отдельном тестовом профиле Windows/PS5.1 из другого cwd, без Node/npm в PATH и без Docker. Панель не зависит от Docker; диагностика показывает недоступность API. Отсутствие Docker для будущего веба проверяется в плане 06. Приёмка будущих модулей не объявляется пройденной.
- [x] Выполнены независимое ревью и исправления, проверены diff и пользовательская инструкция. Реализация сохранена отдельным коммитом 49c54fc; итоговые документы и контрольные суммы фиксируются следующим коммитом.

**Передача дальше:** другие планы используют CapabilityReport, TurnContext, OperationResult, SourceRecord, TurnBudget и UiNotice; им запрещено придумывать новый независимый управляющий процесс генерации.

## Дополнительное требование: визуализация в чате

[ТЗ пользователя](../requirements/chat-visualization.md) допускает локальную панель при отсутствии совместимого канала. Исследование завершено этим запасным вариантом; реализация собственной чат-индикации и её измерения остаются будущей функцией. Наличие методов не означает доступность из tools-only.

- [x] Исследованы контроллеры SDK и собственные настройки компрессора; без второго владельца генерации глобальная полоса не подтверждена. Состояние оставлено в локальной панели.
- [x] Решение по переключателю: сейчас функция недоступна, контракт настроек не расширяется ради неработающей кнопки. Кандидат ToolCallContext.status и условия будущего расширения переданы плану 06.
- [x] Зафиксирована граница приёмки: вкл/выкл, tool-turn, сжатие и токены собственной чат-индикации не измерялись; стоимость unknown. Функция не включена, нулевой расход не заявляется. Реализационные проверки остаются в ТЗ перед её будущим включением.
