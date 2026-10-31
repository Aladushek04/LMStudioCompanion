import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field('memoryEnabled','boolean',{displayName:'Запоминание по просьбе',subtitle:'Общая заметка сохраняется сразу. Служебный разбор текущей моделью и проверка ответа добавляют задержку; обычный ответ показывается после проверки. Только этот чат; карточки — CORE-3.'},false)
  .field('memoryLinkFile','string',{displayName:'Файл подключения памяти',subtitle:'Панель Companion → Память → Включить подключение к чату. Скопируйте путь к файлу, не его содержимое. Панель должна работать.'},'')
  .field(
    "autoCompact",
    "boolean",
    {
      displayName: "Автоматическое сжатие",
      subtitle:
        "Сокращать старые сообщения при заполнении контекста. " +
        "Для дословного разбора больших исходных данных сжатие можно выключить.",
    },
    true,
  )
  .field(
    "thresholdPercent",
    "numeric",
    {
      displayName: "Начинать сжатие при заполнении (%)",
      subtitle: "Доля контекста модели, после которой начинается сжатие истории.",
      min: 10,
      max: 95,
      int: true,
      slider: { step: 5, min: 10, max: 95 },
    },
    75,
  )
  .field(
    "compactFloorPercent",
    "numeric",
    {
      displayName: "Сжимать до заполнения (%)",
      subtitle:
        "Целевое заполнение после сжатия. Запас между порогами оставляет место для продолжения диалога и инструментов.",
      min: 20,
      max: 90,
      int: true,
      slider: { step: 5, min: 20, max: 90 },
    },
    55,
  )
  .field(
    "reservedOutputTokens",
    "numeric",
    {
      displayName: "Резерв токенов для ответа",
      subtitle:
        "Место в контексте, оставляемое для ответа модели.",
      min: 0,
      max: 32000,
      int: true,
    },
    2000,
  )
  .field(
    "thresholdTokensOverride",
    "numeric",
    {
      displayName: "Порог в токенах (0 — использовать %)",
      subtitle:
        "Порог сжатия в токенах вместо процента. Используется для настройки и проверки сжатия.",
      min: 0,
      int: true,
    },
    0,
  )
  .field(
    "keepRecentTokens",
    "numeric",
    {
      displayName: "Сохранять последние сообщения дословно (токенов)",
      subtitle: "Свежая часть беседы, которую сжатие оставляет без пересказа.",
      min: 500,
      max: 50000,
      int: true,
    },
    6000,
  )
  .field(
    "chunkTokens",
    "numeric",
    {
      displayName: "Размер части для сжатия (токенов)",
      subtitle: "История сжимается частями; готовые резюме сохраняются и используются повторно.",
      min: 1000,
      max: 64000,
      int: true,
    },
    16000,
  )
  .field(
    "roundsPerPass",
    "numeric",
    {
      displayName: "Раундов инструментов за проход (0 — без лимита)",
      subtitle:
        "Между проходами Core проверяет размер контекста и при необходимости сжимает историю.",
      min: 0,
      max: 64,
      int: true,
    },
    6,
  )
  .field(
    "maxChunksPerPass",
    "numeric",
    {
      displayName: "Частей сжатия за проход (0 — автоматически)",
      subtitle:
        "Ограничение работы за одно сжатие. В автоматическом режиме — столько, сколько нужно для контекста; /compress обрабатывает всю доступную область.",
      min: 0,
      max: 100,
      int: true,
    },
    0,
  )
  .field(
    "maxToolResultTokens",
    "numeric",
    {
      displayName: "Лимит результата инструмента (токенов, 0 — без лимита)",
      subtitle:
        "Большие результаты сокращаются перед передачей модели. Само действие инструмента выполняется полностью.",
      min: 0,
      int: true,
    },
    4000,
  )
  .field(
    "maxTotalToolResultTokens",
    "numeric",
    {
      displayName: "Общий лимит результатов инструментов (0 — без лимита)",
      subtitle:
        "Общий токенный бюджет результатов всех инструментов за один ход.",
      min: 0,
      int: true,
    },
    20000,
  )
  .field(
    "attachmentMemory",
    "boolean",
    {
      displayName: "Сохранять сведения из вложений при сжатии",
      subtitle:
        "Перед сжатием подготовить краткое содержание вложений и описание изображений для vision-модели. Это кэш контекста, а не постоянная память пользователя.",
    },
    true,
  )
  .field(
    "summaryBudgetTokens",
    "numeric",
    {
      displayName: "Бюджет резюме (токенов, 0 — без лимита)",
      subtitle:
        "При превышении бюджета старые резюме объединяются в более краткое содержание.",
      min: 0,
      max: 64000,
      int: true,
    },
    12000,
  )
  .field(
    "summarizerMaxTokens",
    "numeric",
    {
      displayName: "Максимум токенов на одно резюме",
      min: 200,
      max: 8000,
      int: true,
    },
    1500,
  )
  .field(
    "summarizerPromptMode",
    "select",
    {
      displayName: "Формат резюме",
      options: [
        { value: "auto", displayName: "Автоматически" },
        { value: "full", displayName: "Полный" },
        { value: "compact", displayName: "Краткий" },
      ],
      hint:
        "Автоматически используется полный формат; краткий помогает, если модель расходует бюджет на рассуждения без результата.",
    },
    "auto",
  )
  .field(
    "showStats",
    "boolean",
    {
      displayName: "Показывать результат сжатия в чате",
      subtitle: "Количество токенов до и после сжатия.",
    },
    true,
  )
  .field(
    "meterDisplay",
    "select",
    {
      options: [
        { value: "status", displayName: "Строка состояния" },
        { value: "sender", displayName: "Имя отправителя" },
        { value: "off", displayName: "Выключено" },
      ],
      displayName: "Индикатор контекста",
      subtitle:
        "Показывает размер запроса модели после сжатия. Встроенный круг LM Studio может считать полную видимую переписку.",
    },
    "status",
  )
  .build();
