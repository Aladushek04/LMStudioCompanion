import { createConfigSchematics } from '@lmstudio/sdk';
declare const COMPANION_LOCAL_DEFAULTS: {python:string;root:string;browser:string}|undefined;
const defaults=typeof COMPANION_LOCAL_DEFAULTS==='undefined'?{python:'',root:'',browser:''}:COMPANION_LOCAL_DEFAULTS;
export const configSchematics = createConfigSchematics()
  .field('memoryCapture','select',{displayName:'Изменения памяти из чата',options:[{value:'off',displayName:'Выключены'},{value:'explicit',displayName:'Только явные команды'},{value:'suggest',displayName:'Команды и предложения'}],hint:'Ничего не сохраняется автоматически: подтвердите предложение в панели «Память». Цитаты и веб-материалы не извлекаются. Дополнительной генерации нет.'},'off')
  .field('useMemory','boolean',{displayName:'Использовать общую память Companion',hint:'Получает записи у запущенной панели. Проектная и временная память пока недоступны: нет подтверждённого ID чата. Автоматического сохранения нет.'},false)
  .field('webMode','select',{displayName:'Интернет Companion',options:[{value:'off',displayName:'Интернет выключен'},{value:'auto',displayName:'Авто'},{value:'research',displayName:'Исследование'}],hint:'Управляет автоматическим чтением Companion. Отдельно включённые сторонние веб-инструменты сохраняют собственные настройки.'},'off')
  .field('showSources','boolean',{displayName:'Показывать источники',hint:'Статус в чате. Тексты источников всё равно занимают контекст для ответа.'},true)
  .build();
export const globalConfigSchematics = createConfigSchematics()
  .field('memoryLinkFile','string',{displayName:'Файл подключения памяти',subtitle:'В панели: Память → Включить подключение к чату. Скопируйте показанный путь; содержимое файла копировать не нужно.'},'')
  .field('python','string',{displayName:'Python веб-обработки',subtitle:'Полный путь к python.exe подготовленного окружения Companion.'},defaults.python)
  .field('webRoot','string',{displayName:'Папка веб-обработки',subtitle:'Полный путь к packages/web-tools.'},defaults.root)
  .field('searchUrl','string',{displayName:'Сервер поиска SearXNG'},'http://127.0.0.1:8088')
  .field('browser','string',{displayName:'Chromium или Edge',subtitle:'Полный путь к браузеру; пусто — установленный Playwright Chromium.'},defaults.browser)
  .build();
