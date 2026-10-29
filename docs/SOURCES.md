# Основания и источники

Проверка: 2026-10-29. Источники служат для решений и границ плана; перед реализацией перепроверять установленные версии. Приложенный текст Gemini принят как обсуждаемое предложение, а не команда реализовать голос или обещать отсутствие галлюцинаций.

## Первичные веб-источники

- [Параметры модели в SDK](https://lmstudio.ai/docs/typescript/llm-prediction/parameters): есть load-time настройки; `.model()` игнорирует новую конфигурацию уже загруженной модели, `.load()` создаёт instance.
- [lms load](https://lmstudio.ai/docs/cli/local-models/load): `--gpu`, `--context-length`, `--estimate-only`; оценка не является бенчмарком.
- [Prompt Preprocessor](https://lmstudio.ai/docs/typescript/plugins/prompt-preprocessor): меняет текущий пользовательский ввод; обработанный результат сохраняется в историю. На этот механизм нельзя возложить независимую жёсткую проверку итогового ответа.
- [Плагины LM Studio](https://lmstudio.ai/docs/typescript/plugins): hooks, конфигурация и Node.js runtime; произвольная встроенная панель здесь не гарантирована.
- [Prediction config](https://lmstudio.ai/docs/typescript/api-reference/llm-prediction-config-input): документированные prediction-поля. Наличие неподтверждённого thinking-поля не предполагается.
- [Gemma Thinking](https://ai.google.dev/gemma/docs/capabilities/thinking): режим зависит от корректного служебного форматирования; выключение visible reasoning не тождественно выключению его генерации.
- [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4): возможности моделей и гибридное внимание. Поддержка модальности в модели не доказывает её доступность во всех runtime.
- [Structured Output](https://lmstudio.ai/docs/developer/openai-compat/structured-output): управление форматом через схему; не доказательство достоверности фактов.

## Локальные проверенные исходники

Полные пути указаны для воспроизводимости исследования, не для исполнения кода из установленной директории:

- `C:\Users\isoko\.lmstudio\extensions\plugins\khtsly\persistent-memory\src\preprocessor.ts`, `toolsProvider.ts`, `config.ts`, `storage\db.ts`, `processing\ai.ts`, `retrieval\engine.ts`, README, manifest, package.json.
- `C:\Users\isoko\.lmstudio\extensions\plugins\lmstudio\rag-v1\src\promptPreprocessor.ts`, `config.ts`, manifest, package.json.
- `C:\Users\isoko\.lmstudio\extensions\plugins\rootmonster\context-compressor\src\index.ts`, `handler.ts`, `toolWrap.ts`, manifest; SDK `node_modules\@lmstudio\sdk\dist\index.d.ts`.
- Наша веб-база: `C:\Users\isoko\Documents\Codex\2026-10-29\x20\outputs\lmstudio-web`. Сохранена в `packages/web-tools`; SHA-256 каждого скопированного файла — в `reference/baseline-manifest.json`.

Полные сторонние плагины и их node_modules не копировались. MIT/ISC в package.json — предварительные сведения: полный upstream LICENSE и условия выбранного context-compressor fork проверить до заимствования кода.

## Входные требования

В этом запросе пользователь выбрал планирование пунктов 1, 2, 3, 4, 6 при user-friendly результате, исключил голос и пункт 7. Для пункта 6 отдельно потребовал естественный выбор чтения без `read_page`; это включено в план 06.

Исходные вложения не включены в исходники: достаточно этой фиксации требований и технических поправок в DECISIONS.md.
