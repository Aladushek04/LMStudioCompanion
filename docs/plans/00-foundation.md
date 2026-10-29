# Общая основа и проверка интеграции — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Доказать совместимый способ подключения и создать общую основу с одной понятной панелью.

**Architecture:** Локальный TypeScript-сервис и адаптер LM Studio используют общий набор контрактов. Один обработчик владеет генерацией. Рабочие плагины не патчатся на месте.

**Tech Stack:** TypeScript, SDK установленной версии, Node.js LTS для host, React/Vite для будущей панели, Vitest; версии закрепить после проверки совместимости.

**Spec:** [DESIGN.md](../DESIGN.md).

**Текущее выполнение:** реализованы read-only срез задачи 1 и локальная панель задачи 2; [отчёт возможностей](../research/capability-report.md), [проверки панели](../research/panel-progress.md). Выбор tools-only не устанавливает новый обработчик. Реальная интеграция с генерацией остаётся unknown; комплект установки/отката задачи 3 ещё не реализован.

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

- [ ] Тесты `preservesOtherMcpServers`, `handlesCyrillicProjectPath`, `uninstallKeepsPersonalData`: `expect(nextConfig.mcpServers.other).toEqual(previous.mcpServers.other)`; rollback восстанавливает только собственные изменения; data-dir не удаляется.
- [ ] Запустить `npm exec vitest -- run tests/foundation/install.test.ts`; получить падение.
- [ ] Реализовать preview изменений, backup и merge своей MCP-записи; массив аргументов без сборки shell-строки. Start не запускает установку заново. Конфликтующий native handler переключается явно, с сохранением прежнего выбора. Удаление приложения сохраняет память и документы.
- [ ] Повторить тесты и выполнить установку/откат в отдельном тестовом профиле. Проверить запуск из пути с пробелами и кириллицей, отсутствие зависимости от текущей папки, понятный сбой при отсутствии Docker. Затем пройти общую приёмку.
- [ ] Проверить diff и сохранить commit с пользовательской инструкцией.

**Передача дальше:** другие планы используют CapabilityReport, TurnContext, OperationResult, SourceRecord, TurnBudget и UiNotice; им запрещено придумывать новый независимый управляющий процесс генерации.
