# Ядро диалога Companion — основа собственной версии

Отдельная копия **rootmonster/context-compressor 0.8.3, Hub revision 27**, автор RootMonsteR. [Оригинальный проект](https://lmstudio.ai/rootmonster/context-compressor). Исходные SHA-256 перечислены в [UPSTREAM.json](UPSTREAM.json), условия — в [LICENSE](LICENSE).

Companion будет бесплатным: решение пользователя от 1 ноября 2026. Community License 1.0 разрешает бесплатное распространение производных версий с сохранением лицензии, авторства и ссылки. Этот код не перелицензируется под корневую MIT-лицензию Companion. Для платного продукта или сервиса требуется отдельная лицензия автора.

## Текущее состояние

Это **основа для доработки**, не готовое объединение памяти, веба и документов. Пакет не включён в обычную сборку панели, не установлен и не заменяет действующий context-compressor. Его собственный ID — `aladushek04/companion-core`. Одновременно с другим владельцем ответа его включать нельзя.

Очередь разработки — [CORE-0–CORE-7](../../docs/plans/07-companion-core-stages.md), граница готового ядра — [требования](../../docs/requirements/companion-core.md). CORE-0 подготовлен; разработка документов возобновится после полной приёмки Core и отдельного поручения.

Изменения относительно исходного снимка:

- собственные package/manifest и отдельные команды проверки/сборки;
- каталог кэша и извлечений вложений `.lm-companion-conversation` вместо `.lm-context-compressor`, без чтения и миграции чужого кэша;
- форматирование чисел в исходном английском `/usage` закреплено за `en-US`: исходные тесты смешивали фиксированные запятые и системную локаль; одно соответствующее ожидание теста также закреплено за `en-US`;
- алгоритмы сжатия сохранены; английские подписи и исходные маркеры пока остаются. Все прочие тесты upstream перенесены без правок.

## Проверка без запуска модели

Из корня репозитория:

```powershell
node node_modules/typescript/bin/tsc -p packages/conversation-engine/tsconfig.json
node node_modules/vitest/vitest.mjs run --config packages/conversation-engine/vitest.config.mts --maxWorkers=1 --no-file-parallelism
node scripts/build-conversation-engine.mjs
```

Последняя команда создаёт локальный кандидат в `.tools/companion-core`. Она не устанавливает и не включает его в LM Studio. Подробности устройства, ограничения и следующие изменения — в [исследовании](../../docs/research/context-compressor-foundation.md).
